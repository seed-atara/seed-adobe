import { describe, expect, it } from "vitest";
import {
  fillEnclosedPockets,
  fillFromBorder,
  matteFrame,
  sampleBacking,
} from "../src/media/floodMatte.js";

/**
 * The cases a chroma keyer gets wrong.
 *
 * Every fixture here is a small hand-built frame standing in for something
 * measured on a real one: artwork that happens to be the backing colour,
 * backing trapped behind the subject, and the difference between the two.
 * A keyer cannot tell any of them apart, which is the reason this module
 * exists, so these are the tests that have to hold.
 */

const GREEN: [number, number, number] = [0, 247, 8];

interface Painted {
  rgb: Uint8Array;
  width: number;
  height: number;
}

/** A frame of backing, to draw on. */
function frame(width: number, height: number): Painted {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = GREEN[0];
    rgb[i * 3 + 1] = GREEN[1];
    rgb[i * 3 + 2] = GREEN[2];
  }
  return { rgb, width, height };
}

function box(
  painted: Painted,
  x0: number,
  y0: number,
  w: number,
  h: number,
  colour: [number, number, number],
): void {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const at = (y * painted.width + x) * 3;
      painted.rgb[at] = colour[0];
      painted.rgb[at + 1] = colour[1];
      painted.rgb[at + 2] = colour[2];
    }
  }
}

function count(mask: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i]!;
  return n;
}

describe("finding the backing", () => {
  it("reads it off the corners and reports how flat it was", () => {
    const painted = frame(64, 64);
    box(painted, 20, 20, 24, 24, [255, 0, 0]);

    const { backing, spread } = sampleBacking(painted.rgb, 64, 64);

    expect(backing).toEqual(GREEN);
    // Four identical corners. Anything above a few levels on a real clip
    // means a gradient or a subject reaching into a corner, and that is the
    // number that predicts a bad matte.
    expect(spread).toBe(0);
  });
});

describe("why this is not a chroma key", () => {
  it("does not call a region background just for being the right colour", () => {
    const painted = frame(64, 64);
    // A figure, with a patch of exactly the backing colour inside it — the
    // green shorts in the real shot this was written against.
    box(painted, 16, 16, 32, 32, [20, 20, 20]);
    box(painted, 24, 24, 8, 8, GREEN);

    const mask = fillFromBorder(painted.rgb, 64, 64, GREEN, 60);

    // 64x64 minus the 32x32 figure. The green patch inside it is NOT
    // background, because it is not connected to the edge — which a keyer
    // has no way of knowing.
    expect(count(mask)).toBe(64 * 64 - 32 * 32);
    const patchAt = 28 * 64 + 28;
    expect(mask[patchAt]).toBe(0);
  });

  it("still removes backing trapped behind the subject", () => {
    const painted = frame(64, 64);
    // A ring: subject all the way round a pocket of backing, so the pocket
    // touches no edge. The gap under a cafe table, which is what sent this
    // back for a second pass.
    box(painted, 10, 10, 44, 44, [20, 20, 20]);
    box(painted, 22, 22, 20, 20, GREEN);

    const mask = fillFromBorder(painted.rgb, 64, 64, GREEN, 60);
    expect(mask[32 * 64 + 32]).toBe(0); // the border fill alone cannot reach it

    const pockets = fillEnclosedPockets(painted.rgb, mask, 64, 64, GREEN, 16, 16);

    expect(pockets.removed).toBe(20 * 20);
    expect(mask[32 * 64 + 32]).toBe(1);
  });

  it("tells a trapped pocket from a prop by colour, not only by size", () => {
    const painted = frame(64, 64);
    box(painted, 10, 10, 44, 44, [20, 20, 20]);
    // Same size and position as the pocket above, but a DIFFERENT green —
    // the one an illustrator picked, not the one the backing was. Foliage,
    // a cactus, guacamole.
    box(painted, 22, 22, 20, 20, [40, 160, 60]);

    const mask = fillFromBorder(painted.rgb, 64, 64, GREEN, 60);
    const pockets = fillEnclosedPockets(painted.rgb, mask, 64, 64, GREEN, 16, 16);

    // Untouched. The size test would have eaten it; the colour test is what
    // saves it, and that is why there are two tests rather than one.
    expect(pockets.removed).toBe(0);
    expect(mask[32 * 64 + 32]).toBe(0);
  });
});

describe("the alpha it produces", () => {
  it("is hard inside the subject and ramped only at the boundary", () => {
    const painted = frame(32, 32);
    box(painted, 8, 8, 16, 16, [20, 20, 20]);
    // A green an illustrator chose, inside the figure. Foliage, shorts, a
    // bowl of guacamole — the case a keyer punches a hole in.
    box(painted, 12, 12, 4, 4, [40, 160, 60]);

    const out = new Uint8Array(32 * 32 * 4);
    matteFrame(painted.rgb, out, 32, 32, GREEN, 60, 90, true);

    const alphaAt = (x: number, y: number): number => out[(y * 32 + x) * 4 + 3]!;

    expect(alphaAt(2, 2)).toBe(0); // backing
    expect(alphaAt(16, 16)).toBe(255); // the figure
    expect(alphaAt(13, 13)).toBe(255); // the green inside it, kept
  });

  it("will eat artwork painted in EXACTLY the backing colour, and that is the trade", () => {
    const painted = frame(32, 32);
    box(painted, 8, 8, 16, 16, [20, 20, 20]);
    // Not a near green. The backing colour itself, in the middle of the
    // subject, larger than the pocket threshold.
    box(painted, 12, 12, 4, 4, GREEN);

    const out = new Uint8Array(32 * 32 * 4);
    matteFrame(painted.rgb, out, 32, 32, GREEN, 60, 90, true);

    /*
     * Removed. Honest rather than convenient: once there is a pass for
     * backing trapped behind the subject, connectivity alone can no longer
     * protect a green prop — the thing that protects it is being a DIFFERENT
     * green, which real illustration always is.
     *
     * The ways out, if a piece of artwork ever is pure chroma green: pass a
     * different `backing`, or back the element on a colour the artwork does
     * not contain. Which is the argument for choosing the backing per element
     * instead of defaulting to green on a Mexican street full of it.
     */
    expect(out[(13 * 32 + 13) * 4 + 3]).toBe(0);
  });

  it("recovers the subject's own colour at a blended edge", () => {
    const painted = frame(32, 32);
    box(painted, 8, 8, 16, 16, [200, 40, 40]);
    // A half-and-half pixel on the boundary, as an encoder leaves it.
    box(painted, 8, 12, 1, 1, [100, 143, 24]);

    const out = new Uint8Array(32 * 32 * 4);
    matteFrame(painted.rgb, out, 32, 32, GREEN, 60, 200, true);

    const at = (12 * 32 + 8) * 4;
    const alpha = out[at + 3]!;

    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(255);
    /*
     * Un-premultiplying against the backing is the despill: what it takes out
     * is exactly the backing's contribution, so the recovered colour heads
     * back toward the red of the figure rather than staying a muddy green.
     */
    expect(out[at]!).toBeGreaterThan(100); // red recovered, back toward the figure
    expect(out[at + 1]!).toBeLessThan(143); // green given back to the backing
  });

  it("leaves the picture alone when despill is refused", () => {
    const painted = frame(32, 32);
    box(painted, 8, 8, 16, 16, [200, 40, 40]);
    box(painted, 8, 12, 1, 1, [100, 143, 24]);

    const out = new Uint8Array(32 * 32 * 4);
    matteFrame(painted.rgb, out, 32, 32, GREEN, 60, 200, false);

    const at = (12 * 32 + 8) * 4;
    expect([out[at], out[at + 1], out[at + 2]]).toEqual([100, 143, 24]);
  });
});

/**
 * Zero means zero.
 *
 * The size test in the pocket pass protects a small prop that sits near the
 * backing colour. Its floor of 16 pixels also kept every speck of trapped
 * backing smaller than that — which on the GYG proscenium regions was the gaps
 * between leaves, and chroma blue inside gold foliage is the most visible
 * error available. An operator who has measured that nothing in the artwork is
 * near the backing needs a way to turn the size test off.
 */
describe("pocketMinArea of zero", () => {
  /** A frame with one 4-pixel island of backing walled off by artwork. */
  function frameWithTinyPocket(): { rgb: Uint8Array; width: number; height: number } {
    const width = 12;
    const height = 12;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
      const x = i % width;
      const y = (i / width) | 0;
      // Backing everywhere, artwork in a ring, backing again inside it.
      const inRing = x >= 3 && x <= 8 && y >= 3 && y <= 8;
      const inHole = x >= 5 && x <= 6 && y >= 5 && y <= 6;
      const colour = inRing && !inHole ? [220, 150, 40] : [0, 0, 255];
      rgb[i * 3] = colour[0]!;
      rgb[i * 3 + 1] = colour[1]!;
      rgb[i * 3 + 2] = colour[2]!;
    }
    return { rgb, width, height };
  }

  it("keeps a 4-pixel pocket at the default floor and cuts it at zero", () => {
    const backing = [0, 0, 255] as const;
    const run = (pocketMinArea: number) => {
      const { rgb, width, height } = frameWithTinyPocket();
      const out = new Uint8Array(width * height * 4);
      return matteFrame(rgb, out, width, height, backing, 60, 80, true, 60, pocketMinArea);
    };

    // The default floor of 16 cannot reach a four-pixel island.
    expect(run(0.00002).keptMatches).toBe(4);
    // Asked for zero, the exactness test decides on its own and the island goes.
    expect(run(0).keptMatches).toBe(0);
  });

  it("still protects the artwork, which is nowhere near the backing", () => {
    const { rgb, width, height } = frameWithTinyPocket();
    const out = new Uint8Array(width * height * 4);
    matteFrame(rgb, out, width, height, [0, 0, 255], 60, 80, true, 60, 0);
    // The ring is 220,150,40 — 215 from blue. Every pixel of it survives.
    let opaque = 0;
    for (let i = 0; i < width * height; i++) if (out[i * 4 + 3]! > 250) opaque++;
    expect(opaque).toBe(6 * 6 - 2 * 2);
  });
});
