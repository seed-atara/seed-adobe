import { describe, expect, it } from "vitest";
import {
  bandPhases,
  buntingWeave,
  cloudDrift,
  flagWave,
  foliageSway,
  loopingWaveSpeed,
  strandWavelength,
  SWAY_TRAVEL_PER_HEIGHT,
  SWAY_WAVELENGTHS,
  WAVE_DIRECTION,
  WAVE_PINNING,
  WAVE_PINNING_INERT,
} from "../src/buntingWeave.js";

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

  it("gives every shape in the scene a speed that closes over the loop", () => {
    const shapes = [
      buntingWeave(),
      cloudDrift(),
      foliageSway({ elementHeightPx: 556 }),
      flagWave({ elementWidthPx: 254 }),
    ];
    for (const shape of shapes) {
      const cycles = shape["Wave Speed"]! * 30;
      expect(Math.abs(cycles - Math.round(cycles))).toBeLessThan(0.001);
    }
  });
});

/**
 * The table that was wrong twice.
 *
 * Both earlier versions were "measured" with `layerBounds`, which asks After
 * Effects for `sourceRectAtTime` — and that rectangle does not move when a
 * Wave Warp is applied at any amplitude. These values came from rendered
 * pixels instead: solo the layer, capture at opposite phases, compare the
 * alpha centroid of a band along each edge.
 */
describe("the pinning table", () => {
  it("puts the left edge at 5, not 6", () => {
    // The specific correction. `6` holds the top; the old table called it
    // left, and a flag pinned with it would have been nailed by its upper
    // edge rather than its pole.
    expect(WAVE_PINNING.leftEdge).toBe(5);
    expect(WAVE_PINNING.topEdge).toBe(6);
  });

  it("names only edges that were told apart from none", () => {
    const named = Object.values(WAVE_PINNING) as number[];
    for (const inert of WAVE_PINNING_INERT) {
      expect(named).not.toContain(inert);
    }
    // Eleven values exist in the dropdown; three of them moved nothing.
    expect(named.length + WAVE_PINNING_INERT.length).toBe(11);
  });

  it("agrees with itself about the compound entries", () => {
    // 2 held all four edges, 10 held top and bottom, 11 held left and right.
    // Nothing should collide.
    const named = Object.values(WAVE_PINNING) as number[];
    expect(new Set(named).size).toBe(named.length);
  });
});

describe("the weave itself", () => {
  it("does not pin, because the ends are behind the brick columns", () => {
    /*
     * The strands are nailed up behind the arcade's columns, which sit on top
     * of them in the comp, so the ends are never visible and there is nothing
     * to pin. Pinning the top edge would clamp the string the flags hang
     * from and damp the strand to nearly nothing — which is exactly what one
     * of the wrong guesses did.
     */
    expect(buntingWeave().Pinning).toBe(WAVE_PINNING.none);
  });

  it("keeps the wavelength long enough that the strand lifts as one piece", () => {
    /*
     * The number that separates a sway from a wobble is not the amplitude,
     * it is how much the displacement varies across ONE pennant. After
     * Effects' default 40px wavelength puts sixteen waves across a 644px
     * strand, so each 60px flag shears against its neighbour and the whole
     * thing looks like jelly. Measured: width 400 still wobbled, width 800
     * made the strand lift together.
     */
    const flagWidth = 60;
    expect(buntingWeave()["Wave Width"]).toBeGreaterThan(flagWidth * 10);
  });

  it("lengthens the wave for a long strand rather than keeping a ratio", () => {
    expect(strandWavelength(655)).toBe(800);
    expect(strandWavelength(811)).toBe(800);
    // The two 2103-wide strands on the right-hand side shipped at 1600.
    expect(strandWavelength(2228)).toBe(1600);
  });

  it("defaults to a breeze rather than a gale", () => {
    const weave = buntingWeave();
    expect(weave["Wave Height"]).toBeLessThanOrEqual(3);
    expect(weave["Wave Speed"]! * 30).toBeCloseTo(Math.round(weave["Wave Speed"]! * 30), 2);
  });

  it("drifts clouds sideways, over a wave longer than the sky they are in", () => {
    /*
     * Clouds drift, so horizontal. And the wavelength is deliberately longer
     * than the 2083-wide bank: anything shorter sends one half left while
     * the other goes right, and that differential squash reads as the
     * picture breathing rather than the sky moving.
     */
    const sky = cloudDrift();
    expect(sky.Direction).toBe(WAVE_DIRECTION.sway);
    expect(sky["Wave Width"]).toBeGreaterThan(2083);
    expect(sky["Wave Speed"]!).toBeLessThan(buntingWeave()["Wave Speed"]!);
    expect(sky["Wave Speed"]! * 30).toBeCloseTo(Math.round(sky["Wave Speed"]! * 30), 2);
  });

  it("gives a band shared wind and separate phases", () => {
    const phases = bandPhases(5);
    expect(phases).toHaveLength(5);
    expect(new Set(phases).size).toBe(5);
    expect(Math.max(...phases)).toBeLessThan(360);
  });
});

describe("anything with roots", () => {
  it("holds the base and frees the top", () => {
    // Measured: unpinned the canopy moved 9.06px and the base 9.08px, which
    // is the whole tree sliding. Pinned, 9.06px and 2.22px.
    expect(foliageSway({ elementHeightPx: 556 }).Pinning).toBe(WAVE_PINNING.bottomEdge);
  });

  it("displaces along the axis that varies with height", () => {
    /*
     * The one that is easy to get backwards. At Direction 90 the wave varies
     * along x, so every pixel in a column moves by the same amount and the
     * base goes exactly as far as the canopy — no pin can save that.
     */
    expect(foliageSway({ elementHeightPx: 556 }).Direction).toBe(WAVE_DIRECTION.sway);
  });

  it("keeps the plant inside a quarter of a cycle so the trunk cannot S-bend", () => {
    for (const height of [94, 273, 556, 1647]) {
      const sway = foliageSway({ elementHeightPx: height });
      expect(sway["Wave Width"]! / height).toBeGreaterThanOrEqual(SWAY_WAVELENGTHS);
    }
  });

  it("is asked for the travel it should show, not the amplitude", () => {
    /*
     * Amplitude is not travel, and the gap is large enough to matter: a
     * caller who typed the travel they wanted straight into Wave Height
     * would get a third less motion than they asked for.
     */
    const sway = foliageSway({ elementHeightPx: 556, travelPx: 9.06 });
    expect(sway["Wave Height"]! * SWAY_TRAVEL_PER_HEIGHT).toBeCloseTo(9.06, 1);
    expect(sway["Wave Height"]).toBeGreaterThan(9.06);
  });

  it("scales the wave with the plant, so a lettuce is not given a tree's wind", () => {
    const tree = foliageSway({ elementHeightPx: 1647, travelPx: 7 });
    const lettuce = foliageSway({ elementHeightPx: 161, travelPx: 2 });
    expect(tree["Wave Width"]!).toBeGreaterThan(lettuce["Wave Width"]! * 5);
    expect(tree["Wave Height"]!).toBeGreaterThan(lettuce["Wave Height"]!);
  });
});

describe("a flag on a pole", () => {
  it("pins the hoist, on whichever side the pole is", () => {
    expect(flagWave({ elementWidthPx: 254 }).Pinning).toBe(WAVE_PINNING.leftEdge);
    expect(flagWave({ elementWidthPx: 254, hoist: "right" }).Pinning).toBe(
      WAVE_PINNING.rightEdge,
    );
  });

  it("runs about one wave across the cloth, unlike bunting", () => {
    /*
     * The inverse of the bunting rule, deliberately. Bunting wants ten flag
     * widths to a wave so the strand lifts as one piece; a flag wants about
     * one, because a ripple travelling from hoist to fly is the entire point.
     */
    const flag = flagWave({ elementWidthPx: 254 });
    expect(flag["Wave Width"]! / 254).toBeCloseTo(1, 1);
    expect(buntingWeave()["Wave Width"]! / 60).toBeGreaterThan(10);
  });

  it("ripples far faster than anything rooted", () => {
    expect(flagWave({ elementWidthPx: 254 })["Wave Speed"]!).toBeGreaterThan(
      foliageSway({ elementHeightPx: 556 })["Wave Speed"]! * 3,
    );
  });
});
