import { describe, expect, it } from "vitest";
import type { Asset } from "@seed-ae/domain";
import {
  aspectOf,
  closestAspect,
  describeAspect,
  parseAspect,
  regionShapeOptions,
} from "../src/aspect.ts";

describe("parseAspect", () => {
  it("reads both vocabularies providers use", () => {
    expect(parseAspect("16:9")).toBeCloseTo(1.778, 3);
    expect(parseAspect("1920x1080")).toBeCloseTo(1.778, 3);
    expect(parseAspect("1:1")).toBe(1);
    expect(parseAspect("9:16")).toBeCloseTo(0.5625, 4);
  });

  it("declines options that name a resolution or a policy, not a shape", () => {
    // "2K" says how many pixels, "adaptive" says the model decides.
    for (const option of ["2K", "4K", "720p", "480p", "adaptive", ""]) {
      expect(parseAspect(option)).toBeUndefined();
    }
  });
});

describe("closestAspect", () => {
  const RATIOS = ["16:9", "9:16", "1:1", "4:3", "21:9"];

  it("matches a square plate to the square option", () => {
    expect(closestAspect(RATIOS, 1)).toBe("1:1");
  });

  it("matches a tall plate to the tall option", () => {
    // 2048x6144 — the strip this was built for.
    expect(closestAspect(RATIOS, 2048 / 6144)).toBe("9:16");
  });

  it("treats twice-as-wide and half-as-wide as equally far", () => {
    // On a raw quotient these would not tie, and everything narrow would lose.
    expect(closestAspect(["2:1", "1:2"], 1)).toBe("2:1");
    expect(closestAspect(["1:2", "2:1"], 1)).toBe("1:2");
  });

  it("ignores options that are not shapes at all", () => {
    expect(closestAspect(["2K", "720p", "4:3"], 1.34)).toBe("4:3");
    expect(closestAspect(["2K", "720p"], 1.34)).toBeUndefined();
  });

  it("picks a size when that is how the provider speaks", () => {
    const sizes = ["1024x1024", "1920x1080", "1080x1920"];
    expect(closestAspect(sizes, 1)).toBe("1024x1024");
    expect(closestAspect(sizes, 0.6)).toBe("1080x1920");
  });
});

describe("aspectOf", () => {
  const asset = (width?: number, height?: number) =>
    ({ id: "a", width, height }) as Asset;

  it("is undefined when the asset does not know its own size", () => {
    expect(aspectOf(undefined)).toBeUndefined();
    expect(aspectOf(asset())).toBeUndefined();
    expect(aspectOf(asset(1920))).toBeUndefined();
  });

  it("reads a known frame", () => {
    expect(aspectOf(asset(1920, 1080))).toBeCloseTo(1.778, 3);
  });
});

describe("describeAspect", () => {
  it("says what an artist would say", () => {
    expect(describeAspect(1)).toBe("square");
    expect(describeAspect(1.778)).toBe("1.78:1 wide");
    expect(describeAspect(0.5625)).toBe("1:1.78 tall");
  });
});
describe("regionShapeOptions", () => {
  const seedance = {
    id: "seedance",
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "21:9", "adaptive"],
  };
  const seedream = { id: "seedream", aspectRatios: ["1:1", "16:9", "9:16", "21:9"] };
  // The film look treats an image rather than framing one, so it offers no
  // shapes at all. Correct of it, and the reason this function exists.
  const look = { id: "look", aspectRatios: [] };

  it("still offers shapes when the selected provider has none", () => {
    expect(regionShapeOptions([seedance, seedream, look], "look")).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "21:9",
    ]);
  });

  it("puts the selected provider's shapes first, and never repeats one", () => {
    expect(regionShapeOptions([seedream, seedance], "seedance")).toEqual([
      "16:9",
      "9:16",
      "1:1",
      "4:3",
      "21:9",
    ]);
  });

  it("drops a policy that is not a shape", () => {
    expect(regionShapeOptions([seedance], "seedance")).not.toContain("adaptive");
  });

  it("keeps the shape a region is actually held at", () => {
    // Otherwise the select falls back to its first option and a held region
    // reads as Free — a wrong answer, where an absent one would be honest.
    expect(regionShapeOptions([look], "look", "4:3")).toEqual(["4:3"]);
    expect(regionShapeOptions([seedream], "seedream", "4:3")).toContain("4:3");
  });

  it("has nothing to offer when nothing is loaded", () => {
    expect(regionShapeOptions([], undefined)).toEqual([]);
  });
});
