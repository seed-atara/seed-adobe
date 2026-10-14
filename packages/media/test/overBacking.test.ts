import { describe, expect, it } from "vitest";
import { detectAlphaKind, overBacking } from "../src/overBacking.js";

/**
 * The arithmetic that cost four clips.
 *
 * Standing a captured element on a chroma backing is two lines of code and the
 * wrong one of the two looks right everywhere except on a soft edge. These
 * tests pin the correct one against the exact numbers measured off the GYG
 * proscenium, so the next person to write it from memory has to break a test
 * rather than a day's generations.
 */
describe("standing an element on a backing", () => {
  const BLUE = [0, 0, 255] as const;

  /** One pixel, at a given alpha, premultiplied against black like AE writes. */
  function premultipliedPixel(
    artwork: [number, number, number],
    a: number,
  ): Uint8Array {
    return new Uint8Array([
      Math.round(artwork[0] * a),
      Math.round(artwork[1] * a),
      Math.round(artwork[2] * a),
      Math.round(a * 255),
    ]);
  }

  it("adds the backing's share rather than multiplying the artwork again", () => {
    // A gold leaf edge at half cover: the artwork is 148,88,22 at full.
    const rgba = premultipliedPixel([148, 88, 22], 0.5);
    const { rgb, alpha } = overBacking({ rgba, width: 1, height: 1, backing: BLUE });

    expect(alpha).toBe("premultiplied");
    // artwork is already premultiplied, so only the backing's share is added.
    expect([...rgb]).toEqual([74, 44, 138]);

    /*
     * And the bug, expressed as what it was: the same premultiplied bytes read
     * as though they were straight, which multiplies by alpha a second time.
     * The red and green lose half again while the backing's blue is untouched,
     * and that imbalance is the dark violet rim.
     */
    const wrong = overBacking({
      rgba,
      width: 1,
      height: 1,
      backing: BLUE,
      alpha: "straight",
    }).rgb;
    expect(wrong[0]).toBeLessThan(rgb[0]!);
    expect(wrong[1]).toBeLessThan(rgb[1]!);
    // The backing's own contribution is untouched, so the blue barely moves
    // (138 -> 133) while the artwork's channels halve. That imbalance is the
    // whole defect: not darker, but bluer.
    expect(rgb[2]! - wrong[2]!).toBeLessThan(8);
    // Half the artwork's brightness gone, which is what was measured on the
    // real plate: [74,44,110] expected against [49,29,108] sent.
    expect(wrong[0]! / rgb[0]!).toBeCloseTo(0.5, 1);
  });

  it("leaves a fully opaque pixel exactly as it was", () => {
    const rgba = new Uint8Array([148, 88, 22, 255]);
    const { rgb, softPixels } = overBacking({ rgba, width: 1, height: 1, backing: BLUE });
    expect([...rgb]).toEqual([148, 88, 22]);
    expect(softPixels).toBe(0);
  });

  it("gives a fully transparent pixel the backing and nothing else", () => {
    const rgba = new Uint8Array([0, 0, 0, 0]);
    const { rgb } = overBacking({ rgba, width: 1, height: 1, backing: BLUE });
    expect([...rgb]).toEqual([0, 0, 255]);
  });

  it("tells premultiplied data from straight data by what exceeds its alpha", () => {
    // Premultiplied: colour tracks alpha and never exceeds it.
    const premult = new Uint8Array([
      ...premultipliedPixel([200, 200, 200], 0.25),
      ...premultipliedPixel([200, 200, 200], 0.5),
      ...premultipliedPixel([200, 200, 200], 0.75),
    ]);
    expect(detectAlphaKind(premult)).toBe("premultiplied");

    // Straight: full-brightness artwork sitting at low alpha.
    const straight = new Uint8Array([200, 200, 200, 64, 200, 200, 200, 128, 200, 200, 200, 190]);
    expect(detectAlphaKind(straight)).toBe("straight");
  });

  it("treats an image with no soft edge as premultiplied, which is the safe default", () => {
    // Nothing to measure, and brightening is recoverable where darkening is not.
    expect(detectAlphaKind(new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0]))).toBe("premultiplied");
  });

  it("handles straight alpha correctly too, rather than darkening it", () => {
    const rgba = new Uint8Array([148, 88, 22, 128]);
    const { rgb } = overBacking({ rgba, width: 1, height: 1, backing: BLUE, alpha: "straight" });
    // artwork*a + backing*(1-a), with the artwork read at full brightness.
    expect([...rgb]).toEqual([74, 44, 138]);
  });

  it("refuses a buffer that is not the size it was told", () => {
    expect(() =>
      overBacking({ rgba: new Uint8Array(8), width: 4, height: 4, backing: BLUE }),
    ).toThrow(/bytes of RGBA/);
  });

  it("refuses a backing that is not a colour", () => {
    expect(() =>
      overBacking({
        rgba: new Uint8Array(4),
        width: 1,
        height: 1,
        backing: [0, 0, 300] as unknown as readonly [number, number, number],
      }),
    ).toThrow(/0-255/);
  });
});
