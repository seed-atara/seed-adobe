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
  it("refuses to construct without an Ark API key, naming the AK/SK confusion", () => {
    expect(() => new SeedreamProvider({ baseUrl: "https://x", apiKey: "", model: "m" }))
      .toThrow(/AK\/SK pair is a different Volcengine credential type/);
  });

  it("does not advertise seed support, which is unverified", async () => {
    const provider = new SeedreamProvider({
      baseUrl: "https://ark.example",
      apiKey: "key",
      model: "configured-model",
    });
    const caps = await provider.capabilities();
    expect(caps.seed).toBe(false);
    expect(caps.models).toEqual(["configured-model"]);
  });

  it("posts only documented fields and never leaks the key into rawRequest", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const provider = new SeedreamProvider({
      baseUrl: "https://ark.example",
      apiKey: "super-secret",
      model: "configured-model",
      fetchImpl: (async (url: string, init: RequestInit) => {
        captured = { url: String(url), init };
        return new Response(
          JSON.stringify({ data: [{ b64_json: "aGk=" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    const job = await provider.generateImage({
      model: "configured-model",
      prompt: "a lighthouse",
      size: "1024x1024",
      correlationId: "cor_1",
      references: [{ kind: "dataUrl", value: "data:image/png;base64,AA", mimeType: "image/png" }],
    });

    expect(captured?.url).toBe("https://ark.example/api/v3/images/generations");
    const body = JSON.parse(String(captured?.init.body));
    expect(Object.keys(body).sort()).toEqual(
      ["image", "model", "prompt", "response_format", "size", "watermark"].sort(),
    );
    expect(body.seed).toBeUndefined();
    expect(JSON.stringify(job.rawRequest)).not.toContain("super-secret");
    expect(job.state.status).toBe("succeeded");
    expect(job.state.outputs?.[0]?.base64).toBe("aGk=");
  });

  it("fails loudly but keeps the raw payload when the response is unrecognisable", async () => {
    const provider = new SeedreamProvider({
      baseUrl: "https://ark.example",
      apiKey: "key",
      model: "m",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as
        unknown as typeof fetch,
    });
    const job = await provider.generateImage({
      model: "m",
      prompt: "x",
      correlationId: "cor_2",
    });
    expect(job.state.status).toBe("failed");
    expect(job.state.raw).toEqual({ unexpected: true });
  });

  it("maps an HTTP error onto a failed job rather than throwing", async () => {
    const provider = new SeedreamProvider({
      baseUrl: "https://ark.example",
      apiKey: "key",
      model: "m",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "quota" }), { status: 429 })) as
        unknown as typeof fetch,
    });
    const job = await provider.generateImage({
      model: "m",
      prompt: "x",
      correlationId: "cor_3",
    });
    expect(job.state.status).toBe("failed");
    expect(job.state.error?.message).toContain("429");
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
