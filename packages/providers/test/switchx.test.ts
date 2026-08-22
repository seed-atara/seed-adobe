import { describe, expect, it } from "vitest";
import { SwitchXProvider } from "../src/index.js";

const SOURCE = {
  kind: "url" as const,
  value: "https://cdn.example/plate.mp4",
  mimeType: "video/mp4",
};
const REFERENCE = {
  kind: "url" as const,
  value: "https://cdn.example/backdrop.png",
  mimeType: "image/png",
};

function provider(handler: (url: string, init: RequestInit) => Response) {
  return new SwitchXProvider({
    apiKey: "bbl_sk_test",
    fetchImpl: (async (url: string, init: RequestInit) =>
      handler(String(url), init)) as unknown as typeof fetch,
  });
}

function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SwitchXProvider", () => {
  it("refuses to construct without a key", () => {
    expect(() => new SwitchXProvider({ apiKey: "" })).toThrow(/x-api-key/);
  });

  it("declares one reference, and that it is the scene rather than a subject", async () => {
    const caps = await provider(() => ok({})).capabilities();
    expect(caps.maxImageReferences).toBe(1);
    expect(caps.stableImageReferences).toBe(1);
    expect(caps.addressing).toEqual(["hosted-url", "inline"]);
    expect(caps.seed).toBe(true);
    expect(caps.async).toBe(true);
    expect(caps.sizes).toEqual(["720", "1080"]);
  });

  it("posts the documented field set and keeps the key out of rawRequest", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const job = await provider((url, init) => {
      captured = { url, init };
      return ok({ id: "swx_1", status: "in_queue" });
    }).generateVideo({
      model: "switchx",
      prompt: "a rain-soaked street at night",
      seed: 7,
      correlationId: "cor_1",
      references: [SOURCE, REFERENCE],
    });

    expect(captured?.url).toBe("https://api.beeble.ai/v1/switchx/generations");
    expect((captured?.init.headers as Record<string, string>)["x-api-key"]).toBe(
      "bbl_sk_test",
    );
    const body = JSON.parse(String(captured?.init.body));
    expect(body).toMatchObject({
      generation_type: "video",
      source_uri: SOURCE.value,
      alpha_mode: "auto",
      max_resolution: 1080,
      prompt: "a rain-soaked street at night",
      seed: 7,
    });
    expect(JSON.stringify(job.rawRequest)).not.toContain("bbl_sk_test");
    expect(job.providerJobId).toBe("swx_1");
    expect(job.state.status).toBe("queued");
  });

  it("requires either a prompt or a reference to describe the new scene", async () => {
    await expect(
      provider(() => ok({})).generateVideo({
        model: "switchx",
        prompt: "",
        correlationId: "cor_2",
        references: [SOURCE],
      }),
    ).rejects.toThrow(/prompt or a reference image/);
  });

  it("refuses a mask mode with no mask instead of letting the API do it", async () => {
    await expect(
      provider(() => ok({})).generateVideo({
        model: "switchx",
        prompt: "x",
        correlationId: "cor_3",
        references: [SOURCE],
        parameters: { alphaMode: "custom" },
      }),
    ).rejects.toThrow(/needs a matte/);
  });

  it("maps its queue vocabulary onto ours", async () => {
    const states = [
      ["in_queue", "queued"],
      ["processing", "running"],
      ["failed", "failed"],
    ] as const;
    for (const [theirs, ours] of states) {
      const state = await provider(() =>
        ok({ id: "swx_1", status: theirs, progress: 40, error: "boom" }),
      ).getJob("swx_1");
      expect(state.status).toBe(ours);
    }
  });

  it("returns the alpha alongside the render, which is what makes it a comp", async () => {
    const state = await provider(() =>
      ok({
        id: "swx_1",
        status: "completed",
        output: {
          render: "https://cdn.beeble/render.mp4",
          alpha: "https://cdn.beeble/alpha.mp4",
          source: "https://cdn.beeble/source.mp4",
        },
      }),
    ).getJob("swx_1");

    expect(state.status).toBe("succeeded");
    expect(state.outputs).toHaveLength(2);
    expect(state.outputs?.[0]?.url).toBe("https://cdn.beeble/render.mp4");
    expect(state.outputs?.[1]?.url).toBe("https://cdn.beeble/alpha.mp4");
  });

  it("treats completion with no render as a failure, keeping the payload", async () => {
    const state = await provider(() => ok({ id: "swx_1", status: "completed" })).getJob(
      "swx_1",
    );
    expect(state.status).toBe("failed");
    expect(state.raw).toMatchObject({ id: "swx_1" });
  });

  it("names the offending field from a validation rejection", async () => {
    const failing = provider(
      () =>
        new Response(
          JSON.stringify({
            detail: [
              { type: "missing", loc: ["body", "source_uri"], msg: "Field required" },
            ],
          }),
          { status: 422 },
        ),
    );
    await expect(failing.getJob("swx_1")).rejects.toThrow(/source_uri: Field required/);
  });

  it("surfaces Beeble's own error envelope", async () => {
    const failing = provider(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Job not found", code: "JOB_NOT_FOUND" } }),
          { status: 404 },
        ),
    );
    await expect(failing.getJob("swx_missing")).rejects.toThrow(/Job not found/);
  });
});
