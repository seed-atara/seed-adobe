import { describe, expect, it } from "vitest";
import { decodePng } from "@seed-ae/media";
import {
  MockImageProvider,
  MockVideoProvider,
  ProviderRegistry,
  SeedanceProvider,
  SeedreamProvider,
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
    const failingLibrary = {
      ensureAsset: async () => {
        throw new Error("registration unavailable");
      },
    } as never;

    it("asset policy refuses to fall back to posting raw pixels", async () => {
      const seedream = provider({
        referencePolicy: "asset",
        assetLibrary: failingLibrary,
      });
      await expect(
        seedream.generateImage({
          model: MODEL,
          prompt: "x",
          correlationId: "cor_8",
          references: [{ kind: "base64", value: "AA", mimeType: "image/png" }],
        }),
      ).rejects.toThrow(/registration unavailable/);
    });

    it("asset-or-inline degrades to a data URL", async () => {
      let body: Record<string, unknown> | undefined;
      const seedream = provider({
        referencePolicy: "asset-or-inline",
        assetLibrary: failingLibrary,
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

    it("references a registered asset as asset://<id>", async () => {
      let body: Record<string, unknown> | undefined;
      const seedream = provider({
        referencePolicy: "asset",
        assetLibrary: {
          ensureAsset: async () => ({ assetId: "asset-42", cached: true }),
        } as never,
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
      expect(body?.image).toBe("asset://asset-42");
    });
  });
});

describe("SeedanceProvider", () => {
  it("advertises nothing and refuses to run", async () => {
    const provider = new SeedanceProvider({ model: "whatever" });
    const caps = await provider.capabilities();
    expect(caps.operations).toEqual([]);
    expect(caps.textToVideo).toBe(false);

    await expect(
      provider.generateVideo({ model: "whatever", prompt: "x", correlationId: "c" }),
    ).rejects.toThrow(/contract has not been verified/);
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
