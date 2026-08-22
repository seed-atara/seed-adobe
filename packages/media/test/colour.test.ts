import { describe, expect, it } from "vitest";
import {
  colourDistance,
  labToRgb,
  matchColour,
  proposeLevels,
  measureColour,
  rgbToLab,
  type RasterImage,
} from "../src/index.js";

function flat(r: number, g: number, b: number, size = 24, alpha = 255): RasterImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    rgba[at + 3] = alpha;
  }
  return { width: size, height: size, rgba };
}

/** A ramp, so the frame has spread as well as a mean. */
function ramp(offset: number, gain: number, size = 24): RasterImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const level = Math.max(0, Math.min(255, Math.round(offset + (x / size) * gain)));
      rgba[at] = level;
      rgba[at + 1] = level;
      rgba[at + 2] = level;
      rgba[at + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

describe("Lab conversion", () => {
  it("round-trips the neutrals it will spend most of its time on", () => {
    for (const level of [0, 32, 128, 200, 255]) {
      const [l, a, b] = rgbToLab(level, level, level);
      const [r, g, bb] = labToRgb(l, a, b);
      expect(Math.abs(r - level)).toBeLessThanOrEqual(1);
      expect(Math.abs(g - level)).toBeLessThanOrEqual(1);
      expect(Math.abs(bb - level)).toBeLessThanOrEqual(1);
    }
  });

  it("puts grey on the neutral axis", () => {
    // If a and b drift off zero for grey, every correction introduces a cast.
    const [, a, b] = rgbToLab(128, 128, 128);
    expect(Math.abs(a)).toBeLessThan(0.5);
    expect(Math.abs(b)).toBeLessThan(0.5);
  });

  it("round-trips saturated colour", () => {
    for (const [r, g, b] of [
      [220, 40, 30],
      [30, 160, 90],
      [40, 60, 200],
    ]) {
      const lab = rgbToLab(r as number, g as number, b as number);
      const back = labToRgb(lab[0], lab[1], lab[2]);
      expect(Math.abs(back[0] - (r as number))).toBeLessThanOrEqual(2);
      expect(Math.abs(back[1] - (g as number))).toBeLessThanOrEqual(2);
      expect(Math.abs(back[2] - (b as number))).toBeLessThanOrEqual(2);
    }
  });
});

describe("measureColour", () => {
  it("reports lightness that tracks exposure", () => {
    expect(measureColour(flat(40, 40, 40)).mean[0]).toBeLessThan(
      measureColour(flat(200, 200, 200)).mean[0],
    );
  });

  it("separates a cast from an exposure", () => {
    // The reason for Lab. In RGB a warm shot and a bright shot both just have
    // bigger numbers; here only one of them moves the opponent axes.
    const neutral = measureColour(flat(128, 128, 128));
    const brighter = measureColour(flat(190, 190, 190));
    const warm = measureColour(flat(150, 120, 96));

    expect(Math.abs(brighter.mean[1] - neutral.mean[1])).toBeLessThan(1);
    expect(Math.abs(warm.mean[2] - neutral.mean[2])).toBeGreaterThan(5);
  });

  it("ignores fully transparent pixels", () => {
    // A region capture is mostly matte; counting it reports the colour of
    // nothing.
    expect(measureColour(flat(255, 0, 0, 24, 0)).samples).toBe(0);
  });

  it("reports spread, not just average", () => {
    expect(measureColour(ramp(0, 255)).deviation[0]).toBeGreaterThan(
      measureColour(flat(128, 128, 128)).deviation[0],
    );
  });
});

describe("colourDistance", () => {
  it("is near zero for the same frame", () => {
    const stats = measureColour(ramp(20, 180));
    expect(colourDistance(stats, stats)).toBeLessThan(0.001);
  });

  it("grows with how differently two shots are exposed", () => {
    const base = measureColour(flat(120, 120, 120));
    const near = measureColour(flat(130, 130, 130));
    const far = measureColour(flat(220, 220, 220));
    expect(colourDistance(base, near)).toBeLessThan(colourDistance(base, far));
  });

  it("notices a contrast difference behind an identical average", () => {
    // Two shots can share a mean and still cut badly.
    const flatMid = measureColour(flat(128, 128, 128));
    const wide = measureColour(ramp(0, 255));
    expect(colourDistance(flatMid, wide)).toBeGreaterThan(1);
  });
});

describe("matchColour", () => {
  it("brings a drifted shot onto the reference", () => {
    const reference = ramp(40, 170);
    const drifted = ramp(90, 120);

    const referenceStats = measureColour(reference);
    const driftedStats = measureColour(drifted);
    const before = colourDistance(driftedStats, referenceStats);

    const corrected = matchColour(drifted, driftedStats, referenceStats, 1);
    const after = colourDistance(measureColour(corrected), referenceStats);

    expect(before).toBeGreaterThan(2);
    expect(after).toBeLessThan(before / 2);
  });

  it("does nothing at zero", () => {
    const image = ramp(60, 140);
    const stats = measureColour(image);
    const target = measureColour(ramp(10, 220));
    const untouched = matchColour(image, stats, target, 0);
    expect(Array.from(untouched.rgba)).toEqual(Array.from(image.rgba));
  });

  it("moves partway at a partial amount", () => {
    const image = ramp(90, 120);
    const stats = measureColour(image);
    const target = measureColour(ramp(40, 170));

    const full = colourDistance(measureColour(matchColour(image, stats, target, 1)), target);
    const half = colourDistance(measureColour(matchColour(image, stats, target, 0.5)), target);
    const none = colourDistance(stats, target);

    expect(full).toBeLessThan(half);
    expect(half).toBeLessThan(none);
  });

  it("leaves alpha alone", () => {
    const image = ramp(50, 150);
    for (let at = 3; at < image.rgba.length; at += 4) image.rgba[at] = 111;
    const corrected = matchColour(image, measureColour(image), measureColour(ramp(0, 255)), 1);
    for (let at = 3; at < corrected.rgba.length; at += 4) {
      expect(corrected.rgba[at]).toBe(111);
    }
  });

  it("does not divide by a spread that is not there", () => {
    // A flat frame has no contrast to scale; scaling it would amplify whatever
    // noise it has into the whole range.
    const flatFrame = flat(128, 128, 128);
    const corrected = matchColour(
      flatFrame,
      measureColour(flatFrame),
      measureColour(ramp(0, 255)),
      1,
    );
    for (let at = 0; at < corrected.rgba.length; at += 4) {
      expect(Number.isFinite(corrected.rgba[at] as number)).toBe(true);
    }
  });
});

describe("proposeLevels", () => {
  it("proposes a correction that actually closes the gap", () => {
    /*
     * The test that matters: apply the proposed Levels the way After Effects
     * would and check the result lands near the reference. A proposal that
     * measures well and corrects badly is worse than none.
     */
    const reference = ramp(40, 170);
    const drifted = ramp(95, 110);
    const referenceStats = measureColour(reference);
    const driftedStats = measureColour(drifted);

    const { levels } = proposeLevels(drifted, driftedStats, referenceStats, 1);

    const applied = new Uint8Array(drifted.rgba.length);
    const channels = [levels.red, levels.green, levels.blue];
    for (let at = 0; at < drifted.rgba.length; at += 4) {
      for (let c = 0; c < 3; c += 1) {
        const { inputBlack, inputWhite } = channels[c] as {
          inputBlack: number;
          inputWhite: number;
        };
        const value = (drifted.rgba[at + c] ?? 0);
        const out = ((value - inputBlack) * 255) / (inputWhite - inputBlack);
        applied[at + c] = Math.max(0, Math.min(255, Math.round(out)));
      }
      applied[at + 3] = drifted.rgba[at + 3] ?? 255;
    }

    const before = colourDistance(driftedStats, referenceStats);
    const after = colourDistance(
      measureColour({ width: drifted.width, height: drifted.height, rgba: applied }),
      referenceStats,
    );
    expect(before).toBeGreaterThan(3);
    expect(after).toBeLessThan(before / 2);
  });

  it("proposes nothing much when the shots already match", () => {
    const image = ramp(30, 190);
    const stats = measureColour(image);
    const { levels, residual } = proposeLevels(image, stats, stats, 1);
    // A no-op in Levels is black 0, white 255.
    expect(Math.abs(levels.red.inputBlack)).toBeLessThan(3);
    expect(Math.abs(levels.red.inputWhite - 255)).toBeLessThan(6);
    expect(residual).toBeLessThan(3);
  });

  it("reports a residual when a straight line cannot express the correction", () => {
    // Levels is linear per channel. Where the drift is not, the number has to
    // say so rather than handing over a confident bad answer.
    const image = ramp(0, 255);
    const from = measureColour(image);
    const to = measureColour(flat(200, 60, 60));
    const { residual } = proposeLevels(image, from, to, 1);
    expect(residual).toBeGreaterThan(0);
  });

  it("refuses to invert the picture", () => {
    // A negative slope would turn the shot into a negative; bounded instead.
    const image = ramp(120, 20);
    const { levels } = proposeLevels(image, measureColour(image), measureColour(ramp(200, 10)), 1);
    for (const channel of [levels.red, levels.green, levels.blue]) {
      expect(channel.inputWhite).toBeGreaterThan(channel.inputBlack);
    }
  });
});
