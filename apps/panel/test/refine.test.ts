import { describe, expect, it } from "vitest";
import type { Asset } from "@seed-ae/domain";
import { resolveRefineTarget } from "../src/refine.ts";

function asset(overrides: Partial<Asset> & { filename: string }): Asset {
  return {
    id: `ast_${overrides.filename}`,
    kind: "video",
    status: "ready",
    mimeType: "video/mp4",
    storageUri: `assets/generated/${overrides.filename}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    source: { type: "generated", provider: "seedance", model: "seedance-2-5" },
    ...overrides,
  } as Asset;
}

const GENERATED = asset({
  filename: "seedance_ab12cd34_00.mp4",
  generationId: "gen_ab12cd34",
});

describe("resolveRefineTarget", () => {
  it("finds the generation behind a layer's media", () => {
    const found = resolveRefineTarget(
      { filename: "seedance_ab12cd34_00.mp4", layerName: "shot_04" },
      [asset({ filename: "other.mp4", generationId: "gen_other" }), GENERATED],
    );
    expect(found).toEqual({ ok: true, asset: GENERATED });
  });

  it("matches regardless of case, because Windows paths do", () => {
    const found = resolveRefineTarget(
      { filename: "SEEDANCE_AB12CD34_00.MP4", layerName: "shot_04" },
      [GENERATED],
    );
    expect(found.ok).toBe(true);
  });

  it("says so when the layer did not come from SEED", () => {
    const found = resolveRefineTarget(
      { filename: "plate_from_editorial.mov", layerName: "plate" },
      [GENERATED],
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.reason).toContain("did not come from SEED");
  });

  it("distinguishes a captured frame from a generation", () => {
    /*
     * The difference matters: a capture is in the library and looks identical
     * on a card, but nothing made it, so there is no prompt to reopen. Telling
     * the artist to use it as a reference is the actionable half of that.
     */
    const capture = asset({
      filename: "comp_1_f00120_001.png",
      kind: "image",
      mimeType: "image/png",
      source: {
        type: "after-effects",
        context: {},
      } as Asset["source"],
    });
    delete (capture as { generationId?: string }).generationId;

    const found = resolveRefineTarget(
      { filename: "comp_1_f00120_001.png", layerName: "comp_1_f00120_001" },
      [capture],
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.reason).toContain("captured frame");
    expect(found.reason).toContain("reference");
  });

  it("prefers the newest generation when a filename is not unique", () => {
    const older = asset({
      filename: "dup.mp4",
      id: "ast_older",
      generationId: "gen_older",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    const newer = asset({
      filename: "dup.mp4",
      id: "ast_newer",
      generationId: "gen_newer",
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    const found = resolveRefineTarget(
      { filename: "dup.mp4", layerName: "dup" },
      [older, newer],
    );
    expect(found.ok && found.asset.id).toBe("ast_newer");
  });

  it("handles a layer with no file behind it", () => {
    const found = resolveRefineTarget(
      { filename: "   ", layerName: "Solid 1" },
      [GENERATED],
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.reason).toContain("no file behind it");
  });
});
