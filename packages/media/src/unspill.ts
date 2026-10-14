/**
 * Taking the backing back out of a keyed clip's edges.
 *
 * `floodMatte` gives a soft alpha to pixels **directly adjacent** to the
 * region it filled — a one-pixel ramp. That is right for a clip generated on a
 * backing the model rendered crisply, and not enough for one generated from a
 * plate whose artwork already had a soft alpha: the plate's own anti-aliasing,
 * the model's rendering of it and 4:2:0 chroma together leave a blend band two
 * or three pixels wide, and only its outermost pixel gets the ramp. The rest
 * stay fully opaque with the backing still mixed into them.
 *
 * On the GYG proscenium regions that was a violet rim around every leaf — 8% of
 * each plate is soft edge, and chroma blue inside gold foliage is the most
 * visible error available. Measured in the finished frame: 0.26% of pixels read
 * as blue-dominant after keying, and 0.0000% after this pass.
 *
 * ## Solving for how much backing is in a pixel
 *
 * An edge pixel is `artwork x (1 - f) + backing x f` for an unknown artwork
 * colour and an unknown mix `f`. One equation, two unknowns — so it needs one
 * fact about the artwork, and the cheapest true one is a ceiling on how much of
 * the backing's own channel the artwork ever shows:
 *
 * ```
 *   artwork[dominant] <= ratio x max(artwork[other channels])
 * ```
 *
 * which rearranges to `f >= (pixel[dominant] - ratio x max(other)) / 255`.
 *
 * `ratio` is measured off the plate, not guessed. Across the four proscenium
 * regions the artwork's blue-over-max-of-red-and-green sits at a median of
 * 0.07-0.26 and a 99th percentile of 0.50-0.55, and only 0.02-0.06% of opaque
 * artwork pixels are blue-dominant at all. At 0.55 the pass touches 1.8% of the
 * clip and costs 0.9% of its alpha; at 0.25 it touches 14.5% and costs 4.5%,
 * and starts desaturating the gold it is supposed to protect. Measure, then
 * take the highest ratio that clears the artwork.
 *
 * Alpha falls by `(1 - f)` and the colour is un-premultiplied against the
 * backing, which is the same arithmetic `floodMatte` applies at its own edge —
 * this simply applies it everywhere the backing can be shown to be present,
 * rather than only where the fill happened to stop.
 */
import { SeedError } from "@seed-ae/domain";

export interface UnspillOptions {
  /** The flat colour the element was generated on, 0-255 per channel. */
  backing: readonly [number, number, number];
  /**
   * The artwork's own ceiling in the backing's dominant channel, as a fraction
   * of its strongest other channel. Measured off the plate.
   */
  ratio: number;
  /** Mixes below this are left alone, so rounding noise does not eat alpha. */
  floor?: number;
}

/** Which channel the backing is, and which two the artwork is judged on. */
export function dominantChannel(
  backing: readonly [number, number, number],
): { dominant: number; others: [number, number] } {
  let dominant = 0;
  for (let c = 1; c < 3; c++) if (backing[c]! > backing[dominant]!) dominant = c;
  const others = [0, 1, 2].filter((c) => c !== dominant) as [number, number];
  return { dominant, others };
}

/**
 * Rewrites one RGBA frame in place.
 *
 * In place because this runs on every frame of a 4K clip through a pipe, and
 * allocating a second buffer per frame is the difference between a pass that
 * is free and one that is not.
 */
export function unspillFrame(rgba: Uint8Array, options: UnspillOptions): { touched: number } {
  const { backing, ratio } = options;
  const floor = options.floor ?? 0.02;
  if (!(ratio >= 0 && ratio <= 1)) {
    throw new SeedError("bad_request", `ratio is a fraction 0-1, got ${ratio}`);
  }
  if (rgba.length % 4 !== 0) {
    throw new SeedError("bad_request", `RGBA needs 4 bytes per pixel, got ${rgba.length}`);
  }
  const { dominant, others } = dominantChannel(backing);
  const level = backing[dominant]!;
  if (level <= 0) return { touched: 0 };

  let touched = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] === 0) continue;
    const ceiling = Math.max(rgba[p + others[0]]!, rgba[p + others[1]]!);
    const excess = rgba[p + dominant]! - ratio * ceiling;
    if (excess <= 0) continue;
    const f = Math.min(excess / level, 1);
    if (f < floor) continue;

    const keep = 1 - f;
    if (keep < 1e-3) {
      rgba[p + 3] = 0;
      touched++;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      const recovered = (rgba[p + c]! - backing[c]! * f) / keep;
      rgba[p + c] = Math.max(0, Math.min(255, Math.round(recovered)));
    }
    rgba[p + 3] = Math.max(0, Math.min(255, Math.round(rgba[p + 3]! * keep)));
    touched++;
  }
  return { touched };
}
