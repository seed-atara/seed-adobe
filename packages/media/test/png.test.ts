import { describe, expect, it } from "vitest";
import { decodePng, encodePng, fitWithin, readPngSize, resize } from "../src/index.js";

function solid(width: number, height: number, rgba: [number, number, number, number]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    pixels.set(rgba, i * 4);
  }
  return pixels;
}

describe("encodePng", () => {
  it("writes a decodable header with the requested dimensions", () => {
    const png = encodePng(4, 3, new Uint8Array(4 * 3 * 4).fill(128));
    expect(readPngSize(png)).toEqual({ width: 4, height: 3 });
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("rejects a mismatched pixel buffer", () => {
    expect(() => encodePng(4, 3, new Uint8Array(10))).toThrow(/RGBA bytes/);
  });
});

describe("decodePng", () => {
  it("round-trips pixels through encode and decode", () => {
    const pixels = new Uint8Array(6 * 5 * 4);
    for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) % 256;
    const decoded = decodePng(encodePng(6, 5, pixels));
    expect(decoded?.width).toBe(6);
    expect(decoded?.height).toBe(5);
    expect(Array.from(decoded?.rgba ?? [])).toEqual(Array.from(pixels));
  });

  it("returns undefined for non-PNG bytes instead of guessing", () => {
    expect(decodePng(Buffer.from("not an image at all"))).toBeUndefined();
    expect(decodePng(Buffer.alloc(0))).toBeUndefined();
  });

  it("survives a truncated file", () => {
    const png = encodePng(4, 4, solid(4, 4, [1, 2, 3, 4]));
    expect(decodePng(png.subarray(0, 30))).toBeUndefined();
  });
});

describe("resize", () => {
  it("averages a solid image to the same colour", () => {
    const image = { width: 8, height: 8, rgba: solid(8, 8, [10, 20, 30, 255]) };
    const small = resize(image, 2, 2);
    expect(small.width).toBe(2);
    expect(Array.from(small.rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
  });

  it("averages rather than point-sampling a two-tone image", () => {
    // Left half black, right half white -> a 1x1 reduction must be mid grey.
    const rgba = new Uint8Array(4 * 1 * 4);
    for (let x = 0; x < 4; x += 1) {
      const v = x < 2 ? 0 : 255;
      rgba.set([v, v, v, 255], x * 4);
    }
    const out = resize({ width: 4, height: 1, rgba }, 1, 1);
    expect(out.rgba[0]).toBeGreaterThan(100);
    expect(out.rgba[0]).toBeLessThan(155);
  });

  it("fits within a box without upscaling or distorting", () => {
    const image = { width: 1920, height: 1080, rgba: solid(1920, 1080, [0, 0, 0, 255]) };
    const thumb = fitWithin(image, 320, 320);
    expect(thumb.width).toBe(320);
    expect(thumb.height).toBe(180);

    const tiny = { width: 10, height: 10, rgba: solid(10, 10, [0, 0, 0, 255]) };
    expect(fitWithin(tiny, 320, 320)).toBe(tiny);
  });
});
