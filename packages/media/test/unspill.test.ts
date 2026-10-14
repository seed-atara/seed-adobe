import { describe, expect, it } from "vitest";
import { dominantChannel, unspillFrame } from "../src/unspill.js";

/**
 * Recovering a pixel that is part artwork and part backing.
 *
 * `floodMatte` only softens pixels touching the region it filled, which is one
 * pixel of a blend band that is two or three wide when the plate's artwork had
 * its own soft alpha. The rest keep the backing mixed in at full opacity. These
 * tests pin the arithmetic that takes it back out, against the ratios measured
 * off the GYG proscenium plates.
 */
describe("unspilling a backing out of an edge", () => {
  const BLUE = [0, 0, 255] as const;
  const GREEN = [0, 177, 64] as const;

  /** One pixel: artwork mixed with backing at `f`, fully opaque. */
  function mixed(artwork: [number, number, number], f: number): Uint8Array {
    const b = BLUE;
    return new Uint8Array([
      Math.round(artwork[0] * (1 - f) + b[0] * f),
      Math.round(artwork[1] * (1 - f) + b[1] * f),
      Math.round(artwork[2] * (1 - f) + b[2] * f),
      255,
    ]);
  }

  it("recovers the artwork's colour and drops the alpha to match", () => {
    // A gold leaf, 148,88,22, at a half-covered edge.
    const rgba = mixed([148, 88, 22], 0.5);
    expect([...rgba]).toEqual([74, 44, 139, 255]);

    const { touched } = unspillFrame(rgba, { backing: BLUE, ratio: 0.15 });
    expect(touched).toBe(1);
    // The mix solves to very nearly a half, so the alpha halves...
    expect(rgba[3]).toBeGreaterThan(118);
    expect(rgba[3]).toBeLessThan(138);
    // ...and the colour comes back close to the artwork it started as.
    expect(rgba[0]).toBeGreaterThan(135);
    expect(rgba[1]).toBeGreaterThan(78);
    // Crucially the blue is no longer dominant, which is the visible defect.
    expect(rgba[2]).toBeLessThan(Math.max(rgba[0]!, rgba[1]!));
  });

  it("leaves artwork that is merely blue-ish alone", () => {
    /*
     * The ratio is the whole protection. Measured on these plates the artwork's
     * blue sits at a median of 0.07-0.26 of its strongest other channel and a
     * 99th percentile of 0.55, so a ratio of 0.55 cannot reach it.
     */
    const dusk = new Uint8Array([120, 110, 60, 255]);
    const before = [...dusk];
    expect(unspillFrame(dusk, { backing: BLUE, ratio: 0.55 }).touched).toBe(0);
    expect([...dusk]).toEqual(before);
  });

  it("takes a pixel that is nearly all backing to fully transparent", () => {
    const rgba = mixed([148, 88, 22], 0.995);
    unspillFrame(rgba, { backing: BLUE, ratio: 0.15 });
    // Not forced to exactly zero: the solve returns what it returns, and one
    // level of 255 is transparent enough that rounding it down would be a
    // cosmetic lie about what the arithmetic found.
    expect(rgba[3]).toBeLessThan(4);
  });

  it("never touches a pixel the key already removed", () => {
    const gone = new Uint8Array([0, 0, 255, 0]);
    expect(unspillFrame(gone, { backing: BLUE, ratio: 0.15 }).touched).toBe(0);
    expect(gone[3]).toBe(0);
  });

  it("ignores a mix below the floor, so rounding noise does not eat alpha", () => {
    const barely = mixed([148, 88, 22], 0.004);
    const { touched } = unspillFrame(barely, { backing: BLUE, ratio: 0.15, floor: 0.02 });
    expect(touched).toBe(0);
    expect(barely[3]).toBe(255);
  });

  it("works off whichever channel the backing actually is", () => {
    expect(dominantChannel(BLUE)).toEqual({ dominant: 2, others: [0, 1] });
    expect(dominantChannel(GREEN)).toEqual({ dominant: 1, others: [0, 2] });
    expect(dominantChannel([255, 0, 255])).toEqual({ dominant: 0, others: [1, 2] });

    // A green-screen edge: the green is taken down against red and blue.
    const onGreen = new Uint8Array([90, 150, 70, 255]);
    unspillFrame(onGreen, { backing: GREEN, ratio: 0.5 });
    expect(onGreen[1]).toBeLessThan(150);
  });

  it("refuses a ratio that is not a fraction, and a ragged buffer", () => {
    expect(() => unspillFrame(new Uint8Array(4), { backing: BLUE, ratio: 1.5 })).toThrow(
      /fraction/,
    );
    expect(() => unspillFrame(new Uint8Array(5), { backing: BLUE, ratio: 0.5 })).toThrow(
      /4 bytes per pixel/,
    );
  });
});
