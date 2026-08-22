import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetSchema,
  JobResponseSchema,
  LineageResponseSchema,
} from "@seed-ae/domain";
import { decodePng } from "@seed-ae/media";
import { readJson, startTestService, type TestService } from "./helpers.js";

let service: TestService;

beforeAll(async () => {
  service = await startTestService();
});

afterAll(async () => {
  await service.close();
});

async function captureFrame() {
  const response = await service.call("/v1/ae/capture-frame", {
    method: "POST",
    body: "{}",
  });
  return AssetSchema.parse((await readJson(response)).asset);
}

/** Starts a generation and waits for the background task to settle. */
async function generate(body: Record<string, unknown>) {
  const response = await service.call("/v1/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const started = await readJson(response);
  if (response.status !== 202) return { response, started, final: started };
  await service.deps.generation.whenSettled(started.job.id);
  const final = JobResponseSchema.parse(
    await readJson(await service.call(`/v1/jobs/${started.job.id}`)),
  );
  return { response, started, final };
}

describe("GET /v1/providers", () => {
  it("lists capabilities, and does not offer Seedance as runnable", async () => {
    const { providers } = await readJson(await service.call("/v1/providers"));
    const ids = providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("mock-image");
    expect(ids).not.toContain("seedance");
  });
});

describe("generation lifecycle", () => {
  it("returns 202 immediately rather than blocking on the provider", async () => {
    const { response, started } = await generate({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "a lighthouse at dusk",
    });
    expect(response.status).toBe(202);
    expect(["queued", "running"]).toContain(started.job.status);
    expect(started.generation.status).toBe("queued");
    await service.deps.generation.whenSettled(started.job.id);
  });

  it("registers the result as an asset with a thumbnail and full recipe", async () => {
    const { final } = await generate({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "a lighthouse at dusk",
      seed: 42,
      size: "320x180",
    });

    expect(final.job.status).toBe("succeeded");
    expect(final.generation?.status).toBe("succeeded");
    expect(final.outputs).toHaveLength(1);

    const output = final.outputs[0];
    if (!output) throw new Error("no output");
    expect(output.kind).toBe("image");
    expect(output.width).toBe(320);
    expect(output.generationId).toBe(final.generation?.id);
    expect(output.storageUri.startsWith("assets/generated/")).toBe(true);
    expect(output.thumbnailUri).toBeDefined();
    if (output.source.type !== "generated") throw new Error("wrong source");
    expect(output.source.provider).toBe("mock-image");

    // The recipe is reproducible: prompt, seed and parameters all survived.
    expect(final.generation?.prompt).toBe("a lighthouse at dusk");
    expect(final.generation?.seed).toBe(42);
    expect(final.generation?.parameters).toMatchObject({ size: "320x180" });
    expect(final.generation?.rawResponse).toBeDefined();

    const file = await service.call(`/v1/assets/${output.id}/file`);
    expect(decodePng(Buffer.from(await file.arrayBuffer()))).toMatchObject({
      width: 320,
      height: 180,
    });
  });

  it("derives a result from a captured frame and records the lineage", async () => {
    const frame = await captureFrame();
    const { final } = await generate({
      providerId: "mock-image",
      operation: "image.edit",
      prompt: "make it a night shot",
      size: "320x180",
      inputAssetIds: [frame.id],
    });

    expect(final.job.status).toBe("succeeded");
    const output = final.outputs[0];
    if (!output) throw new Error("no output");
    expect(final.generation?.inputAssetIds).toEqual([frame.id]);

    const lineage = LineageResponseSchema.parse(
      await readJson(await service.call(`/v1/assets/${frame.id}/lineage`)),
    );
    expect(lineage.assets.map((a) => a.id)).toEqual(
      expect.arrayContaining([frame.id, output.id]),
    );
    expect(lineage.edges).toContainEqual({
      fromAssetId: frame.id,
      toAssetId: output.id,
      generationId: final.generation?.id,
    });

    // The same graph is reachable from the descendant.
    const fromChild = LineageResponseSchema.parse(
      await readJson(await service.call(`/v1/assets/${output.id}/lineage`)),
    );
    expect(fromChild.assets.map((a) => a.id)).toContain(frame.id);
  });

  it("reopens a recipe that branches instead of overwriting", async () => {
    const { final } = await generate({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "original prompt",
      seed: 7,
      size: "64x64",
    });
    const original = final.outputs[0];
    if (!original) throw new Error("no output");

    const { recipe } = await readJson(
      await service.call(`/v1/assets/${original.id}/recipe`),
    );
    expect(recipe.prompt).toBe("original prompt");
    expect(recipe.seed).toBe(7);
    expect(recipe.parentAssetId).toBe(original.id);
    expect(recipe.parentGenerationId).toBe(final.generation?.id);

    // Vary the seed and run the recovered recipe.
    const variation = await generate({ ...recipe, seed: 8 });
    expect(variation.final.job.status).toBe("succeeded");
    expect(variation.final.generation?.parentGenerationId).toBe(final.generation?.id);
    const varied = variation.final.outputs[0];
    if (!varied) throw new Error("no variation output");
    expect(varied.id).not.toBe(original.id);

    // The original asset and its generation are untouched.
    const reloaded = await readJson(await service.call(`/v1/assets/${original.id}`));
    expect(reloaded.asset).toEqual(original);
  });

  it("keeps each retry's media instead of overwriting the previous result", async () => {
    const body = {
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "same prompt every time",
      seed: 5,
      size: "64x64",
    };
    const first = await generate(body);
    const second = await generate(body);
    expect(first.final.outputs[0]?.storageUri).not.toBe(
      second.final.outputs[0]?.storageUri,
    );
  });
});

describe("reopening a recipe", () => {
  /*
   * Iterating on a shot means loading what made it, changing one thing, and
   * running it again. Anything the recipe drops silently becomes a change the
   * artist did not ask for — so the assertion is on the whole round trip, not
   * on the fields that happened to be easy to carry.
   *
   * Built through the repositories rather than by generating: the fields that
   * were being dropped are all video ones, and the mock video provider replays
   * a real file the repository does not ship. What is under test is the route's
   * reconstruction of a form, not the provider that filled it in.
   */
  async function storeGeneration(parameters: Record<string, unknown>) {
    const first = await captureFrame();
    const last = await captureFrame();
    const job = service.deps.jobs.create({
      provider: "mock-video",
      model: "mock-video-v1",
      operation: "video.generate",
      correlationId: "cor_test",
    });
    // Settled, so this stand-in does not read as work still to do.
    service.deps.jobs.update(job.id, { status: "succeeded" });
    const generation = service.deps.generations.create({
      provider: "mock-video",
      model: "mock-video-v1",
      operation: "video.generate",
      prompt: "a slow push through the doorway",
      seed: 7,
      parameters,
      inputAssetIds: [first.id, last.id],
      jobId: job.id,
    });
    const asset = service.deps.assets.create({
      kind: "video",
      filename: "mock-video_abcd1234_00.mp4",
      mimeType: "video/mp4",
      storageUri: "assets/generated/mock-video_abcd1234_00.mp4",
      generationId: generation.id,
      source: { type: "generated", provider: "mock-video", model: "mock-video-v1" },
    });
    return { generation, asset, first, last };
  }

  it("returns every field the form can set, including roles and audio", async () => {
    const { generation, asset, first, last } = await storeGeneration({
      size: "1920x1080",
      durationSeconds: 5,
      aspectRatio: "16:9",
      generateAudio: true,
      inputRoles: ["first", "last"],
    });

    const { recipe } = await readJson(
      await service.call(`/v1/assets/${asset.id}/recipe`),
    );

    expect(recipe).toMatchObject({
      providerId: "mock-video",
      operation: "video.generate",
      prompt: "a slow push through the doorway",
      seed: 7,
      size: "1920x1080",
      durationSeconds: 5,
      aspectRatio: "16:9",
      generateAudio: true,
      inputAssetIds: [first.id, last.id],
      inputRoles: ["first", "last"],
      parentAssetId: asset.id,
      parentGenerationId: generation.id,
    });
  });

  it("omits the switches that were off rather than reporting them false", async () => {
    const { asset } = await storeGeneration({ durationSeconds: 5 });

    const { recipe } = await readJson(
      await service.call(`/v1/assets/${asset.id}/recipe`),
    );
    expect(recipe.generateAudio).toBeUndefined();
    expect(recipe.inputRoles).toBeUndefined();
    expect(recipe.durationSeconds).toBe(5);
  });

  it("persists roles and the audio switch when a generation starts", async () => {
    const frame = await captureFrame();
    const { final } = await generate({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "a lighthouse at dusk",
      size: "64x64",
      inputAssetIds: [frame.id],
      inputRoles: ["reference"],
      generateAudio: true,
    });

    expect(final.generation?.parameters).toMatchObject({
      inputRoles: ["reference"],
      generateAudio: true,
    });
  });
});

describe("generation failures", () => {
  it("rejects a capability the provider has not declared", async () => {
    const response = await service.call("/v1/generations", {
      method: "POST",
      body: JSON.stringify({
        providerId: "mock-image",
        operation: "video.generate",
        prompt: "a dolly shot",
      }),
    });
    expect(response.status).toBe(422);
    expect((await readJson(response)).error.code).toBe("unsupported_capability");
  });

  it("rejects an unknown provider and an unknown input asset", async () => {
    const unknownProvider = await service.call("/v1/generations", {
      method: "POST",
      body: JSON.stringify({
        providerId: "seedance",
        operation: "video.generate",
        prompt: "x",
      }),
    });
    expect(unknownProvider.status).toBe(404);

    const unknownAsset = await service.call("/v1/generations", {
      method: "POST",
      body: JSON.stringify({
        providerId: "mock-image",
        operation: "image.generate",
        prompt: "x",
        inputAssetIds: ["ast_missing"],
      }),
    });
    expect(unknownAsset.status).toBe(404);
    // A job that could never run must not appear in history.
    const { jobs } = await readJson(await service.call("/v1/jobs?limit=100"));
    expect(jobs.every((job: { status: string }) => job.status !== "queued")).toBe(true);
  });

  it("records a provider failure without losing the recipe", async () => {
    const failing = await startTestService({
      registry: await failingRegistry(),
    });
    try {
      const response = await failing.call("/v1/generations", {
        method: "POST",
        body: JSON.stringify({
          providerId: "mock-image",
          operation: "image.generate",
          prompt: "please explode now",
        }),
      });
      const started = await readJson(response);
      await failing.deps.generation.whenSettled(started.job.id);

      const final = JobResponseSchema.parse(
        await readJson(await failing.call(`/v1/jobs/${started.job.id}`)),
      );
      expect(final.job.status).toBe("failed");
      expect(final.job.errorMessage).toContain("mock provider was asked to fail");
      expect(final.outputs).toHaveLength(0);
      // Provenance survives the failure.
      expect(final.generation?.prompt).toBe("please explode now");
      expect(final.generation?.status).toBe("failed");
    } finally {
      await failing.close();
    }
  });
});

async function failingRegistry() {
  const { MockImageProvider, ProviderRegistry } = await import("@seed-ae/providers");
  return new ProviderRegistry().register(
    new MockImageProvider({ failOnPromptContaining: "explode" }),
  );
}

describe("POST /v1/ae/import", () => {
  it("imports a generated asset and can insert it at the playhead", async () => {
    const { final } = await generate({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "hero plate",
      size: "64x64",
    });
    const asset = final.outputs[0];
    if (!asset) throw new Error("no output");

    const response = await service.call("/v1/ae/import", {
      method: "POST",
      body: JSON.stringify({ assetId: asset.id, insertAtPlayhead: true }),
    });
    expect(response.status).toBe(200);
    const imported = await readJson(response);
    expect(imported.insertedAtPlayhead).toBe(true);
    expect(imported.name).toBe(asset.filename);

    const host = service.deps.aeHost as unknown as {
      importedMedia: unknown[];
      insertions: Array<{ projectItemId: string }>;
    };
    expect(host.importedMedia.length).toBeGreaterThan(0);
    expect(host.insertions.at(-1)?.projectItemId).toBe(imported.projectItemId);
  });

  it("refuses to import an asset whose media is gone", async () => {
    const { asset } = await readJson(
      await service.call("/v1/assets", {
        method: "POST",
        body: JSON.stringify({
          kind: "image",
          filename: "vanished.png",
          mimeType: "image/png",
          storageUri: "assets/generated/vanished.png",
          source: { type: "imported" },
        }),
      }),
    );
    const response = await service.call("/v1/ae/import", {
      method: "POST",
      body: JSON.stringify({ assetId: asset.id }),
    });
    expect(response.status).toBe(404);
  });
});

describe("synchronous providers", () => {
  /**
   * Seedream answers inline rather than via polling. A provider-terminal state
   * is not a job-terminal state — the result still has to be downloaded and
   * registered — so a job must never report "succeeded" with no outputs.
   */
  it("does not report a job succeeded before its outputs are registered", async () => {
    const { encodePng } = await import("@seed-ae/media");
    const { ProviderRegistry } = await import("@seed-ae/providers");

    const png = encodePng(8, 8, new Uint8Array(8 * 8 * 4).fill(200));
    const syncProvider = {
      id: "sync-image",
      async capabilities() {
        return {
          id: "sync-image",
          displayName: "Synchronous",
          models: ["sync-v1"],
          operations: ["image.generate"],
          textToImage: true,
          imageToImage: false,
          maxImageReferences: 0,
          textToVideo: false,
          imageToVideo: false,
          videoReferences: false,
          startEndFrames: false,
          audioReferences: false,
          seed: false,
          sizes: [],
          aspectRatios: [],
          async: false,
        };
      },
      async generateImage() {
        // Terminal on submit, exactly like Seedream.
        return {
          providerJobId: "sync-1",
          state: {
            status: "succeeded" as const,
            outputs: [{ mimeType: "image/png", base64: png.toString("base64") }],
          },
        };
      },
      async getJob() {
        return { status: "succeeded" as const };
      },
    };

    const service = await startTestService({
      registry: new ProviderRegistry().register(syncProvider as never),
    });
    try {
      const started = await readJson(
        await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "sync-image",
            operation: "image.generate",
            prompt: "a grey swatch",
          }),
        }),
      );

      // Observed immediately after submission, the job must not claim success.
      const early = await readJson(await service.call(`/v1/jobs/${started.job.id}`));
      expect(["queued", "running"]).toContain(early.job.status);
      expect(early.outputs).toHaveLength(0);

      await service.deps.generation.whenSettled(started.job.id);
      const final = JobResponseSchema.parse(
        await readJson(await service.call(`/v1/jobs/${started.job.id}`)),
      );
      expect(final.job.status).toBe("succeeded");
      expect(final.outputs).toHaveLength(1);
      expect(final.outputs[0]?.width).toBe(8);
    } finally {
      await service.close();
    }
  });
});

describe("how a reference is addressed", () => {
  /**
   * `addressing` was declared by every adapter and read by none of them: the
   * service picked the form from a hard-coded list of provider ids, so a new
   * provider silently got raw base64 whatever it said it accepted.
   *
   * That is invisible until the provider is one that only takes links — as
   * IC-Light and Reframe are — and then the first real generation fails with
   * "needs a fetchable URL" for a reference the service could have hosted.
   */
  it("hosts a reference for a provider that only takes links", async () => {
    const { ProviderRegistry } = await import("@seed-ae/providers");

    const linksOnly = {
      id: "links-only",
      async capabilities() {
        return {
          id: "links-only",
          displayName: "Links only",
          models: ["links-v1"],
          operations: ["image.edit"],
          textToImage: false,
          imageToImage: true,
          maxImageReferences: 1,
          // The whole point of the fixture: inline is not on the list.
          addressing: ["hosted-url"],
          textToVideo: false,
          imageToVideo: false,
          videoReferences: false,
          startEndFrames: false,
          audioReferences: false,
          seed: false,
          sizes: [],
          aspectRatios: [],
          async: false,
        };
      },
      async editImage() {
        throw new Error("the reference never reached the adapter");
      },
      async getJob() {
        return { status: "succeeded" as const };
      },
    };

    const service = await startTestService({
      registry: new ProviderRegistry().register(linksOnly as never),
    });
    try {
      const { asset } = await readJson(
        await service.call("/v1/ae/capture-frame", { method: "POST", body: "{}" }),
      );

      const { job } = await readJson(
        await service.call("/v1/generations", {
          method: "POST",
          body: JSON.stringify({
            providerId: "links-only",
            operation: "image.edit",
            prompt: "warm window light from the left",
            inputAssetIds: [asset.id],
          }),
        }),
      );
      await service.deps.generation.whenSettled(job.id);

      const settled = await readJson(await service.call(`/v1/jobs/${job.id}`));
      expect(settled.job.status).toBe("failed");
      /*
       * No bucket is configured in a test workspace, so hosting cannot
       * succeed — and that is exactly the assertion. The service tried to
       * host and said which four settings would let it, rather than handing
       * over base64 and letting the adapter refuse it downstream.
       */
      expect(settled.job.errorMessage).toMatch(/SEED_R2_ENDPOINT/);
    } finally {
      await service.close();
    }
  });
});
