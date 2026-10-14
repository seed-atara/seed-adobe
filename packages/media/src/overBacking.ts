/**
 * Standing a captured element on a backing it can be keyed off again.
 *
 * A region captured with the plate's background switched off arrives as
 * artwork plus alpha. A video model cannot take alpha, so the element has to
 * be stood on something — and if that something is a flat chroma backing, the
 * clip that comes back can be keyed, which is what lets a leaf sway past the
 * silhouette it was traced from instead of being clamped to it.
 *
 * ## The composite is not the obvious one
 *
 * After Effects writes a PNG with **premultiplied** alpha: the stored colour
 * is already `artwork x alpha`, which is why a soft edge fades toward black as
 * the alpha falls. So the composite over a backing is
 *
 * ```
 *   out = rgb + backing x (1 - alpha)          // premultiplied: add the share
 * ```
 *
 * and **not** the straight-alpha form
 *
 * ```
 *   out = rgb x alpha + backing x (1 - alpha)  // wrong here: squares it
 * ```
 *
 * The wrong one is the one a person writes from memory, it looks right on a
 * thumbnail, and it cost a day. Using it on the GYG proscenium stored
 * `artwork x alpha^2 + backing x (1 - alpha)`. Measured on the mid-alpha edge
 * pixels of region 1: the mean should have been `[74, 44, 110]` and it was
 * `[49, 29, 108]` — the artwork's red and green lost a third of their
 * brightness while the backing's blue did not, which is a dark violet rim
 * around every leaf across 8% of the plate.
 *
 * The model then reproduced the rim faithfully, and no despill recovers it:
 * removing the blue leaves the squared, darkened artwork behind. Four clips
 * had to be generated again.
 *
 * ## Detecting which kind of alpha arrived
 *
 * Premultiplied artwork cannot be brighter than its own alpha, so the test is
 * whether any pixel's colour exceeds it by more than rounding allows. Checked
 * rather than assumed, because a plate from another tool may well be straight
 * and the same arithmetic would then darken it instead.
 */
import { SeedError } from "@seed-ae/domain";

export type AlphaKind = "premultiplied" | "straight";

/**
 * Which kind of alpha an RGBA buffer carries.
 *
 * Returns `straight` only on evidence: a pixel whose colour sits clearly above
 * its own alpha cannot be premultiplied. Everything else, including a fully
 * opaque image where the question does not arise, is reported as
 * `premultiplied`, which is what every capture in this project is and the
 * safer default — treating straight data as premultiplied brightens an edge,
 * treating premultiplied data as straight darkens it, and the brightening is
 * recoverable.
 */
export function detectAlphaKind(rgba: Uint8Array, tolerance = 24): AlphaKind {
  let exceeded = 0;
  let soft = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a === 0 || a === 255) continue;
    soft++;
    const brightest = Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!);
    if (brightest > a + tolerance) exceeded++;
  }
  /*
   * One stray pixel is noise; a tenth of the soft edge is a different
   * convention. The GYG captures measure 0 exceeded out of ~107,000 soft
   * pixels, and a straight-alpha plate measures most of them.
   */
  return soft > 0 && exceeded > soft * 0.1 ? "straight" : "premultiplied";
}

export interface OverBackingOptions {
  /** RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** The flat colour to stand the element on, 0-255 per channel. */
  backing: readonly [number, number, number];
  /** Skips the detection when the caller already knows. */
  alpha?: AlphaKind;
}

/**
 * Composites an element over a flat backing, correctly for its alpha kind.
 *
 * Returns RGB, 3 bytes per pixel — opaque, which is what a model takes.
 */
export function overBacking(options: OverBackingOptions): {
  rgb: Uint8Array;
  alpha: AlphaKind;
  softPixels: number;
} {
  const { rgba, width, height, backing } = options;
  if (rgba.length !== width * height * 4) {
    throw new SeedError(
      "bad_request",
      `${width}x${height} needs ${width * height * 4} bytes of RGBA, got ${rgba.length}`,
    );
  }
  for (const channel of backing) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new SeedError("bad_request", `backing channels are 0-255 integers, got ${backing}`);
    }
  }

  const alpha = options.alpha ?? detectAlphaKind(rgba);
  const premultiplied = alpha === "premultiplied";
  const rgb = new Uint8Array(width * height * 3);
  let softPixels = 0;

  for (let p = 0, q = 0; p < rgba.length; p += 4, q += 3) {
    const a = rgba[p + 3]! / 255;
    if (a > 0 && a < 1) softPixels++;
    const share = 1 - a;
    for (let c = 0; c < 3; c++) {
      const artwork = premultiplied ? rgba[p + c]! : rgba[p + c]! * a;
      rgb[q + c] = Math.max(0, Math.min(255, Math.round(artwork + backing[c]! * share)));
    }
  }

  return { rgb, alpha, softPixels };
}
