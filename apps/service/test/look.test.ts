import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AssetSchema, JobResponseSchema } from "@seed-ae/domain";
import { decodePng } from "@seed-ae/media";
import { LookProvider, ProviderRegistry } from "@seed-ae/providers";
import { MockImageProvider } from "@seed-ae/providers";
import { readJson, startTestService, type TestService } from "./helpers.js";

let service: TestService;

beforeAll(async () => {
  service = await startTestService({
    registry: new ProviderRegistry()
      .register(new LookProvider())
      .register(new MockImageProvider({ latencyMs: 0, sizes: ["320x180"] })),
  });
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

/*
 * A small source for the tests that are about behaviour rather than scale.
 *
 * The mock host captures at 1920x1080 and the full chain takes around three
 * and a half seconds on that — fine for a background bake, far too slow to pay
 * eight times over in a suite. One test below uses a real capture; the rest
 * use a 320x180 frame, which exercises exactly the same path.
 */
async function smallSource() {
  const response = await service.call("/v1/generations", {
    method: "POST",
    body: JSON.stringify({
      providerId: "mock-image",
      operation: "image.generate",
      prompt: "a plate to treat",
      size: "320x180",
    }),
  });
  const started = await readJson(response);
  await service.deps.generation.whenSettled(started.job.id);
  const final = JobResponseSchema.parse(
    await readJson(await service.call(`/v1/jobs/${started.job.id}`)),
  );
  const output = final.outputs[0];
  if (!output) throw new Error("no small source");
  return output;
}

async function applyLook(body: Record<string, unknown>) {
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

describe("the film look as a provider", () => {
  it("is offered without any credential", async () => {
    /*
     * The one provider that cannot be misconfigured: no key, no network, no
     * model id to get wrong. It should therefore always be in the list.
     */
    const { providers } = await readJson(await service.call("/v1/providers"));
    const look = providers.find((p: { id: string }) => p.id === "film-look");
    expect(look).toBeDefined();
    expect(look.operations).toEqual(["image.edit"]);
    expect(look.models).toContain("show-match");
    // One input, and it is the subject: the service takes inputs[0] as the
    // image to edit and counts every input against this cap.
    expect(look.maxImageReferences).toBe(1);
  });

  it("treats a captured frame and registers the result as its child", async () => {
    const frame = await captureFrame();

    const { final } = await applyLook({
      providerId: "film-look",
      model: "show-match",
      operation: "image.edit",
      prompt: "Show match at full camera",
      inputAssetIds: [frame.id],
      parameters: { intensity: 2 },
    });

    expect(final.job.status).toBe("succeeded");
    const output = final.outputs[0];
    if (!output) throw new Error("no output");

    // Same picture, same size, different pixels.
    expect(output.width).toBe(frame.width);
    expect(output.height).toBe(frame.height);
    expect(output.id).not.toBe(frame.id);
    expect(final.generation?.inputAssetIds).toEqual([frame.id]);

    const before = await service.call(`/v1/assets/${frame.id}/file`);
    const after = await service.call(`/v1/assets/${output.id}/file`);
    const beforeBytes = Buffer.from(await before.arrayBuffer());
    const afterBytes = Buffer.from(await after.arrayBuffer());
    expect(afterBytes.equals(beforeBytes)).toBe(false);

    const decoded = decodePng(afterBytes);
    expect(decoded?.width).toBe(frame.width);
  }, 20_000);

  it("keeps the source frame untouched", async () => {
    // Assets are immutable and a treatment is a descendant. Losing the
    // original would make the look a one-way door.
    const frame = await smallSource();
    const originalBytes = Buffer.from(
      await (await service.call(`/v1/assets/${frame.id}/file`)).arrayBuffer(),
    );

    await applyLook({
      providerId: "film-look",
      model: "show-match",
      operation: "image.edit",
      prompt: "Show match",
      inputAssetIds: [frame.id],
    });

    const reloaded = await readJson(await service.call(`/v1/assets/${frame.id}`));
    expect(reloaded.asset).toEqual(frame);
    const afterBytes = Buffer.from(
      await (await service.call(`/v1/assets/${frame.id}/file`)).arrayBuffer(),
    );
    expect(afterBytes.equals(originalBytes)).toBe(true);
  });

  it("reopens as a recipe carrying the preset and the intensity", async () => {
    const frame = await smallSource();
    const { final } = await applyLook({
      providerId: "film-look",
      model: "print-2383",
      operation: "image.edit",
      prompt: "2383 print, half camera",
      inputAssetIds: [frame.id],
      parameters: { intensity: 0.5, look: { sharpen: 0.3 } },
    });

    const output = final.outputs[0];
    if (!output) throw new Error("no output");

    const { recipe } = await readJson(
      await service.call(`/v1/assets/${output.id}/recipe`),
    );
    expect(recipe.providerId).toBe("film-look");
    expect(recipe.model).toBe("print-2383");
    expect(recipe.parameters.intensity).toBe(0.5);
    expect(recipe.parameters.look).toEqual({ sharpen: 0.3 });
    expect(recipe.parentAssetId).toBe(output.id);
  });

  it("is deterministic — the same treatment twice gives the same pixels", async () => {
    /*
     * The property that makes a look reproducible rather than merely
     * repeatable. Grain is seeded from the config, so two runs of one recipe
     * must agree exactly.
     */
    const frame = await smallSource();
    const body = {
      providerId: "film-look",
      model: "tungsten-500t",
      operation: "image.edit",
      prompt: "500T",
      inputAssetIds: [frame.id],
    };

    const first = await applyLook(body);
    const second = await applyLook(body);

    const bytesOf = async (id: string) =>
      Buffer.from(await (await service.call(`/v1/assets/${id}/file`)).arrayBuffer());

    const a = await bytesOf(first.final.outputs[0]!.id);
    const b = await bytesOf(second.final.outputs[0]!.id);
    expect(a.equals(b)).toBe(true);

    // ...and still written as two separate files, never overwritten.
    expect(first.final.outputs[0]!.storageUri).not.toBe(
      second.final.outputs[0]!.storageUri,
    );
  });

  it("can be applied to its own output, so looks stack knowingly", async () => {
    const frame = await smallSource();
    const once = await applyLook({
      providerId: "film-look",
      model: "show-match",
      operation: "image.edit",
      prompt: "pass one",
      inputAssetIds: [frame.id],
    });
    const first = once.final.outputs[0];
    if (!first) throw new Error("no output");

    const twice = await applyLook({
      providerId: "film-look",
      model: "show-match",
      operation: "image.edit",
      prompt: "pass two",
      inputAssetIds: [first.id],
    });
    expect(twice.final.job.status).toBe("succeeded");

    // The lineage records that this is a grandchild, not a sibling.
    const lineage = await readJson(
      await service.call(`/v1/assets/${twice.final.outputs[0]!.id}/lineage`),
    );
    expect(lineage.assets.map((a: { id: string }) => a.id)).toContain(frame.id);
  });

  it("rejects an unknown preset before doing any work", async () => {
    /*
     * Better than it needed to be: preset ids are declared as the provider's
     * models, so the registry refuses one that does not exist at submit rather
     * than starting a job that is certain to fail.
     */
    const frame = await smallSource();
    const response = await service.call("/v1/generations", {
      method: "POST",
      body: JSON.stringify({
        providerId: "film-look",
        model: "no-such-preset",
        operation: "image.edit",
        prompt: "nope",
        inputAssetIds: [frame.id],
      }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await readJson(response))).toMatch(/no-such-preset/);
  });

  it("refuses to run without an input frame", async () => {
    // It edits an image; it cannot invent one. The submission is accepted and
    // the job fails, which is where every other provider reports the same
    // class of problem — worth knowing rather than assuming a 4xx.
    const { final } = await applyLook({
      providerId: "film-look",
      model: "show-match",
      operation: "image.edit",
      prompt: "from nothing",
      inputAssetIds: [],
    });
    expect(final.job.status).toBe("failed");
    expect(final.job.errorMessage).toMatch(/requires an input asset/);
  });
});
