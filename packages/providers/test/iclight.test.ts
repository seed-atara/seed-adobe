import { describe, expect, it } from "vitest";
import { ICLightProvider, sideFromAzimuth } from "../src/index.js";
import type { ImageEditRequest } from "../src/types.js";

/** A fetch that answers from a script and records what it was asked. */
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

function editRequest(overrides: Partial<ImageEditRequest> = {}): ImageEditRequest {
  return {
    model: "fal-ai/iclight-v2",
    prompt: "warm window light from the left",
    correlationId: "cor_1",
    image: { kind: "url", value: "https://example.test/plate.png", mimeType: "image/png" },
    ...overrides,
  } as ImageEditRequest;
}

describe("sideFromAzimuth", () => {
  it("maps an azimuth onto the side the endpoint names", () => {
    // IC-Light expresses light position as which side the latent is seeded
    // from. Artists think in azimuth, so the panel offers that.
    expect(sideFromAzimuth(-90)).toBe("Left");
    expect(sideFromAzimuth(90)).toBe("Right");
    expect(sideFromAzimuth(0)).toBe("None");
  });

  it("lets a steep light win over the side it is on", () => {
    expect(sideFromAzimuth(90, 70)).toBe("Top");
    expect(sideFromAzimuth(90, -70)).toBe("Bottom");
  });

  it("asks for nothing when nothing was said", () => {
    // "None" is the endpoint's own default: let the model decide.
    expect(sideFromAzimuth()).toBe("None");
  });
});

describe("ICLightProvider", () => {
  it("refuses a plate that is not fetchable, before spending anything", async () => {
    /*
     * The endpoint takes a URL. An inline plate would be silently dropped and
     * the artist would pay for a relight of nothing.
     */
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    await expect(
      provider.editImage(
        editRequest({
          image: { kind: "base64", value: "AAAA", mimeType: "image/png" },
        }),
      ),
    ).rejects.toThrow(/fetchable URL/);
  });

  it("submits to the queue and keeps the urls it was handed", async () => {
    const { fetchImpl, calls } = stub([
      (url, init) =>
        init?.method === "POST" && url.endsWith("/fal-ai/iclight-v2")
          ? json({
              request_id: "req_1",
              status_url: "https://queue.test/status/req_1",
              response_url: "https://queue.test/result/req_1",
            })
          : undefined,
    ]);

    const provider = new ICLightProvider({ apiKey: "secret", fetchImpl });
    const job = await provider.editImage(editRequest({ seed: 42, size: "square_hd" }));

    expect(job.providerJobId).toBe("req_1");
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.image_url).toBe("https://example.test/plate.png");
    expect(body.seed).toBe(42);
    expect(body.image_size).toBe("square_hd");
    // PNG, not the endpoint's JPEG default: a relight is an intermediate that
    // a detail transfer and a grade run on afterwards.
    expect(body.output_format).toBe("png");

    // fal's scheme is "Key", not "Bearer" — an easy and silent mistake.
    const auth = (calls[0]?.init?.headers as Record<string, string>).authorization;
    expect(auth).toBe("Key secret");
  });

  it("drops a size the endpoint does not name", async () => {
    // The sizes are an enum. Passing "1920x1080" would be refused outright, so
    // it is left off and the endpoint's own default stands.
    const { fetchImpl, calls } = stub([
      (_url, init) =>
        init?.method === "POST" ? json({ request_id: "req_2" }) : undefined,
    ]);
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    await provider.editImage(editRequest({ size: "1920x1080" }));
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.image_size).toBeUndefined();
  });

  it("carries the light direction as the side the endpoint understands", async () => {
    const { fetchImpl, calls } = stub([
      (_url, init) =>
        init?.method === "POST" ? json({ request_id: "req_3" }) : undefined,
    ]);
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    await provider.editImage(
      editRequest({ parameters: { lightAzimuth: -90 } } as Partial<ImageEditRequest>),
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.initial_latent).toBe("Left");
  });

  it("reports a queued job as queued rather than done", async () => {
    const { fetchImpl } = stub([
      (url) =>
        url.includes("/status") ? json({ status: "IN_QUEUE", queue_position: 3 }) : undefined,
    ]);
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    expect((await provider.getJob("req_4")).status).toBe("queued");
  });

  it("treats a status it has never seen as still running", async () => {
    /*
     * Guessing "failed" would abandon a job that is merely in a state this
     * adapter has not met. The next poll will ask again.
     */
    const { fetchImpl } = stub([
      (url) => (url.includes("/status") ? json({ status: "SOMETHING_NEW" }) : undefined),
    ]);
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    expect((await provider.getJob("req_5")).status).toBe("running");
  });

  it("fetches the result only once the queue says it is complete", async () => {
    const { fetchImpl, calls } = stub([
      (url) => (url.includes("/status") ? json({ status: "COMPLETED" }) : undefined),
      (url) =>
        url.includes("/requests/req_6")
          ? json({
              images: [
                {
                  url: "https://cdn.test/relit.png",
                  width: 1024,
                  height: 1024,
                  content_type: "image/png",
                },
              ],
              seed: 7,
            })
          : undefined,
    ]);

    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    const state = await provider.getJob("req_6");

    expect(state.status).toBe("succeeded");
    expect(state.outputs?.[0]?.url).toBe("https://cdn.test/relit.png");
    expect(state.outputs?.[0]?.seed).toBe(7);
    expect(calls.filter((call) => call.url.includes("/status"))).toHaveLength(1);
  });

  it("fails loudly when the queue says done and hands back nothing", async () => {
    const { fetchImpl } = stub([
      (url) => (url.includes("/status") ? json({ status: "COMPLETED" }) : undefined),
      (url) => (url.includes("/requests/req_7") ? json({ images: [] }) : undefined),
    ]);
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl });
    const state = await provider.getJob("req_7");
    expect(state.status).toBe("failed");
    expect(state.error?.message).toContain("no image");
  });

  it("declares one reference, because the endpoint takes one image", async () => {
    // Declaring more would let the panel offer a second plate that would be
    // silently dropped — the "declared, not implemented" failure again.
    const provider = new ICLightProvider({ apiKey: "k", fetchImpl: stub([]).fetchImpl });
    const capabilities = await provider.capabilities();
    expect(capabilities.maxImageReferences).toBe(1);
    expect(capabilities.operations).toEqual(["image.edit"]);
    expect(capabilities.videoReferences).toBe(false);
  });
});
