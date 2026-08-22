import { describe, expect, it } from "vitest";
import {
  canvasFor,
  estimateTranslation,
  expandFromShot,
  measureCoverage,
  trackShot,
  type RasterImage,
} from "../src/index.js";

/**
 * A deterministic value-noise "world" wider than any frame, so a pan across it
 * has a known ground truth.
 *
 * Value noise rather than arithmetic ramps on purpose. Ramps built from
 * `(x * k) % 256` look like texture but behave nothing like it: the difference
 * between any two shifts of them is a constant, so the true offset is not
 * reliably the minimum and the matcher is being graded on a trick question.
 * Noise has genuine local features, which is what a matcher actually keys on.
 */
function hash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothNoise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(gx, gy, seed);
  const b = hash(gx + 1, gy, seed);
  const c = hash(gx, gy + 1, seed);
  const d = hash(gx + 1, gy + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

function world(width: number, height: number): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const v =
          smoothNoise(x, y, 24, c + 1) * 0.55 +
          smoothNoise(x, y, 9, c + 7) * 0.3 +
          smoothNoise(x, y, 3, c + 13) * 0.15;
        rgba[at + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Vertical stripes: matches itself perfectly at every multiple of the period. */
function stripes(width: number, height: number): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const v = Math.floor(x / 8) % 2 === 0 ? 220 : 30;
      rgba[at] = v;
      rgba[at + 1] = v;
      rgba[at + 2] = v;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** A window onto the world, which is what a camera is. */
function crop(
  source: RasterImage,
  x0: number,
  y0: number,
  width: number,
  height: number,
): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.max(0, x0 + x));
      const sy = Math.min(source.height - 1, Math.max(0, y0 + y));
      const from = (sy * source.width + sx) * 4;
      const to = (y * width + x) * 4;
      rgba[to] = source.rgba[from] as number;
      rgba[to + 1] = source.rgba[from + 1] as number;
      rgba[to + 2] = source.rgba[from + 2] as number;
      rgba[to + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/** Paints an opaque block, standing in for a subject crossing frame. */
function withBlock(
  frame: RasterImage,
  x0: number,
  y0: number,
  size: number,
): RasterImage {
  const rgba = new Uint8Array(frame.rgba);
  for (let y = y0; y < Math.min(frame.height, y0 + size); y += 1) {
    for (let x = x0; x < Math.min(frame.width, x0 + size); x += 1) {
      if (x < 0 || y < 0) continue;
      const at = (y * frame.width + x) * 4;
      rgba[at] = 255;
      rgba[at + 1] = 0;
      rgba[at + 2] = 255;
    }
  }
  return { width: frame.width, height: frame.height, rgba };
}

const FRAME_W = 128;
const FRAME_H = 96;

/** A pan: the window walks right across a wider world. */
function panFrames(count: number, stepX: number, stepY = 0): RasterImage[] {
  const scene = world(FRAME_W + stepX * count + 40, FRAME_H + stepY * count + 40);
  return Array.from({ length: count }, (_, i) =>
    crop(scene, 20 + i * stepX, 20 + i * stepY, FRAME_W, FRAME_H),
  );
}

describe("canvasFor", () => {
  it("widens a 4:3 frame to 16:9 without shrinking it", () => {
    expect(canvasFor(1440, 1080, 16 / 9)).toEqual({ width: 1920, height: 1080 });
  });

  it("heightens a wide frame when the target is taller", () => {
    expect(canvasFor(1920, 1080, 9 / 16)).toEqual({ width: 1920, height: 3413 });
  });

  it("leaves a frame already at the target alone", () => {
    expect(canvasFor(1920, 1080, 16 / 9)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("estimateTranslation", () => {
  it("recovers a known horizontal shift", () => {
    const frames = panFrames(2, 12);
    const offset = estimateTranslation(
      frames[0] as RasterImage,
      frames[1] as RasterImage,
    );
    // Content moved 12px left within the frame as the camera went right.
    expect(offset.x).toBe(-12);
    expect(offset.y).toBe(0);
    expect(offset.confidence).toBeGreaterThan(0.2);
  });

  it("recovers a diagonal move", () => {
    const frames = panFrames(2, 8, 6);
    const offset = estimateTranslation(
      frames[0] as RasterImage,
      frames[1] as RasterImage,
    );
    expect(offset.x).toBeLessThan(0);
    expect(offset.y).toBeLessThan(0);
  });

  it("reports no confidence on a featureless frame rather than a wrong offset", () => {
    const flat: RasterImage = {
      width: FRAME_W,
      height: FRAME_H,
      rgba: new Uint8Array(FRAME_W * FRAME_H * 4).fill(128),
    };
    const offset = estimateTranslation(flat, flat);
    expect(offset.confidence).toBe(0);
  });

  /*
   * The failure this guards against was real and it was silent: on repeating
   * texture the matcher returned a wildly wrong offset at full confidence,
   * which is worse than returning nothing. Brick, fencing and foliage all do
   * this in real footage.
   */
  it("refuses to answer on periodic texture instead of guessing a period", () => {
    const bars = stripes(FRAME_W, FRAME_H);
    const shifted = crop(bars, 16, 0, FRAME_W, FRAME_H);
    expect(estimateTranslation(bars, shifted).confidence).toBe(0);
  });
});

describe("trackShot", () => {
  it("accumulates a pan into increasing offsets", () => {
    const track = trackShot(panFrames(8, 16));
    expect(track.offsets).toHaveLength(8);
    expect(track.rejected).toBe(0);

    // The camera moved right, so each frame sits further right on the canvas.
    for (let i = 1; i < track.offsets.length; i += 1) {
      const previous = track.offsets[i - 1]?.x as number;
      const current = track.offsets[i]?.x as number;
      expect(current).toBeGreaterThan(previous);
    }
    expect(track.travel.x).toBeGreaterThan(50);
  }, 30_000);

  it("reports no travel for a locked-off shot", () => {
    const still = crop(world(400, 300), 20, 20, FRAME_W, FRAME_H);
    const track = trackShot([still, still, still, still]);
    expect(track.travel.x).toBe(0);
    expect(track.travel.y).toBe(0);
  });
});

describe("expandFromShot", () => {
  it("recovers most of the new area from a pan, with real pixels", () => {
    const frames = panFrames(12, 20);
    const result = expandFromShot(frames, { aspect: 21 / 9 });

    expect(result.coverage.canvas.height).toBe(FRAME_H);
    expect(result.coverage.canvas.width).toBeGreaterThan(FRAME_W);
    /*
     * Half, and that is the right answer rather than a disappointing one: a
     * camera travelling right reveals what lies to the right and never sees
     * what is off the left edge, so with the source centred exactly one of the
     * two new sides is recoverable.
     */
    expect(result.coverage.coverage).toBeGreaterThan(0.45);
    expect(result.coverage.coverage).toBeLessThan(0.55);
    expect(result.coverage.framesUsed).toBeGreaterThan(1);

    /*
     * Sample the recovered side, not the left one — the left of a rightward pan
     * is correctly empty, and asserting on it would be testing the wrong pixel.
     * Recovered pixels are photography: opaque, and carrying real texture
     * rather than a flat fill.
     */
    const row = result.mosaic.height >> 1;
    const at = (row * result.mosaic.width + (result.mosaic.width - 5)) * 4;
    expect(result.mosaic.rgba[at + 3]).toBe(255);

    let varied = 0;
    for (let x = result.mosaic.width - 40; x < result.mosaic.width - 1; x += 1) {
      const a = (row * result.mosaic.width + x) * 4;
      const b = (row * result.mosaic.width + x + 1) * 4;
      if (result.mosaic.rgba[a] !== result.mosaic.rgba[b]) varied += 1;
    }
    expect(varied).toBeGreaterThan(5);
  }, 30_000);

  it("fills the sides a pan actually visited, and says which", () => {
    const frames = panFrames(12, 20);
    const { coverage } = expandFromShot(frames, { aspect: 21 / 9 });
    // Travelling right exposes what is to the right of frame one and hides
    // nothing new on the left, so the two edges must not score the same.
    expect(coverage.edges.right).toBeGreaterThan(0.9);
    expect(coverage.edges.left).toBe(0);
  }, 30_000);

  it("recovers nothing from a locked-off shot and marks it all residual", () => {
    const still = crop(world(400, 300), 20, 20, FRAME_W, FRAME_H);
    const result = expandFromShot([still, still, still], { aspect: 21 / 9 });

    expect(result.coverage.coverage).toBe(0);
    expect(result.coverage.recovered).toBe(0);
    // Every new pixel is white in the residual mask: hand it all to a model.
    const corner = 0;
    expect(result.residual.rgba[corner]).toBe(255);
  });

  it("outvotes a subject moving through the background", () => {
    // The world is static; a block walks across it while the camera pans.
    const clean = panFrames(12, 20);
    const dirty = clean.map((frame, i) => withBlock(frame, 8 + i * 10, 32, 20));

    const result = expandFromShot(dirty, { aspect: 21 / 9 });

    /*
     * The block is magenta (255, 0, 255) and the world never is. If the median
     * worked, almost none of the recovered plate carries the block's colour.
     */
    let blockPixels = 0;
    let opaque = 0;
    for (let i = 0; i < result.mosaic.width * result.mosaic.height; i += 1) {
      const at = i * 4;
      if ((result.mosaic.rgba[at + 3] as number) === 0) continue;
      opaque += 1;
      if (
        (result.mosaic.rgba[at] as number) > 240 &&
        (result.mosaic.rgba[at + 1] as number) < 30 &&
        (result.mosaic.rgba[at + 2] as number) > 240
      ) {
        blockPixels += 1;
      }
    }
    expect(opaque).toBeGreaterThan(0);
    expect(blockPixels / opaque).toBeLessThan(0.08);
  }, 30_000);

  it("honours a source rectangle that puts the frame off-centre", () => {
    const frames = panFrames(12, 20);
    const result = expandFromShot(frames, {
      aspect: 21 / 9,
      sourceRect: { x: 0, y: 0, width: 0.5, height: 1 },
    });
    expect(result.coverage.source.x).toBe(0);
    /*
     * With the source pinned left, all of the new area lies to the right —
     * which is exactly where a rightward pan has been. Placement is not
     * cosmetic: it decides whether the footage can pay for the expansion.
     */
    expect(result.coverage.edges.left).toBe(0);
    expect(result.coverage.coverage).toBeGreaterThan(0.9);
  }, 30_000);

  it("refuses an empty shot rather than inventing a canvas", () => {
    expect(() => expandFromShot([], { aspect: 16 / 9 })).toThrow(/at least one frame/);
  }, 30_000);
});

describe("measureCoverage", () => {
  /*
   * The regression that matters most, because it was silent and it was the
   * advisory number: a shot static apart from one handheld jolt reported 0%
   * recoverable while the full mosaic recovered 42%. The cheap measurement
   * strode over the only frame that saw anything new.
   *
   * Coverage must never depend on how the samples happen to be spread.
   */
  it("counts a single brief excursion the sampling could step over", () => {
    const distance = 40;
    const scene = world(FRAME_W + distance + 80, FRAME_H + 80);
    const frames = Array.from({ length: 16 }, (_, i) =>
      crop(scene, 40 + (i === 7 ? distance : 0), 40, FRAME_W, FRAME_H),
    );

    const cheap = measureCoverage(frames, { aspect: 21 / 9 });
    const full = expandFromShot(frames, { aspect: 21 / 9 }).coverage;

    expect(cheap.coverage).toBeGreaterThan(0.3);
    expect(cheap.coverage).toBeCloseTo(full.coverage, 2);
  }, 30_000);

  it("agrees with the full mosaic about whether a shot is recoverable", () => {
    const panning = measureCoverage(panFrames(12, 20), { aspect: 21 / 9 });
    const still = crop(world(400, 300), 20, 20, FRAME_W, FRAME_H);
    const locked = measureCoverage([still, still, still], { aspect: 21 / 9 });

    expect(panning.coverage).toBeGreaterThan(0.4);
    expect(locked.coverage).toBe(0);
  }, 30_000);
});
