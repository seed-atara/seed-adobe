import { describe, expect, it } from "vitest";
import { decodePng } from "@seed-ae/media";
import {
  MockImageProvider,
  MockVideoProvider,
  ProviderRegistry,
  SeedanceProvider,
  SeedreamProvider,
  seedanceDisplayName,
  seedanceProviderId,
  seedanceSizesFor,
} from "../src/index.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  model: "mock-image-v1",
  prompt: "a lighthouse at dusk",
  correlationId: "cor_1",
  ...overrides,
});

describe("MockImageProvider", () => {
  it("declares only capabilities it actually has", async () => {
    const caps = await new MockImageProvider().capabilities();
    expect(caps.textToImage).toBe(true);
    expect(caps.textToVideo).toBe(false);
    expect(caps.operations).toEqual(["image.generate", "image.edit"]);
  });

  it("produces a decodable image at the requested size", async () => {
    const provider = new MockImageProvider();
    const job = await provider.generateImage(request({ size: "320x180" }) as never);
    const state = await provider.getJob(job.providerJobId);

    expect(state.status).toBe("succeeded");
    const output = state.outputs?.[0];
    expect(output?.mimeType).toBe("image/png");
    const decoded = decodePng(Buffer.from(output?.base64 ?? "", "base64"));
    expect(decoded).toMatchObject({ width: 320, height: 180 });
  });

  it("is deterministic for one recipe and different across seeds", async () => {
    const provider = new MockImageProvider();
    const render = async (seed: number) => {
      const job = await provider.generateImage(
        request({ size: "64x64", seed }) as never,
      );
      return (await provider.getJob(job.providerJobId)).outputs?.[0]?.base64;
    };
    expect(await render(1)).toBe(await render(1));
    expect(await render(1)).not.toBe(await render(2));
  });

  it("reports running until its latency has elapsed", async () => {
    let now = 0;
    const provider = new MockImageProvider({ latencyMs: 100, now: () => now });
    const job = await provider.generateImage(request() as never);
    expect((await provider.getJob(job.providerJobId)).status).toBe("running");
    now = 150;
    expect((await provider.getJob(job.providerJobId)).status).toBe("succeeded");
  });

  it("surfaces failures and cancellation", async () => {
    const provider = new MockImageProvider({ failOnPromptContaining: "explode" });
    const failing = await provider.generateImage(
      request({ prompt: "please explode" }) as never,
    );
    expect(failing.state.status).toBe("failed");

    const ok = await provider.generateImage(request() as never);
    await provider.cancelJob(ok.providerJobId);
    expect((await provider.getJob(ok.providerJobId)).status).toBe("cancelled");
  });

  it("rejects an unknown model and an unparseable size", async () => {
    const provider = new MockImageProvider();
    await expect(
      provider.generateImage(request({ model: "nope" }) as never),
    ).rejects.toThrow(/unknown model/);

    const job = await provider.generateImage(request({ size: "huge" }) as never);
    await expect(provider.getJob(job.providerJobId)).rejects.toThrow(/unsupported size/);
  });
});

describe("SeedreamProvider", () => {
  const MODEL = "seedream-4-0-250828";

  const provider = (overrides: Record<string, unknown> = {}) =>
    new SeedreamProvider({
      baseUrl: "https://ark.ap-southeast.bytepluses.com/api/v3",
      apiKey: "ark-key",
      model: MODEL,
      referencePolicy: "inline",
      ...overrides,
    } as never);

  it("refuses an AK/SK pair, explaining it is the wrong credential type", () => {
    expect(
      () => new SeedreamProvider({ baseUrl: "https://x", apiKey: "", model: MODEL }),
    ).toThrow(/signs the asset library OpenAPI/);
  });

  it("advertises seed support, which the API accepts", async () => {
    const caps = await provider().capabilities();
    expect(caps.seed).toBe(true);
    expect(caps.maxImageReferences).toBe(14);
    expect(caps.async).toBe(false);
    expect(caps.models).toEqual([MODEL]);
  });

  it("posts the verified field set and never leaks the key into rawRequest", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const seedream = provider({
      apiKey: "super-secret",
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url: String(url), init };
        return new Response(
          JSON.stringify({ data: [{ url: "https://cdn.example/out.png" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const job = await seedream.generateImage({
      model: MODEL,
      prompt: "Image 1 is the reference. Relight as evening interior.",
      size: "2K",
      seed: 1234,
      correlationId: "cor_1",
      references: [
        { kind: "dataUrl", value: "data:image/png;base64,AA", mimeType: "image/png" },
      ],
    });

    expect(captured?.url).toBe(
      "https://ark.ap-southeast.bytepluses.com/api/v3/images/generations",
    );
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({
      model: MODEL,
      size: "2K",
      seed: 1234,
      response_format: "url",
      watermark: false,
      sequential_image_generation: "disabled",
      image: "data:image/png;base64,AA",
    });
    expect(JSON.stringify(job.rawRequest)).not.toContain("super-secret");
    expect(job.state.status).toBe("succeeded");
    expect(job.state.outputs?.[0]?.url).toBe("https://cdn.example/out.png");
  });

  it("sends multiple references as an array", async () => {
    let body: Record<string, unknown> | undefined;
    const seedream = provider({
      fetchImpl: (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    await seedream.generateImage({
      model: MODEL,
      prompt: "combine these",
      correlationId: "cor_2",
      references: [
        { kind: "base64", value: "AA", mimeType: "image/png" },
        { kind: "url", value: "https://cdn.example/ref.png", mimeType: "image/png" },
      ],
    });
    expect(body?.image).toEqual([
      "data:image/png;base64,AA",
      "https://cdn.example/ref.png",
    ]);
  });

  it("rejects a size the model cannot produce before spending a call", async () => {
    let called = false;
    const seedream = provider({
      model: "seedream-5-0-260128",
      fetchImpl: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await expect(
      seedream.generateImage({
        model: "seedream-5-0-260128",
        prompt: "x",
        size: "1024x1024",
        correlationId: "cor_3",
      }),
    ).rejects.toThrow(/at least 3,686,400 pixels/);
    expect(called).toBe(false);
  });

  it("rejects more than fourteen references", async () => {
    const references = Array.from({ length: 15 }, () => ({
      kind: "base64" as const,
      value: "AA",
      mimeType: "image/png",
    }));
    await expect(
      provider().generateImage({
        model: MODEL,
        prompt: "x",
        correlationId: "cor_4",
        references,
      }),
    ).rejects.toThrow(/at most 14 reference images/);
  });

  it("fails loudly but keeps the raw payload when the response is unrecognisable", async () => {
    const seedream = provider({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as
        unknown as typeof fetch,
    });
    const job = await seedream.generateImage({
      model: MODEL,
      prompt: "x",
      correlationId: "cor_5",
    });
    expect(job.state.status).toBe("failed");
    expect(job.state.raw).toEqual({ unexpected: true });
  });

  it("maps an HTTP error onto a failed job and surfaces the API message", async () => {
    const seedream = provider({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
          status: 429,
        })) as unknown as typeof fetch,
    });
    const job = await seedream.generateImage({
      model: MODEL,
      prompt: "x",
      correlationId: "cor_6",
    });
    expect(job.state.status).toBe("failed");
    expect(job.state.error?.message).toContain("429");
    expect(job.state.error?.message).toContain("quota exceeded");
  });

  it("explains a 404 as a withdrawn model or wrong base URL", async () => {
    const seedream = provider({
      fetchImpl: (async () => new Response("{}", { status: 404 })) as
        unknown as typeof fetch,
    });
    const job = await seedream.generateImage({
      model: MODEL,
      prompt: "x",
      correlationId: "cor_7",
    });
    expect(job.state.error?.message).toMatch(/withdrawn or the base URL is wrong/);
  });

  describe("reference policy", () => {
    const failingPublisher = {
      publish: async () => {
        throw new Error("bucket unreachable");
      },
    };

    it("hosted policy refuses to fall back to posting raw pixels", async () => {
      const seedream = provider({
        referencePolicy: "hosted",
        publisher: failingPublisher,
      });
      await expect(
        seedream.generateImage({
          model: MODEL,
          prompt: "x",
          correlationId: "cor_8",
          references: [{ kind: "base64", value: "AA", mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/bucket unreachable/);
    });

    it("hosted-or-inline degrades to a data URL", async () => {
      let body: Record<string, unknown> | undefined;
      const seedream = provider({
        referencePolicy: "hosted-or-inline",
        publisher: failingPublisher,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      });

      await seedream.generateImage({
        model: MODEL,
        prompt: "x",
        correlationId: "cor_9",
        references: [{ kind: "base64", value: "AA", mimeType: "image/png" }],
      });
      expect(body?.image).toBe("data:image/png;base64,AA");
    });

    /*
     * An https URL is one of exactly two forms the `image` field accepts, and
     * the asset id ADR 0005 was built on is not the other one: images/generations
     * answers "invalid url specified" to `asset://<id>` and to a bare id alike.
     * Verified against the live endpoint, 2026-08-13.
     */
    it("sends a hosted reference as the URL it was published at", async () => {
      let body: Record<string, unknown> | undefined;
      const seedream = provider({
        referencePolicy: "hosted",
        publisher: {
          publish: async () => ({ url: "https://bucket.example/ref.png?signed" }),
        },
        fetchImpl: (async (_url: string, init: RequestInit) => {
          body = JSON.parse(String(init.body));
          return new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), {
            status: 200,
          });
        }) as unknown as typeof fetch,
      });

      await seedream.generateImage({
        model: MODEL,
        prompt: "Image 1 is the reference.",
        correlationId: "cor_10",
        references: [{ kind: "base64", value: "AA", mimeType: "image/png" }],
      });
      expect(body?.image).toBe("https://bucket.example/ref.png?signed");
    });
  });
});

describe("SeedanceProvider", () => {
  const MODEL = "dreamina-seedance-2-5-260628";

  function provider(
    handler: (url: string, init: RequestInit) => Response,
    extra: Partial<ConstructorParameters<typeof SeedanceProvider>[0]> = {},
  ) {
    return new SeedanceProvider({
      baseUrl: "https://ark.example/api/v3",
      apiKey: "ark-key",
      model: MODEL,
      fetchImpl: (async (url: string, init: RequestInit) =>
        handler(String(url), init)) as unknown as typeof fetch,
      ...extra,
    });
  }

  const created = (id: string) =>
    new Response(JSON.stringify({ id }), { status: 200 });

  it("refuses to construct without an Ark API key or a model", () => {
    expect(
      () => new SeedanceProvider({ baseUrl: "x", apiKey: "", model: MODEL }),
    ).toThrow(/Ark API key/);
    expect(
      () => new SeedanceProvider({ baseUrl: "x", apiKey: "k", model: "" }),
    ).toThrow(/configured model id/);
  });

  it("declares video capabilities and asynchronous delivery", async () => {
    const caps = await provider(() => created("t")).capabilities();
    expect(caps.operations).toEqual(["video.generate"]);
    expect(caps.textToVideo).toBe(true);
    expect(caps.imageToVideo).toBe(true);
    expect(caps.async).toBe(true);
    expect(caps.seed).toBe(true);
  });

  it("posts a text part for text-to-video", async () => {
    let body: Record<string, unknown> | undefined;
    const job = await provider((url, init) => {
      expect(url).toBe("https://ark.example/api/v3/contents/generations/tasks");
      body = JSON.parse(String(init.body));
      return created("cgt-1");
    }).generateVideo({
      model: MODEL,
      prompt: "a lighthouse at dusk",
      seed: 42,
      durationSeconds: 5,
      aspectRatio: "16:9",
      parameters: { size: "720p" },
      correlationId: "cor_1",
    });

    expect(body).toMatchObject({
      model: MODEL,
      content: [{ type: "text", text: "a lighthouse at dusk" }],
      seed: 42,
      duration: 5,
      ratio: "16:9",
      resolution: "720p",
      /*
       * Quality defaults, both measured. `bitrate_mode: high` is CRF 11
       * against 18. `output_format: mov` is 4:4:4 where mp4 is 4:2:0, at the
       * same resolution and the same price — verified 2026-08-18 by generating
       * and ffprobing, because this field is acted on at execution and is
       * invisible to the request validator.
       */
      bitrate_mode: "high",
      return_last_frame: true,
      output_format: "mov",
    });
    expect(job.providerJobId).toBe("cgt-1");
    expect(job.state.status).toBe("queued");
  });

  it("names a lone image as the first frame, so the plate animates from itself", async () => {
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-2");
    }).generateVideo({
      model: MODEL,
      prompt: "push in slowly",
      correlationId: "cor_2",
      firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
    });

    expect(body.content).toEqual([
      { type: "text", text: "push in slowly" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA" },
        role: "first_frame",
      },
    ]);
  });

  it("registers an image reference and sends it as an asset id", async () => {
    /*
     * The sanctioned route. Ark refuses an inline or hosted image that "may
     * contain real person" — which is any convincing face, invented or not —
     * and an asset:// id registered under the account's signed authorisation
     * is the accepted form for video.
     *
     * Every image part goes through it: first frame, last frame and each
     * reference. A route that covers only some of them fails on the request
     * that happens to use the others.
     */
    const registered: string[] = [];
    const library = {
      ensureAsset: async (input: { bytes: Buffer }) => {
        registered.push(String(input.bytes.length));
        return { assetId: "abc123", cached: false };
      },
    } as never;

    let body: any;
    const still = { kind: "base64" as const, value: "AAAA", mimeType: "image/png" };
    await provider(
      (_url, init) => {
        body = JSON.parse(String(init.body));
        return created("cgt-asset");
      },
      { assetLibrary: library },
    ).generateVideo({
      model: MODEL,
      prompt: "a slow push in",
      correlationId: "cor_asset",
      firstFrame: still,
      lastFrame: still,
    });

    const images = body.content.filter((part: any) => part.type === "image_url");
    expect(images).toHaveLength(2);
    for (const image of images) {
      expect(image.image_url.url).toBe("asset://abc123");
    }
    expect(registered.length).toBeGreaterThan(0);
  });

  it("registers a reference clip and sends it as an asset id too", async () => {
    /*
     * The same filter catches video — "the input video 'content[1]' may
     * contain real person" — and for a long time only images took the
     * sanctioned route, because toAssetUrl guarded on image/. Every motion
     * reference travelled as a bare link and met the refusal the asset
     * library exists to prevent.
     */
    const registered: Array<{ mimeType: string; filename: string }> = [];
    const library = {
      ensureAsset: async (input: { mimeType: string; filename: string }) => {
        registered.push({ mimeType: input.mimeType, filename: input.filename });
        return { assetId: "vid789", cached: false };
      },
    } as never;

    let body: any;
    await provider(
      (_url, init) => {
        body = JSON.parse(String(init.body));
        return created("cgt-video-asset");
      },
      { assetLibrary: library },
    ).generateVideo({
      model: MODEL,
      prompt: "the same move, but at dusk",
      correlationId: "cor_video_asset",
      references: [
        { kind: "base64", value: "AAAA", mimeType: "video/mp4" },
        { kind: "base64", value: "BBBB", mimeType: "image/png" },
      ],
    });

    const clip = body.content.find((part: any) => part.type === "video_url");
    expect(clip.video_url.url).toBe("asset://vid789");
    expect(clip.role).toBe("reference_video");

    // The still alongside it keeps taking the route it always did.
    const image = body.content.find((part: any) => part.type === "image_url");
    expect(image.image_url.url).toBe("asset://vid789");

    // Named as what it is: the publisher builds the object key from this, and
    // an mp4 offered as a PNG is a fetch Ark can reasonably refuse.
    const video = registered.find((entry) => entry.mimeType === "video/mp4");
    expect(video?.filename.endsWith(".mp4")).toBe(true);
  });

  it("falls back to the inline form when there is no asset library", async () => {
    // Better a reference Ark may refuse, with a message that names itself,
    // than no reference at all.
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-noasset");
    }).generateVideo({
      model: MODEL,
      prompt: "a slow push in",
      correlationId: "cor_noasset",
      firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
    });
    const image = body.content.find((part: any) => part.type === "image_url");
    expect(image.image_url.url).toBe("data:image/png;base64,AA");
  });

  it("sends the resolution the artist chose", async () => {
    /*
     * This went unnoticed for the life of the feature: VideoGenerationRequest
     * had no `size`, so the adapter read `parameters.size` and found nothing
     * every time. Every clip came back at the provider default, and on this
     * API resolution decides the codec, the bit depth and whether the colour
     * is tagged — so a silently ignored 1080p was an 8-bit untagged 720p.
     */
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-res");
    }).generateVideo({
      model: MODEL,
      prompt: "a slow push in",
      correlationId: "cor_res",
      size: "1080p",
    });

    expect(body.resolution).toBe("1080p");
  });

  it("sends one still as both the first and the last frame, for a seamless loop", async () => {
    /*
     * The cycle a motion graphic wants: the shot ends exactly where it began.
     * Ark treats this as a mode of its own — it reported `flf2v` when probed on
     * 2026-08-17 — and accepts the same image twice, while refusing two
     * *first* frames by count. That is what makes it a role rather than the
     * artist adding one reference to the list twice.
     */
    let body: any;
    const still = { kind: "base64" as const, value: "AA", mimeType: "image/png" };
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-loop");
    }).generateVideo({
      model: MODEL,
      prompt: "a slow rotation",
      correlationId: "cor_loop",
      firstFrame: still,
      lastFrame: still,
    });

    expect(body.content).toEqual([
      { type: "text", text: "a slow rotation" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA" },
        role: "first_frame",
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA" },
        role: "last_frame",
      },
    ]);
  });

  it("sends several images as references, which is what makes it r2v", async () => {
    // Beyond one image the API refuses a roleless request outright:
    // "role must be specified for image contents".
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-refs");
    }).generateVideo({
      model: MODEL,
      prompt: "in this world",
      correlationId: "cor_refs",
      references: [
        { kind: "base64", value: "AA", mimeType: "image/png" },
        { kind: "base64", value: "BB", mimeType: "image/png" },
        { kind: "base64", value: "CC", mimeType: "image/png" },
      ],
    });

    expect(body.content.slice(1)).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" }, role: "reference_image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,BB" }, role: "reference_image" },
      { type: "image_url", image_url: { url: "data:image/png;base64,CC" }, role: "reference_image" },
    ]);
  });

  it("pairs a first and last frame when both are given", async () => {
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-frames");
    }).generateVideo({
      model: MODEL,
      prompt: "open the curtain",
      correlationId: "cor_frames",
      firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
      lastFrame: { kind: "base64", value: "ZZ", mimeType: "image/png" },
    });

    expect(body.content.slice(1)).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,AA" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZZ" }, role: "last_frame" },
    ]);
  });

  it("refuses to mix frames with references, as the API does", async () => {
    // "first/last frame content cannot be mixed with reference media content."
    await expect(
      provider(() => created("cgt-mixed")).generateVideo({
        model: MODEL,
        prompt: "both at once",
        correlationId: "cor_mixed",
        firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
        lastFrame: { kind: "base64", value: "ZZ", mimeType: "image/png" },
        references: [{ kind: "base64", value: "BB", mimeType: "image/png" }],
      }),
    ).rejects.toThrow(/not mix a last frame with reference images/);
  });

  it("omits the ratio when a first frame sets it, and sends it otherwise", async () => {
    let anchored: any;
    await provider((_url, init) => {
      anchored = JSON.parse(String(init.body));
      return created("cgt-ratio-1");
    }).generateVideo({
      model: MODEL,
      prompt: "push in",
      correlationId: "cor_ratio_1",
      aspectRatio: "16:9",
      firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
    });
    expect(anchored.ratio).toBeUndefined();

    let referenced: any;
    await provider((_url, init) => {
      referenced = JSON.parse(String(init.body));
      return created("cgt-ratio-2");
    }).generateVideo({
      model: MODEL,
      prompt: "push in",
      correlationId: "cor_ratio_2",
      aspectRatio: "16:9",
      references: [
        { kind: "base64", value: "AA", mimeType: "image/png" },
        { kind: "base64", value: "BB", mimeType: "image/png" },
      ],
    });
    expect(referenced.ratio).toBe("16:9");
  });

  it("never sends framespersecond, which the API does not validate", async () => {
    // A wrong value here is accepted and silently creates a billable task.
    let body: any;
    await provider((_url, init) => {
      body = JSON.parse(String(init.body));
      return created("cgt-3");
    }).generateVideo({
      model: MODEL,
      prompt: "x",
      correlationId: "cor_3",
      parameters: { framespersecond: 999, fps: 999 },
    });

    expect(body.framespersecond).toBeUndefined();
    expect(body.fps).toBeUndefined();
  });

  it("requires something to generate from", async () => {
    await expect(
      provider(() => created("cgt-4")).generateVideo({
        model: MODEL,
        prompt: "   ",
        correlationId: "cor_4",
      }),
    ).rejects.toThrow(/needs a prompt, a reference image, or both/);
  });

  it("keeps polling while the task is running", async () => {
    const state = await provider(() =>
      new Response(JSON.stringify({ id: "cgt-5", status: "running" }), { status: 200 }),
    ).getJob("cgt-5");
    expect(state.status).toBe("running");
  });

  it("treats an unfamiliar status as still running rather than guessing", async () => {
    const state = await provider(() =>
      new Response(JSON.stringify({ status: "preprocessing" }), { status: 200 }),
    ).getJob("cgt-6");
    expect(state.status).toBe("running");
  });

  it("returns the signed video URL on success", async () => {
    const state = await provider(() =>
      new Response(
        JSON.stringify({
          status: "succeeded",
          content: { video_url: "https://tos.example/out.mp4?X-Tos-Expires=86400" },
          usage: { total_tokens: 1296900 },
        }),
        { status: 200 },
      ),
    ).getJob("cgt-7");

    expect(state.status).toBe("succeeded");
    expect(state.outputs?.[0]?.url).toBe(
      "https://tos.example/out.mp4?X-Tos-Expires=86400",
    );
    // The type is decided by sniffing the downloaded bytes, not asserted here.
    expect(state.outputs?.[0]?.mimeType).toBe("");
  });

  it("fails loudly if success arrives without a video", async () => {
    const state = await provider(() =>
      new Response(JSON.stringify({ status: "succeeded", content: {} }), { status: 200 }),
    ).getJob("cgt-8");
    expect(state.status).toBe("failed");
    expect(state.error?.message).toMatch(/no video_url/);
  });

  it("surfaces a task failure with the API message", async () => {
    const state = await provider(() =>
      new Response(
        JSON.stringify({ status: "failed", error: { message: "content policy" } }),
        { status: 200 },
      ),
    ).getJob("cgt-9");
    expect(state.status).toBe("failed");
    expect(state.error?.message).toBe("content policy");
  });

  it("says plainly that a running task cannot be stopped", async () => {
    await expect(
      provider(() =>
        new Response(
          JSON.stringify({
            error: { code: "InvalidAction.RunningTaskDeletion", message: "no" },
          }),
          { status: 409 },
        ),
      ).cancelJob("cgt-10"),
    ).rejects.toThrow(/cannot stop a task once it is running/);
  });

  it("strips the request id Ark appends to every message", async () => {
    await expect(
      provider(() =>
        new Response(
          JSON.stringify({
            error: { code: "InvalidParameter", message: "bad ratio. Request id: 021786" },
          }),
          { status: 400 },
        ),
      ).generateVideo({ model: MODEL, prompt: "x", correlationId: "c" }),
      // The sentence keeps its full stop; only the request id goes.
    ).rejects.toThrow(/bad ratio\.$/);
  });

  it("reports an auth failure as unauthorized, not a provider fault", async () => {
    await expect(
      provider(() =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
      ).generateVideo({ model: MODEL, prompt: "x", correlationId: "c" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("MockVideoProvider", () => {
  it("refuses to fabricate a video file when no fixture is configured", async () => {
    const provider = new MockVideoProvider();
    await expect(
      provider.generateVideo({ model: "mock-video-v1", prompt: "x", correlationId: "c" }),
    ).rejects.toThrow(/needs a fixture video/);
  });
});

describe("ProviderRegistry", () => {
  it("looks providers up and lists what is available on failure", () => {
    const registry = new ProviderRegistry().register(new MockImageProvider());
    expect(registry.get("mock-image").id).toBe("mock-image");
    expect(registry.has("seedream")).toBe(false);
    expect(() => registry.get("seedream")).toThrow(/unknown provider/);
  });
});

describe("SeedanceProvider ratio semantics", () => {
  const MODEL = "dreamina-seedance-2-5-260628";

  function capture(handler: (body: any) => void) {
    return new SeedanceProvider({
      baseUrl: "https://ark.example/api/v3",
      apiKey: "k",
      model: MODEL,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        handler(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ id: "cgt-x" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
  }

  it("sends ratio for text-to-video", async () => {
    let body: any;
    await capture((b) => (body = b)).generateVideo({
      model: MODEL,
      prompt: "a lighthouse",
      aspectRatio: "16:9",
      correlationId: "c",
    });
    expect(body.ratio).toBe("16:9");
  });

  it("omits ratio for image-to-video, where the API derives it", async () => {
    // "For first-frame or first-last-frame generation, the output ratio
    // follows the first-frame image." Sending it is a hard error.
    let body: any;
    await capture((b) => (body = b)).generateVideo({
      model: MODEL,
      prompt: "push in",
      aspectRatio: "16:9",
      correlationId: "c",
      firstFrame: { kind: "base64", value: "AA", mimeType: "image/png" },
    });
    expect(body.ratio).toBeUndefined();
  });

  it("rejects a duration outside 4..30 before spending a call", async () => {
    let called = false;
    await expect(
      capture(() => (called = true)).generateVideo({
        model: MODEL,
        prompt: "x",
        durationSeconds: 3,
        correlationId: "c",
      }),
    ).rejects.toThrow(/4 to 30 seconds/);
    expect(called).toBe(false);
  });
});

describe("seedanceSizesFor", () => {
  // Measured against the live API; see docs/research/MODEL_API_NOTES.md.
  it("offers 4K on 2.0, which 2.5 does not reach", () => {
    expect(seedanceSizesFor("dreamina-seedance-2-0-260128")).toContain("4K");
    expect(seedanceSizesFor("dreamina-seedance-2-5-260628")).not.toContain("4K");
  });

  it("stops the fast and mini variants at 720p", () => {
    expect(seedanceSizesFor("dreamina-seedance-2-0-fast-260128")).toEqual([
      "480p",
      "720p",
    ]);
    expect(seedanceSizesFor("dreamina-seedance-2-0-mini-260615")).toEqual([
      "480p",
      "720p",
    ]);
  });

  it("offers no 2K tier, which no model accepted", () => {
    for (const model of [
      "dreamina-seedance-2-5-260628",
      "dreamina-seedance-2-0-260128",
      "dreamina-seedance-2-0-mini-260615",
    ]) {
      expect(seedanceSizesFor(model)).not.toContain("2K");
      expect(seedanceSizesFor(model)).not.toContain("2k");
    }
  });

  it("names each model readably, keeping the variant", () => {
    expect(seedanceDisplayName("dreamina-seedance-2-0-fast-260128")).toBe(
      "Seedance 2.0 fast (Ark)",
    );
    expect(seedanceProviderId("dreamina-seedance-2-0-fast-260128")).toBe(
      "seedance-2-0-fast",
    );
  });
});

describe("SeedanceProvider reference media", () => {
  // "reference media mode requires video role to be reference_video" — the
  // API types each kind separately, and a mismatch is refused outright.
  const MODEL = "dreamina-seedance-2-5-260628";

  function provider(fetchImpl: typeof fetch) {
    return new SeedanceProvider({
      baseUrl: "https://ark.test/api/v3",
      apiKey: "key",
      model: MODEL,
      fetchImpl,
    });
  }

  it("types each reference by what the media actually is", async () => {
    let body: any;
    await provider(
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "cgt-mixed" }), { status: 200 });
      }) as unknown as typeof fetch,
    ).generateVideo({
      model: MODEL,
      prompt: "this move, those characters",
      correlationId: "cor_mixed_media",
      references: [
        { kind: "url", value: "https://x/clip.mp4", mimeType: "video/mp4" },
        { kind: "base64", value: "AA", mimeType: "image/png" },
        { kind: "url", value: "https://x/room.mp3", mimeType: "audio/mpeg" },
      ],
    });

    expect(body.content.slice(1)).toEqual([
      {
        type: "video_url",
        video_url: { url: "https://x/clip.mp4" },
        role: "reference_video",
      },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,AA" },
        role: "reference_image",
      },
      {
        type: "audio_url",
        audio_url: { url: "https://x/room.mp3" },
        role: "reference_audio",
      },
    ]);
  });

  it("never makes a lone clip the first frame", async () => {
    let body: any;
    await provider(
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "cgt-clip" }), { status: 200 });
      }) as unknown as typeof fetch,
    ).generateVideo({
      model: MODEL,
      prompt: "reskin this, same camera",
      correlationId: "cor_lone_clip",
      references: [{ kind: "url", value: "https://x/plate.mp4", mimeType: "video/mp4" }],
      aspectRatio: "16:9",
    });

    /*
     * One input normally anchors the opening frame. A clip cannot: it is
     * motion, and an image_url part holding a video is refused.
     */
    expect(body.content[1]).toEqual({
      type: "video_url",
      video_url: { url: "https://x/plate.mp4" },
      role: "reference_video",
    });
    // Length follows the clip unless the artist says otherwise: -1 is Ark's
    // "follow the input", and it is accepted whichever way the prompt reads.
    // A ratio that was asked for is still sent — see the next test.
    expect(body.duration).toBe(-1);
    expect(body.ratio).toBe("16:9");
  });

  it("still sends a stated duration and ratio alongside a clip", async () => {
    let body: any;
    await provider(
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ id: "cgt-longer" }), { status: 200 });
      }) as unknown as typeof fetch,
    ).generateVideo({
      model: MODEL,
      prompt: "a different scene entirely, inspired by this movement",
      correlationId: "cor_clip_duration",
      references: [{ kind: "url", value: "https://x/plate.mp4", mimeType: "video/mp4" }],
      durationSeconds: 8,
      aspectRatio: "9:16",
    });

    /*
     * Verified live: with a prompt describing a new shot rather than a change
     * to the clip, Ark accepts an ordinary duration. Defaulting to -1 must not
     * become a rule that removes the choice — an artist using a clip as a
     * loose reference is allowed to ask for a different length — and a
     * different shape, which 9:16 alongside the same clip also proved.
     */
    expect(body.duration).toBe(8);
    expect(body.ratio).toBe("9:16");
  });
});
