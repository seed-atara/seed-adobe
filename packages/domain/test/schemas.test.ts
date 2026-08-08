import { describe, expect, it } from "vitest";
import {
  AssetSchema,
  CaptureFrameRequestSchema,
  GenerationSchema,
  ID_PREFIX,
  SeedError,
  assetKindFromMimeType,
  isId,
  isIsoTimestamp,
  newId,
  nowIso,
  toSeedError,
} from "../src/index.js";

const aeAsset = {
  id: "ast_1",
  kind: "image",
  status: "ready",
  filename: "HERO_f00060.png",
  mimeType: "image/png",
  storageUri: "assets/originals/HERO_f00060.png",
  createdAt: "2026-08-08T10:00:00.000Z",
  source: {
    type: "after-effects",
    context: { compName: "HERO", width: 1920, height: 1080, fps: 24 },
  },
};

describe("ids", () => {
  it("mints prefixed ids that round-trip through isId", () => {
    const id = newId("asset");
    expect(id.startsWith(`${ID_PREFIX.asset}_`)).toBe(true);
    expect(isId("asset", id)).toBe(true);
    expect(isId("generation", id)).toBe(false);
    expect(newId("asset")).not.toBe(id);
  });
});

describe("time", () => {
  it("accepts nowIso and rejects non-UTC or malformed stamps", () => {
    expect(isIsoTimestamp(nowIso())).toBe(true);
    expect(isIsoTimestamp("2026-08-08T10:00:00+02:00")).toBe(false);
    expect(isIsoTimestamp("2026-08-08")).toBe(false);
    expect(isIsoTimestamp("2026-13-08T10:00:00.000Z")).toBe(false);
  });
});

describe("AssetSchema", () => {
  it("accepts an After Effects capture", () => {
    const parsed = AssetSchema.parse(aeAsset);
    expect(parsed.source.type).toBe("after-effects");
  });

  it("rejects a timestamp that is not ISO-8601 UTC", () => {
    expect(() =>
      AssetSchema.parse({ ...aeAsset, createdAt: "8 August 2026" }),
    ).toThrow();
  });

  it("rejects an unknown source type", () => {
    expect(() =>
      AssetSchema.parse({ ...aeAsset, source: { type: "dropbox" } }),
    ).toThrow();
  });

  it("maps mime types onto asset kinds", () => {
    expect(assetKindFromMimeType("image/png")).toBe("image");
    expect(assetKindFromMimeType("video/quicktime")).toBe("video");
    expect(assetKindFromMimeType("audio/wav")).toBe("audio");
    expect(assetKindFromMimeType("application/json")).toBe("other");
  });
});

describe("GenerationSchema", () => {
  it("defaults the collection fields so a recipe is always complete", () => {
    const generation = GenerationSchema.parse({
      id: "gen_1",
      provider: "seedream",
      model: "configured-at-runtime",
      operation: "image.generate",
      prompt: "a lighthouse at dusk",
      jobId: "job_1",
      status: "queued",
      createdAt: "2026-08-08T10:00:00.000Z",
    });
    expect(generation.parameters).toEqual({});
    expect(generation.inputAssetIds).toEqual([]);
    expect(generation.outputAssetIds).toEqual([]);
  });

  it("rejects an operation no provider capability covers", () => {
    expect(() =>
      GenerationSchema.parse({
        id: "gen_1",
        provider: "seedance",
        model: "unverified",
        operation: "video.upscale",
        prompt: "",
        jobId: "job_1",
        status: "queued",
        createdAt: "2026-08-08T10:00:00.000Z",
      }),
    ).toThrow();
  });
});

describe("CaptureFrameRequestSchema", () => {
  it("defaults to an opaque PNG", () => {
    expect(CaptureFrameRequestSchema.parse({})).toEqual({
      format: "png",
      includeAlpha: false,
    });
  });
});

describe("SeedError", () => {
  it("maps error codes onto HTTP statuses", () => {
    expect(new SeedError("not_found", "x").httpStatus).toBe(404);
    expect(new SeedError("unauthorized", "x").httpStatus).toBe(401);
    expect(new SeedError("provider_error", "x").httpStatus).toBe(502);
    expect(new SeedError("internal_error", "x").httpStatus).toBe(500);
  });

  it("wraps unknown throwables without losing the message", () => {
    const wrapped = toSeedError(new TypeError("boom"));
    expect(wrapped.code).toBe("internal_error");
    expect(wrapped.message).toBe("boom");
    expect(toSeedError(new SeedError("not_found", "keep")).code).toBe("not_found");
  });
});
