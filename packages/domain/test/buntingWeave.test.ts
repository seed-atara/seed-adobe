import { describe, expect, it } from "vitest";
import { bandPhases, buntingWeave, loopingWaveSpeed, WAVE_PINNING } from "../src/buntingWeave.js";

/**
 * The one number that decides whether a warp loops.
 *
 * Wave Warp's phase advances continuously and knows nothing about the clip
 * repeating. Everything else here is taste; this is arithmetic.
 */
describe("a wave that comes back to where it started", () => {
  it("snaps the speed to a whole number of cycles over the duration", () => {
    // 0.4 x 30 = 12 exactly, so this one is already honest.
    expect(loopingWaveSpeed(0.4, 30)).toBe(0.4);

    // 0.41 x 30 = 12.3 cycles, which leaves the wave three tenths of a cycle
    // from home at the cut. Snapped down to 12.
    expect(loopingWaveSpeed(0.41, 30)).toBe(0.4);

    // 0.45 x 30 = 13.5 -> 14 cycles, and 14/30 is a repeating decimal, so it
    // is rounded to something After Effects can hold.
    expect(loopingWaveSpeed(0.45, 30) * 30).toBeCloseTo(14, 2);
  });

  it("never returns a speed of zero, however slow the request", () => {
    // Rounding 0.001 x 30 to the nearest whole cycle gives 0, and a dead
    // still wave is not a subtle one — it is a bug that looks like taste.
    expect(loopingWaveSpeed(0.001, 30)).toBeGreaterThan(0);
    expect(loopingWaveSpeed(0.001, 30) * 30).toBeCloseTo(1, 4);
  });

  it("holds for durations that are not thirty seconds", () => {
    /*
     * One cycle over thirty seconds is a repeating decimal, so the stored
     * speed can only be close. The tolerance here is what the eye can see,
     * not what a float can hold: a thousandth of a cycle across the whole
     * clip is a third of a degree of phase at the loop point.
     */
    for (const seconds of [10, 12, 24, 30]) {
      const speed = loopingWaveSpeed(0.37, seconds);
      const cycles = speed * seconds;
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(0.001);
    }
  });
});

describe("the weave itself", () => {
  it("pins both ends, because a bunting string is tied at both ends", () => {
    // Unpinned, the whole strand slides sideways off the brickwork it is
    // nailed to — which is worse than no animation at all.
    expect(buntingWeave().Pinning).toBe(WAVE_PINNING.leftAndRight);
  });

  it("defaults to a breeze rather than a gale", () => {
    const weave = buntingWeave();
    expect(weave["Wave Height"]).toBeLessThanOrEqual(8);
    expect(weave["Wave Speed"] * 30).toBeCloseTo(Math.round(weave["Wave Speed"]! * 30), 2);
  });

  it("gives a band shared wind and separate phases", () => {
    const phases = bandPhases(5);
    expect(phases).toHaveLength(5);
    expect(new Set(phases).size).toBe(5);
    expect(Math.max(...phases)).toBeLessThan(360);
  });
});
