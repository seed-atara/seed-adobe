import { describe, expect, it } from "vitest";
import { bestQualitySize, largestSize } from "../src/quality.js";

describe("choosing a size for quality", () => {
  it("takes the top of a resolution ladder", () => {
    // Seedance 2.5. The first entry is 480p — 8-bit, no colour signalling —
    // and the top is 10-bit and fully tagged, so this is a real difference.
    expect(bestQualitySize(["480p", "720p", "1080p"])).toBe("1080p");
  });

  it("understands the K tiers, and ranks them above the p ones", () => {
    expect(bestQualitySize(["480p", "720p", "1080p", "4K"])).toBe("4K");
    expect(bestQualitySize(["2K", "4K"])).toBe("4K");
  });

  it("declines where a size carries a shape rather than a tier", () => {
    /*
     * Seedream's list. 2160x3840 has the most pixels and is portrait; picking
     * it would be choosing a frame shape for the artist, which is a creative
     * decision wearing a quality costume.
     */
    expect(
      bestQualitySize(["1280x720", "1920x1080", "2048x2048", "2160x3840"]),
    ).toBeUndefined();
  });

  it("declines a mixed list rather than guessing at it", () => {
    expect(bestQualitySize(["720p", "1920x1080"])).toBeUndefined();
  });

  it("has nothing to say about an empty list", () => {
    expect(bestQualitySize([])).toBeUndefined();
  });
});

describe("the largest size for a frame whose shape is known", () => {
  it("prefers a tier, so the aspect follows the source", () => {
    // Seedream mixes tiers with explicit sizes. bestQualitySize declines on
    // that, which meant no size was sent and a "4K" render came back at
    // 2848x1600.
    expect(largestSize(["2K", "4K", "1920x1080", "2160x3840"], 16 / 9)).toBe("4K");
    expect(largestSize(["480p", "720p", "1080p", "4K"])).toBe("4K");
  });

  it("matches the shape before the pixel count when there is no tier", () => {
    // A 4K portrait frame is not a better answer than a smaller landscape one
    // when the source is landscape.
    expect(largestSize(["1920x1080", "2160x3840"], 16 / 9)).toBe("1920x1080");
    expect(largestSize(["1920x1080", "2160x3840"], 9 / 16)).toBe("2160x3840");
  });

  it("falls back to the biggest when the shape is unknown", () => {
    expect(largestSize(["1280x720", "2560x1440"])).toBe("2560x1440");
    expect(largestSize([])).toBeUndefined();
  });
});
