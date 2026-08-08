import { beforeEach, describe, expect, it } from "vitest";
import type { AssetDraft } from "@seed-ae/domain";
import {
  AssetRepository,
  GenerationRepository,
  JobRepository,
  buildLineage,
  openMigratedDatabase,
  type Database,
} from "../src/index.js";

let db: Database;
let assets: AssetRepository;
let generations: GenerationRepository;
let jobs: JobRepository;

const imageDraft = (filename: string): AssetDraft => ({
  kind: "image",
  filename,
  mimeType: "image/png",
  storageUri: `assets/originals/${filename}`,
  source: { type: "imported" },
});

beforeEach(() => {
  db = openMigratedDatabase({ path: ":memory:" });
  assets = new AssetRepository(db);
  generations = new GenerationRepository(db);
  jobs = new JobRepository(db);
});

describe("GenerationRepository", () => {
  it("round-trips a recipe including raw payloads", () => {
    const input = assets.create(imageDraft("frame.png"));
    const job = jobs.create({
      provider: "mock-image",
      model: "m",
      operation: "image.edit",
      correlationId: "cor_1",
    });

    const created = generations.create({
      provider: "mock-image",
      model: "m",
      operation: "image.edit",
      prompt: "night version",
      seed: 42,
      parameters: { size: "64x64" },
      inputAssetIds: [input.id],
      parentAssetId: input.id,
      jobId: job.id,
      rawRequest: { body: { prompt: "night version" } },
    });

    const loaded = generations.requireById(created.id);
    expect(loaded.prompt).toBe("night version");
    expect(loaded.seed).toBe("42");
    expect(loaded.parameters).toEqual({ size: "64x64" });
    expect(loaded.inputAssetIds).toEqual([input.id]);
    expect(loaded.rawRequest).toEqual({ body: { prompt: "night version" } });
    expect(loaded.status).toBe("queued");
  });

  it("records a terminal outcome without discarding the recipe", () => {
    const job = jobs.create({
      provider: "p",
      model: "m",
      operation: "image.generate",
      correlationId: "c",
    });
    const generation = generations.create({
      provider: "p",
      model: "m",
      operation: "image.generate",
      prompt: "keep me",
      jobId: job.id,
    });

    const failed = generations.complete(generation.id, {
      status: "failed",
      errorClass: "provider_error",
      errorMessage: "boom",
      rawResponse: { detail: "boom" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.prompt).toBe("keep me");
    expect(failed.errorMessage).toBe("boom");
    expect(failed.completedAt).toBeDefined();
  });

  it("refuses to insert a generation whose input asset does not exist", () => {
    const job = jobs.create({
      provider: "p",
      model: "m",
      operation: "image.generate",
      correlationId: "c",
    });
    expect(() =>
      generations.create({
        provider: "p",
        model: "m",
        operation: "image.generate",
        prompt: "x",
        inputAssetIds: ["ast_nope"],
        jobId: job.id,
      }),
    ).toThrow(/could not record generation/);
  });
});

describe("JobRepository", () => {
  it("stamps completedAt once a job reaches a terminal state", () => {
    const job = jobs.create({
      provider: "p",
      model: "m",
      operation: "image.generate",
      correlationId: "c",
    });
    expect(job.completedAt).toBeUndefined();

    const running = jobs.update(job.id, { status: "running", progress: 0.5 });
    expect(running.completedAt).toBeUndefined();
    expect(jobs.listUnfinished().map((j) => j.id)).toEqual([job.id]);

    const done = jobs.update(job.id, { status: "succeeded", progress: 1 });
    expect(done.completedAt).toBeDefined();
    expect(jobs.listUnfinished()).toHaveLength(0);
  });
});

describe("buildLineage", () => {
  it("walks a two-generation chain in both directions", () => {
    const source = assets.create(imageDraft("source.png"));

    const makeGeneration = (inputId: string, prompt: string) => {
      const job = jobs.create({
        provider: "p",
        model: "m",
        operation: "image.edit",
        correlationId: "c",
      });
      const generation = generations.create({
        provider: "p",
        model: "m",
        operation: "image.edit",
        prompt,
        inputAssetIds: [inputId],
        parentAssetId: inputId,
        jobId: job.id,
      });
      const output = assets.create({
        ...imageDraft(`${prompt}.png`),
        generationId: generation.id,
        source: { type: "generated", provider: "p", model: "m" },
      });
      generations.complete(generation.id, {
        status: "succeeded",
        outputAssetIds: [output.id],
      });
      return output;
    };

    const child = makeGeneration(source.id, "child");
    const grandchild = makeGeneration(child.id, "grandchild");

    const fromRoot = buildLineage(assets, generations, source.id);
    expect(fromRoot.assets.map((a) => a.id).sort()).toEqual(
      [source.id, child.id, grandchild.id].sort(),
    );
    expect(fromRoot.edges).toHaveLength(2);

    // The middle node sees both its ancestor and its descendant.
    const fromMiddle = buildLineage(assets, generations, child.id);
    expect(fromMiddle.assets.map((a) => a.id).sort()).toEqual(
      [source.id, child.id, grandchild.id].sort(),
    );
  });

  it("returns a lone node for an asset with no generations", () => {
    const orphan = assets.create(imageDraft("orphan.png"));
    const graph = buildLineage(assets, generations, orphan.id);
    expect(graph.assets).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.generations).toHaveLength(0);
  });
});
