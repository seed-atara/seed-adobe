import { describe, expect, it } from "vitest";
import { UpscaleProvider } from "../src/index.js";
import type { VideoGenerationRequest } from "../src/types.js";

/**
 * The upscaler is the lane that promises it *cannot* change the shot, and that
 * promise is only as good as the request body. Most of what is asserted here is
 * the absence of things: no prompt, no ratio, no duration, no undocumented
 * field that might quietly mean something.
 */

function stub(
  routes: Array<(url: string, init?: RequestInit) => Response | undefined>,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response("unmatched", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const submitted = () => json({ request_id: "req_1" });

function request(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    model: "fal-ai/topaz/upscale/video",
    prompt: "",
    correlationId: "cor_1",
    references: [
      { kind: "url", value: "https://example.test/archive.mp4", mimeType: "video/mp4" },
    ],
    ...overrides,
  } as VideoGenerationRequest;
}

/** The JSON body of the one submit call. */
function bodyOf(calls: Array<{ init?: RequestInit }>): Record<string, unknown> {
  return JSON.parse(String(calls[0]?.init?.body));
}

describe("UpscaleProvider", () => {
  it("declares no prompt, no seed and no sizes — which is the guarantee", async () => {
    const provider = new UpscaleProvider({ apiKey: "k" });
    const capabilities = await provider.capabilities();

    // Each of these would be a way for the result to differ from the source.
    expect(capabilities.supportsNegativePrompt).toBe(false);
    expect(capabilities.seed).toBe(false);
    expect(capabilities.sizes).toEqual([]);
    expect(capabilities.aspectRatios).toEqual([]);
    // And the one thing it does take.
    expect(capabilities.videoReferences).toBe(true);
    expect(capabilities.maxImageReferences).toBe(0);
  });

  it("needs a clip, because it restores one rather than making one", async () => {
    const { fetchImpl } = stub([]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await expect(
      provider.generateVideo(request({ references: [] })),
    ).rejects.toThrow(/needs one as a reference/);
  });

  it("says what is missing when the clip is not reachable by URL", async () => {
    const { fetchImpl } = stub([]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await expect(
      provider.generateVideo(
        request({
          references: [
            { kind: "base64", value: "AAAA", mimeType: "video/mp4" },
          ],
        }),
      ),
    ).rejects.toThrow(/SEED_R2_/);
  });

  it("sends the clip and never sends a prompt", async () => {
    const { fetchImpl, calls } = stub([(url) => (url.includes("topaz") ? submitted() : undefined)]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });

    await provider.generateVideo(
      request({ prompt: "make it look like a Wes Anderson film" }),
    );

    const body = bodyOf(calls);
    expect(body.video_url).toBe("https://example.test/archive.mp4");
    /*
     * The prompt on the request is ignored rather than forwarded. It exists
     * because every generation carries one — the restore route puts a sentence
     * there explaining that no prompt is sent — and forwarding it to a field
     * Topaz does not read would be harmless right up until Topaz added one.
     */
    expect(Object.keys(body)).not.toContain("prompt");
    expect(JSON.stringify(body)).not.toContain("Wes Anderson");
  });

  it("asks for H.264 so the result imports and previews without a codec pack", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(request());
    // The endpoint defaults to H.265, which the panel cannot decode for a
    // poster and which After Effects will not import unaided.
    expect(bodyOf(calls).H264_output).toBe(true);
  });

  it("gives the two measured treatments genuinely different settings", async () => {
    const bodies: Record<string, Record<string, unknown>> = {};
    for (const treatment of ["detail", "clean"]) {
      const { fetchImpl, calls } = stub([() => submitted()]);
      const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
      await provider.generateVideo(
        request({ parameters: { seedRestore: treatment } }),
      );
      bodies[treatment] = bodyOf(calls);
    }

    // Detail keeps what is there; cleaning removes what the recording added.
    // Aggressive denoising is exactly how an upscaler turns skin into wax, so
    // the two must not collapse into one "enhance".
    expect(Number(bodies.detail?.recover_detail)).toBeGreaterThan(
      Number(bodies.clean?.recover_detail),
    );
    expect(Number(bodies.clean?.noise)).toBeGreaterThan(Number(bodies.detail?.noise));
  });

  it("leaves the settings to Topaz when the treatment is not one it knows", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(request({ parameters: { seedRestore: "colourise" } }));

    // No guessed numbers. An unsent field gets Topaz's own default for the
    // chosen model, which is a better number than one invented here.
    const body = bodyOf(calls);
    expect(body.noise).toBeUndefined();
    expect(body.recover_detail).toBeUndefined();
  });

  it("clamps a factor to something worth paying for", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    // A mistyped 40 is an expensive way to learn the cost scales with pixels.
    await provider.generateVideo(request({ parameters: { upscaleFactor: 40 } }));
    expect(bodyOf(calls).upscale_factor).toBe(4);
  });

  it("clamps overrides to their documented ranges, grain to its odd one", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(
      request({ parameters: { topaz: { noise: 5, grain: 0.9, halo: -3 } } }),
    );

    const body = bodyOf(calls);
    expect(body.noise).toBe(1);
    expect(body.halo).toBe(0);
    // grain is 0..0.1 while everything else is 0..1 — clamping it to 1 would
    // put ten times the documented maximum of film grain on an archive clip.
    expect(body.grain).toBeCloseTo(0.1, 6);
  });

  it("drops a field Topaz does not document rather than forwarding it", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(
      request({ parameters: { topaz: { sharpen: 0.5, noise: 0.4 } } }),
    );

    /*
     * A field the endpoint does not read looks identical to one it does until
     * the result comes back wrong — which is exactly how `output_format` sat
     * in the Seedance request for months doing nothing.
     */
    const body = bodyOf(calls);
    expect(body.sharpen).toBeUndefined();
    expect(body.noise).toBe(0.4);
  });

  it("never changes the frame rate unless something explicitly asks", async () => {
    const { fetchImpl, calls } = stub([() => submitted()]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(request());
    // Interpolating archive footage is a creative decision with an opinion
    // attached, and a restored clip has to cut against the original.
    expect(bodyOf(calls).target_fps).toBeUndefined();
  });

  it("hands back the restored clip once the queue reports it finished", async () => {
    const { fetchImpl } = stub([
      (url) => (url.endsWith("/status") ? json({ status: "COMPLETED" }) : undefined),
      (url) =>
        url.includes("/requests/req_1")
          ? json({ video: { url: "https://fal.test/out.mp4", content_type: "video/mp4" } })
          : undefined,
      () => submitted(),
    ]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    const job = await provider.generateVideo(request());

    const state = await provider.getJob(job.providerJobId);
    expect(state.status).toBe("succeeded");
    expect(state.outputs?.[0]?.url).toBe("https://fal.test/out.mp4");
  });

  it("fails loudly when the queue claims success with nothing attached", async () => {
    const { fetchImpl } = stub([
      (url) => (url.endsWith("/status") ? json({ status: "COMPLETED" }) : undefined),
      (url) => (url.includes("/requests/req_1") ? json({}) : undefined),
      () => submitted(),
    ]);
    const provider = new UpscaleProvider({ apiKey: "k", fetchImpl });
    const job = await provider.generateVideo(request());

    const state = await provider.getJob(job.providerJobId);
    expect(state.status).toBe("failed");
    expect(state.error?.message).toMatch(/returned no video/);
  });
});
