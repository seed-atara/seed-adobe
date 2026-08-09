import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { alphaBounds, decodePng } from "../src/index.js";

function image(width: number, height: number, fill: (x: number, y: number) => number) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      rgba[(y * width + x) * 4 + 3] = fill(x, y);
    }
  }
  return { width, height, rgba };
}

describe("alphaBounds", () => {
  it("reports full coverage for an opaque frame", () => {
    const { box, coverage } = alphaBounds(image(10, 10, () => 255));
    expect(box).toEqual({ minX: 0, minY: 0, maxX: 9, maxY: 9 });
    expect(coverage).toBe(1);
  });

  it("finds the rendered region of a partly rendered frame", () => {
    // A Region of Interest leaves a rectangle opaque and the rest empty.
    const { box, coverage } = alphaBounds(
      image(100, 100, (x, y) => (x >= 20 && x < 60 && y >= 10 && y < 90 ? 255 : 0)),
    );
    expect(box).toEqual({ minX: 20, minY: 10, maxX: 59, maxY: 89 });
    expect(coverage).toBeCloseTo(0.32, 5);
  });

  it("reports nothing for a fully transparent frame", () => {
    expect(alphaBounds(image(8, 8, () => 0))).toEqual({ box: null, coverage: 0 });
  });

  it("measures a real partly rendered After Effects capture", async () => {
    // Captured from AE with a Region of Interest active: a clean rectangle of
    // rendered pixels, the rest transparent.
    const bytes = await readFile("fixtures/media/ae-partial-capture.png");
    const decoded = decodePng(bytes);
    if (!decoded) throw new Error("could not decode the fixture");

    const { box, coverage } = alphaBounds(decoded);
    expect(decoded.width).toBe(1920);
    expect(box).toEqual({ minX: 386, minY: 0, maxX: 1533, maxY: 1079 });
    expect(coverage).toBeGreaterThan(0.59);
    expect(coverage).toBeLessThan(0.60);
  });
});
