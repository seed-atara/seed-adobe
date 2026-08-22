import { describe, expect, it } from "vitest";
import { ReframeProvider } from "../src/index.js";
import type { VideoGenerationRequest } from "../src/types.js";

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

function request(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    model: "luma/agent/ray/v3.2/reframe",
    prompt: "",
    correlationId: "cor_1",
    references: [
      { kind: "url", value: "https://example.test/shot.mp4", mimeType: "video/mp4" },
    ],
    ...overrides,
  } as VideoGenerationRequest;
}

describe("ReframeProvider", () => {
  it("needs a clip, because it expands one rather than making one", async () => {
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    await expect(provider.generateVideo(request({ references: [] }))).rejects.toThrow(
      /needs one as a reference/,
    );
  });

  it("needs the clip as a URL", async () => {
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    await expect(
      provider.generateVideo(
        request({
          references: [{ kind: "base64", value: "AA", mimeType: "video/mp4" }],
        }),
      ),
    ).rejects.toThrow(/fetchable URL/);
  });

  it("refuses an aspect the endpoint does not offer, before the upload", async () => {
    /*
     * The aspects are an enum. Finding out after the clip has been hosted and
     * queued is a slow way to learn that 2.39:1 is not on the list.
     */
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    await expect(
      provider.generateVideo(request({ aspectRatio: "2.39:1" })),
    ).rejects.toThrow(/not among/);
  });

  it("submits the clip, the aspect and a continuation prompt", async () => {
    const { fetchImpl, calls } = stub([
      (_url, init) => (init?.method === "POST" ? json({ request_id: "req_1" }) : undefined),
    ]);
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(request({ aspectRatio: "16:9", size: "720p" }));

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.video_url).toBe("https://example.test/shot.mp4");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("720p");
    // The job is continuation, not invention, so an empty prompt gets a
    // default that says so rather than being left to produce indifferent edges.
    expect(String(body.prompt)).toContain("continue the existing scene");
  });

  it("keeps the artist's own prompt when there is one", async () => {
    const { fetchImpl, calls } = stub([
      (_url, init) => (init?.method === "POST" ? json({ request_id: "req_2" }) : undefined),
    ]);
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl });
    await provider.generateVideo(request({ prompt: "a wet street at night" }));
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.prompt).toBe("a wet street at night");
  });

  it("passes a source rectangle, and drops one that leaves the canvas", async () => {
    /*
     * source_rect places the original inside the new frame, so a subject can
     * sit off-centre — what an editor wants when a talking head has to make
     * room for a title. A rectangle outside the canvas would be refused, and
     * that is worth catching here rather than after the queue.
     */
    const { fetchImpl, calls } = stub([
      (_url, init) => (init?.method === "POST" ? json({ request_id: "req_3" }) : undefined),
    ]);
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl });

    await provider.generateVideo(
      request({ parameters: { sourceRect: { x: 0.25, y: 0, width: 0.5, height: 1 } } }),
    );
    const good = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(good.source_rect).toEqual({ x: 0.25, y: 0, width: 0.5, height: 1 });

    await provider.generateVideo(
      request({ parameters: { sourceRect: { x: 0.8, y: 0, width: 0.5, height: 1 } } }),
    );
    const bad = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(bad.source_rect).toBeUndefined();
  });

  it("returns the expanded clip once the queue completes", async () => {
    const { fetchImpl } = stub([
      (url) => (url.includes("/status") ? json({ status: "COMPLETED" }) : undefined),
      (url) =>
        url.includes("/requests/req_4")
          ? json({ video: { url: "https://cdn.test/wide.mp4", content_type: "video/mp4" } })
          : undefined,
    ]);
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl });
    const state = await provider.getJob("req_4");
    expect(state.status).toBe("succeeded");
    expect(state.outputs?.[0]?.url).toBe("https://cdn.test/wide.mp4");
  });

  it("declares itself as a video reference tool and nothing else", async () => {
    const provider = new ReframeProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    const capabilities = await provider.capabilities();
    expect(capabilities.videoReferences).toBe(true);
    expect(capabilities.maxImageReferences).toBe(0);
    expect(capabilities.textToVideo).toBe(false);
    expect(capabilities.aspectRatios).toContain("21:9");
  });
});
