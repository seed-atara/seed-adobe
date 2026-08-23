import { describe, expect, it } from "vitest";
import {
  applyHomography,
  decompose,
  estimatePlane,
  fitHomography,
  fitPlane,
  multiply,
  IDENTITY,
  type Correspondence,
  type Homography,
  type RasterImage,
} from "../src/index.js";

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(x: number, y: number, cell: number, s: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(gx, gy, s);
  const b = hash(gx + 1, gy, s);
  const c = hash(gx, gy + 1, s);
  const d = hash(gx + 1, gy + 1, s);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

/** A textured world, sampled through an arbitrary transform. */
function render(
  width: number,
  height: number,
  map: (x: number, y: number) => { x: number; y: number },
): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const p = map(x, y);
      for (let c = 0; c < 3; c += 1) {
        const v =
          smooth(p.x, p.y, 26, c + 1) * 0.55 +
          smooth(p.x, p.y, 9, c + 6) * 0.3 +
          smooth(p.x, p.y, 3, c + 11) * 0.15;
        rgba[at + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

const W = 384;
const H = 288;

describe("fitHomography", () => {
  it("recovers a transform exactly from four exact pairs", () => {
    const truth: Homography = [1.04, 0.03, -12, -0.02, 0.99, 7, 0.00002, -0.00001, 1];
    const points: Correspondence[] = [
      [10, 10],
      [300, 20],
      [40, 260],
      [330, 250],
    ].map(([x, y]) => {
      const mapped = applyHomography(truth, x as number, y as number);
      return { fromX: x as number, fromY: y as number, toX: mapped.x, toY: mapped.y, confidence: 1 };
    });

    const fitted = fitHomography(points);
    expect(fitted).toBeDefined();
    for (const [x, y] of [[100, 100], [250, 200]] as const) {
      const expected = applyHomography(truth, x, y);
      const actual = applyHomography(fitted as Homography, x, y);
      expect(actual.x).toBeCloseTo(expected.x, 3);
      expect(actual.y).toBeCloseTo(expected.y, 3);
    }
  });

  it("refuses fewer than four pairs rather than inventing a plane", () => {
    expect(fitHomography([])).toBeUndefined();
    expect(
      fitHomography([{ fromX: 0, fromY: 0, toX: 1, toY: 1, confidence: 1 }]),
    ).toBeUndefined();
  });
});

describe("multiply", () => {
  it("composes two transforms into one", () => {
    const shift: Homography = [1, 0, 10, 0, 1, 5, 0, 0, 1];
    const scale: Homography = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const both = multiply(scale, shift);
    const point = applyHomography(both, 3, 4);
    expect(point.x).toBeCloseTo((3 + 10) * 2, 6);
    expect(point.y).toBeCloseTo((4 + 5) * 2, 6);
  });

  it("leaves a transform alone when composed with identity", () => {
    const h: Homography = [1.1, 0.02, -4, 0.01, 0.97, 6, 0, 0, 1];
    const same = multiply(IDENTITY, h);
    for (let i = 0; i < 9; i += 1) {
      expect(same[i] as number).toBeCloseTo(h[i] as number, 9);
    }
  });
});

describe("fitPlane", () => {
  /*
   * The reason this uses RANSAC rather than least squares. A quarter of the
   * points belong to something moving through frame; a fit that averaged them
   * in would follow the actor instead of the camera.
   */
  it("ignores a minority moving a different way", () => {
    const camera = 14;
    const points: Correspondence[] = [];
    for (let i = 0; i < 24; i += 1) {
      const x = 20 + (i % 6) * 60;
      const y = 20 + Math.floor(i / 6) * 60;
      const rogue = i % 4 === 0; // a quarter of them, on the "subject"
      points.push({
        fromX: x,
        fromY: y,
        toX: x + (rogue ? -40 : camera),
        toY: y,
        confidence: 1,
      });
    }

    const fit = fitPlane(points);
    expect(fit.inliers).toBe(18);
    const mapped = applyHomography(fit.matrix, 200, 150);
    expect(mapped.x - 200).toBeCloseTo(camera, 1);
    expect(mapped.y - 150).toBeCloseTo(0, 1);
  });

  it("reports no confidence when there is nothing to fit", () => {
    const fit = fitPlane([]);
    expect(fit.confidence).toBe(0);
    expect(fit.matrix).toEqual(IDENTITY);
  });
});

describe("estimatePlane", () => {
  it("measures a pure translation", () => {
    const a = render(W, H, (x, y) => ({ x, y }));
    const b = render(W, H, (x, y) => ({ x: x + 12, y: y + 5 }));

    const fit = estimatePlane(a, b);
    expect(fit.confidence).toBeGreaterThan(0.6);
    const centre = applyHomography(fit.matrix, W / 2, H / 2);
    // Content shifted by (+12,+5) in the world means it moved -12,-5 in frame.
    expect(centre.x - W / 2).toBeCloseTo(-12, 0);
    expect(centre.y - H / 2).toBeCloseTo(-5, 0);
  }, 60_000);

  /*
   * The case a translation cannot express, and the reason for this module. A
   * handheld shot rolls constantly; the old matcher degraded on it and started
   * rejecting frames.
   */
  it("measures a rotation a translation could never express", () => {
    const angle = (2.5 * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const a = render(W, H, (x, y) => ({ x, y }));
    const b = render(W, H, (x, y) => {
      const dx = x - W / 2;
      const dy = y - H / 2;
      return { x: W / 2 + dx * cos - dy * sin, y: H / 2 + dx * sin + dy * cos };
    });

    const fit = estimatePlane(a, b);
    expect(fit.confidence).toBeGreaterThan(0.5);

    const rotation = decompose(fit.matrix).rotationDegrees;
    expect(Math.abs(rotation)).toBeGreaterThan(1.5);
    expect(Math.abs(rotation)).toBeLessThan(4);
  }, 60_000);

  it("measures a zoom", () => {
    const factor = 1.06;
    const a = render(W, H, (x, y) => ({ x, y }));
    const b = render(W, H, (x, y) => ({
      x: W / 2 + (x - W / 2) / factor,
      y: H / 2 + (y - H / 2) / factor,
    }));

    const fit = estimatePlane(a, b);
    expect(fit.confidence).toBeGreaterThan(0.5);
    expect(decompose(fit.matrix).scale).toBeGreaterThan(1.02);
    expect(decompose(fit.matrix).scale).toBeLessThan(1.12);
  }, 60_000);
});

describe("decompose", () => {
  it("reads back translation, rotation and scale a comp can key", () => {
    const angle = (10 * Math.PI) / 180;
    const scale = 1.5;
    const h: Homography = [
      scale * Math.cos(angle), -scale * Math.sin(angle), 40,
      scale * Math.sin(angle), scale * Math.cos(angle), -25,
      0, 0, 1,
    ];
    const parts = decompose(h);
    expect(parts.x).toBe(40);
    expect(parts.y).toBe(-25);
    expect(parts.rotationDegrees).toBeCloseTo(10, 4);
    expect(parts.scale).toBeCloseTo(1.5, 6);
  });
});
