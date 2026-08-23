import { describe, expect, it } from "vitest";
import {
  cropTo,
  describeBars,
  detectBars,
  type RasterImage,
} from "../src/index.js";

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** A picture of the given size, padded into `width`x`height` with black. */
function padded(
  width: number,
  height: number,
  picture: { x: number; y: number; width: number; height: number },
  shift = 0,
  brightness = 1,
): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      rgba[at + 3] = 255;
      const inside =
        x >= picture.x &&
        x < picture.x + picture.width &&
        y >= picture.y &&
        y < picture.y + picture.height;
      if (!inside) continue;
      for (let c = 0; c < 3; c += 1) {
        const v = hash(x + shift, y, c + 1) * 200 + 30;
        rgba[at + c] = Math.round(Math.min(255, v * brightness));
      }
    }
  }
  return { width, height, rgba };
}

const PICTURE = { x: 420, y: 0, width: 1080, height: 1080 };

describe("detectBars", () => {
  it("finds a square picture pillarboxed into HD", () => {
    // The exact case that turned up in the field: a 1:1 shot delivered 1920x1080.
    const frames = [0, 6, 12].map((shift) => padded(1920, 1080, PICTURE, shift));
    expect(detectBars(frames)).toEqual(PICTURE);
  });

  it("finds a letterbox too", () => {
    const picture = { x: 0, y: 140, width: 1920, height: 800 };
    const frames = [0, 4].map((shift) => padded(1920, 1080, picture, shift));
    expect(detectBars(frames)).toEqual(picture);
  });

  it("returns nothing when the frame is all picture", () => {
    const full = { x: 0, y: 0, width: 640, height: 360 };
    const frames = [0, 5].map((shift) => padded(640, 360, full, shift));
    expect(detectBars(frames)).toBeUndefined();
  });

  /*
   * The failure worth guarding against: a night exterior is dark at the edges
   * but it is *photography*, so it varies. Cropping it would silently throw
   * away picture, which is far worse than leaving a bar on.
   */
  it("does not eat the dark edge of a low-key shot", () => {
    const full = { x: 0, y: 0, width: 640, height: 360 };
    const frames = [0, 5].map((shift) => padded(640, 360, full, shift, 0.06));
    expect(detectBars(frames)).toBeUndefined();
  });

  it("ignores a dark edge only one frame has", () => {
    // Frame two is padded, frame one is not — so it is content, not delivery.
    const frames = [
      padded(640, 360, { x: 0, y: 0, width: 640, height: 360 }, 0),
      padded(640, 360, { x: 40, y: 0, width: 560, height: 360 }, 5),
    ];
    expect(detectBars(frames)).toBeUndefined();
  });

  it("refuses to crop away most of the frame", () => {
    // A tiny picture in a big black frame is more likely a mistake than a crop.
    const frames = [
      padded(640, 360, { x: 280, y: 150, width: 80, height: 60 }, 0),
      padded(640, 360, { x: 280, y: 150, width: 80, height: 60 }, 3),
    ];
    expect(detectBars(frames)).toBeUndefined();
  });
});

describe("cropTo", () => {
  it("returns just the picture, at the picture's size", () => {
    const frame = padded(1920, 1080, PICTURE, 0);
    const out = cropTo(frame, PICTURE);
    expect(out.width).toBe(1080);
    expect(out.height).toBe(1080);
    // The old left bar is gone: the first column now carries picture.
    expect(out.rgba[3]).toBe(255);
    expect(out.rgba[0]).toBeGreaterThan(0);
  });
});

describe("describeBars", () => {
  it("names the shape in the words an artist would use", () => {
    const text = describeBars(PICTURE, 1920, 1080);
    expect(text).toContain("pillarbox");
    expect(text).toContain("420px left");
    expect(text).toContain("420px right");
    expect(text).toContain("1080x1080");
  });

  it("calls a top-and-bottom crop a letterbox", () => {
    const text = describeBars({ x: 0, y: 140, width: 1920, height: 800 }, 1920, 1080);
    expect(text).toContain("letterbox");
  });
});
