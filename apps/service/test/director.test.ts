import { describe, expect, it } from "vitest";
import type { Asset } from "@seed-ae/domain";
import type { ProviderCapabilities } from "@seed-ae/providers";
import { planFromDraft, type DraftPlan } from "../src/agent/director.js";

const IMAGE_PROVIDER: ProviderCapabilities = {
  id: "seedream",
  displayName: "Seedream",
  models: ["seedream-4-0"],
  operations: ["image.generate", "image.edit"],
  textToImage: true,
  imageToImage: true,
  maxImageReferences: 2,
  stableImageReferences: 2,
  addressing: ["hosted-url"],
  nativeGrouping: false,
  requiresBindingText: false,
  mentionSyntax: "positional-en",
  supportsNegativePrompt: false,
  textToVideo: false,
  imageToVideo: false,
  videoReferences: false,
  startEndFrames: false,
  framesExcludeReferences: false,
  audioReferences: false,
  generatesAudio: false,
  seed: true,
  sizes: ["2048x2048", "1920x1080"],
  aspectRatios: [],
  async: false,
};

const VIDEO_PROVIDER: ProviderCapabilities = {
  id: "seedance",
  displayName: "Seedance",
  models: ["seedance-2-5"],
  operations: ["video.generate"],
  textToImage: false,
  imageToImage: false,
  maxImageReferences: 1,
  stableImageReferences: 1,
  addressing: ["hosted-url"],
  nativeGrouping: false,
  requiresBindingText: false,
  mentionSyntax: "positional-en",
  supportsNegativePrompt: false,
  textToVideo: true,
  imageToVideo: true,
  videoReferences: false,
  startEndFrames: true,
  framesExcludeReferences: false,
  audioReferences: false,
  generatesAudio: true,
  seed: false,
  durationSecondsRange: [4, 12],
  sizes: ["720p"],
  aspectRatios: ["16:9", "9:16"],
  async: true,
};

const MOCK_PROVIDER: ProviderCapabilities = {
  ...IMAGE_PROVIDER,
  id: "mock-image",
  displayName: "Mock image",
  models: ["mock-image-v1"],
};

function asset(id: string): Asset {
  return {
    id,
    kind: "image",
    status: "ready",
    filename: `${id}.png`,
    mimeType: "image/png",
    storageUri: `assets/originals/${id}.png`,
    createdAt: "2026-08-10T00:00:00.000Z",
    source: { type: "after-effects" },
  } as Asset;
}

function draft(overrides: Partial<DraftPlan> = {}): DraftPlan {
  return {
    mediaKind: "image",
    intent: "new",
    prompt: "a bar at night",
    negativePrompt: null,
    references: [],
    size: null,
    aspectRatio: null,
    durationSeconds: null,
    seed: null,
    rationale: "because",
    concerns: [],
    ...overrides,
  };
}

describe("planFromDraft", () => {
  it("labels references by position, in the order the model chose", () => {
    const candidates = [asset("a"), asset("b"), asset("c")];
    const plan = planFromDraft(
      draft({
        references: [
          { candidateIndex: 3, role: "the plate" },
          { candidateIndex: 1, role: "the palette" },
        ],
      }),
      [IMAGE_PROVIDER],
      candidates,
    );

    expect(plan.references).toEqual([
      { assetId: "c", label: "Image 1", role: "the plate" },
      { assetId: "a", label: "Image 2", role: "the palette" },
    ]);
  });

  it("ignores a candidate index that was never offered", () => {
    const plan = planFromDraft(
      draft({ references: [{ candidateIndex: 9, role: "invented" }] }),
      [IMAGE_PROVIDER],
      [asset("a")],
    );
    expect(plan.references).toEqual([]);
  });

  it("drops duplicate references rather than paying for the same frame twice", () => {
    const plan = planFromDraft(
      draft({
        references: [
          { candidateIndex: 1, role: "first" },
          { candidateIndex: 1, role: "again" },
        ],
      }),
      [IMAGE_PROVIDER],
      [asset("a")],
    );
    expect(plan.references).toHaveLength(1);
  });

  it("says so when it has to drop references the provider cannot take", () => {
    const plan = planFromDraft(
      draft({
        references: [
          { candidateIndex: 1, role: "one" },
          { candidateIndex: 2, role: "two" },
          { candidateIndex: 3, role: "three" },
        ],
      }),
      [IMAGE_PROVIDER],
      [asset("a"), asset("b"), asset("c")],
    );

    expect(plan.references).toHaveLength(2);
    expect(plan.warnings.join(" ")).toContain("three");
  });

  it("routes a video description to the video provider", () => {
    const plan = planFromDraft(
      draft({ mediaKind: "video", durationSeconds: 6 }),
      [IMAGE_PROVIDER, VIDEO_PROVIDER],
      [],
    );

    expect(plan.providerId).toBe("seedance");
    expect(plan.model).toBe("seedance-2-5");
    expect(plan.operation).toBe("video.generate");
    expect(plan.durationSeconds).toBe(6);
  });

  it("prefers a real provider over a mock that could also serve", () => {
    const plan = planFromDraft(draft(), [MOCK_PROVIDER, IMAGE_PROVIDER], []);
    expect(plan.providerId).toBe("seedream");
  });

  it("honours a preferred provider that can do the work", () => {
    const plan = planFromDraft(
      draft(),
      [IMAGE_PROVIDER, MOCK_PROVIDER],
      [],
      "mock-image",
    );
    expect(plan.providerId).toBe("mock-image");
  });

  it("overrides a preference that cannot do the work, and explains why", () => {
    const plan = planFromDraft(
      draft({ mediaKind: "video" }),
      [IMAGE_PROVIDER, VIDEO_PROVIDER],
      [],
      "seedream",
    );

    expect(plan.providerId).toBe("seedance");
    expect(plan.warnings.join(" ")).toContain("seedream");
  });

  it("refuses rather than silently generating the wrong medium", () => {
    expect(() =>
      planFromDraft(draft({ mediaKind: "video" }), [IMAGE_PROVIDER], []),
    ).toThrow(/no configured provider can generate video/);
  });

  it("clamps a duration outside the provider's range and reports it", () => {
    const plan = planFromDraft(
      draft({ mediaKind: "video", durationSeconds: 30 }),
      [VIDEO_PROVIDER],
      [],
    );

    expect(plan.durationSeconds).toBe(12);
    expect(plan.warnings.join(" ")).toContain("30s");
  });

  it("keeps a size the provider offers and drops one it does not", () => {
    const kept = planFromDraft(draft({ size: "1920x1080" }), [IMAGE_PROVIDER], []);
    expect(kept.size).toBe("1920x1080");

    const dropped = planFromDraft(draft({ size: "3000x3000" }), [IMAGE_PROVIDER], []);
    expect(dropped.size).toBeUndefined();
    expect(dropped.warnings.join(" ")).toContain("3000x3000");
  });

  it("drops a seed the provider cannot accept", () => {
    const plan = planFromDraft(
      draft({ mediaKind: "video", seed: 42 }),
      [VIDEO_PROVIDER],
      [],
    );
    expect(plan.seed).toBeUndefined();
    expect(plan.warnings.join(" ")).toContain("seed");
  });

  it("only edits when there is something to edit", () => {
    const withReference = planFromDraft(
      draft({ intent: "edit", references: [{ candidateIndex: 1, role: "plate" }] }),
      [IMAGE_PROVIDER],
      [asset("a")],
    );
    expect(withReference.operation).toBe("image.edit");

    const without = planFromDraft(
      draft({ intent: "edit" }),
      [IMAGE_PROVIDER],
      [],
    );
    expect(without.operation).toBe("image.generate");
  });

  it("carries the model's own concerns through to the artist", () => {
    const plan = planFromDraft(
      draft({ concerns: ["she is already facing camera"] }),
      [IMAGE_PROVIDER],
      [],
    );
    expect(plan.warnings).toContain("she is already facing camera");
  });
});
