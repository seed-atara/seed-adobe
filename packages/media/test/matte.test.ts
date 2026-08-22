import { describe, expect, it } from "vitest";
import {
  compositeOver,
  featherMatte,
  fullMatte,
  invertMatte,
  matteCoverage,
  matteFromDepth,
  otsuThreshold,
  type RasterImage,
} from "../src/index.js";

function grey(width: number, height: number, value: (x: number, y: number) => number): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const v = Math.max(0, Math.min(255, Math.round(value(x, y))));
      rgba[at] = v;
      rgba[at + 1] = v;
      rgba[at + 2] = v;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function solid(width: number, height: number, rgb: [number, number, number]): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** A subject near the camera against a far background — a depth pass, in short. */
const depth = grey(64, 64, (x, y) => (x >= 20 && x < 44 && y >= 16 && y < 56 ? 230 : 40));

describe("otsuThreshold", () => {
  it("finds a split that actually separates two clusters", () => {
    const values = new Uint8Array(1000);
    values.fill(30, 0, 600);
    values.fill(220, 600);
    const t = otsuThreshold(values);
    // The contract is the top of the darker class, so classify with `>`.
    expect(30 > t).toBe(false);
    expect(220 > t).toBe(true);
  });

  it("survives a single-valued histogram without throwing", () => {
    expect(() => otsuThreshold(new Uint8Array(100).fill(77))).not.toThrow();
  });
});

describe("matteFromDepth", () => {
  it("keys the near subject, not the far background", () => {
    const matte = matteFromDepth(depth);
    const at = (x: number, y: number) => matte.rgba[(y * 64 + x) * 4] as number;

    expect(at(32, 32)).toBe(255); // inside the subject
    expect(at(2, 2)).toBe(0); // background corner

    // The subject is 24x40 of a 64x64 frame.
    expect(matteCoverage(matte)).toBeCloseTo((24 * 40) / (64 * 64), 2);
  });

  it("keys the other end when the depth map is not near-is-bright", () => {
    const matte = matteFromDepth(depth, { nearIsBright: false });
    expect(matte.rgba[(32 * 64 + 32) * 4]).toBe(0);
    expect(matte.rgba[0]).toBe(255);
  });

  it("respects an explicit threshold", () => {
    // Above everything in the frame, so nothing is subject.
    expect(matteCoverage(matteFromDepth(depth, { threshold: 250 }))).toBe(0);
    expect(matteCoverage(matteFromDepth(depth, { threshold: 10 }))).toBe(1);
  });

  it("feathers the edge without moving it", () => {
    const hard = matteFromDepth(depth);
    const soft = matteFromDepth(depth, { feather: 3 });

    // Deep inside and far outside are unchanged; only the boundary softens.
    expect(soft.rgba[(32 * 64 + 32) * 4]).toBe(255);
    expect(soft.rgba[0]).toBe(0);

    const edge = (m: RasterImage) => m.rgba[(32 * 64 + 20) * 4] as number;
    expect(edge(hard)).toBe(255);
    expect(edge(soft)).toBeLessThan(255);
    expect(edge(soft)).toBeGreaterThan(0);

    // Softening redistributes coverage rather than inventing it.
    expect(matteCoverage(soft)).toBeCloseTo(matteCoverage(hard), 1);
  });
});

describe("compositeOver", () => {
  const foreground = solid(32, 32, [255, 0, 0]);
  const background = solid(32, 32, [0, 0, 255]);

  it("keeps the foreground where the matte is white", () => {
    const out = compositeOver(foreground, fullMatte(32, 32), background);
    expect(Array.from(out.rgba.subarray(0, 3))).toEqual([255, 0, 0]);
  });

  it("shows the background where the matte is black", () => {
    const empty = grey(32, 32, () => 0);
    const out = compositeOver(foreground, empty, background);
    expect(Array.from(out.rgba.subarray(0, 3))).toEqual([0, 0, 255]);
  });

  it("mixes proportionally through a grey matte", () => {
    const half = grey(32, 32, () => 128);
    const out = compositeOver(foreground, half, background);
    expect(out.rgba[0]).toBeGreaterThan(120);
    expect(out.rgba[0]).toBeLessThan(136);
    expect(out.rgba[2]).toBeGreaterThan(120);
  });

  it("resizes a background of a different format to the plate", () => {
    const wide = solid(128, 64, [0, 255, 0]);
    const out = compositeOver(foreground, grey(32, 32, () => 0), wide);
    expect(out.width).toBe(32);
    expect(out.height).toBe(32);
    expect(Array.from(out.rgba.subarray(0, 3))).toEqual([0, 255, 0]);
  });
});

describe("invertMatte", () => {
  it("swaps which side is kept", () => {
    const matte = matteFromDepth(depth);
    const flipped = invertMatte(matte);
    expect(matteCoverage(flipped)).toBeCloseTo(1 - matteCoverage(matte), 3);
    expect(flipped.rgba[(32 * 64 + 32) * 4]).toBe(0);
  });
});
