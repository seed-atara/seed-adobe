import { describe, expect, it } from "vitest";
import { bestQualitySize } from "../src/quality.js";

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
