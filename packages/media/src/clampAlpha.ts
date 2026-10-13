/**
 * Giving a generated clip an alpha it never had.
 *
 * A region is cut from an assembled plate and comes back as an opaque
 * rectangle — the element *and* whatever was behind it. Laid back down, that
 * rectangle freezes its own piece of background inside a plate whose
 * background is being animated separately, and the join shows wherever
 * anything continuous crosses the region's edge. On the GYG proscenium that
 * is open water crossing all four regions.
 *
 * So the clip is clamped: a still matte decides, per pixel, how much of the
 * clip survives, and the plate shows through the rest. This is the companion
 * to `floodMatte` and the opposite trade. `floodMatte` reads a backing colour
 * the model was asked to render and infers the shape; this is handed the shape
 * and does not have to infer anything, which is why it is exact, cheap, and
 * usable on a clip generated over real scenery rather than over chroma.
 *
 * Use it when the element's own alpha is already known — from the PSD layer
 * the region was cut out of. Use `floodMatte` when it is not, and a chroma
 * backing is the only way to find out.
 *
 * ## Why ProRes 4444
 *
 * Same reason `floodMatte` writes it: After Effects reads it natively with its
 * alpha, 10-bit, with no keying effects on the layer. A clip that needs three
 * plugins stacked on it to show its own shape is a clip the artist has to
 * maintain.
 */
import { SeedError } from "@seed-ae/domain";

export interface ClampAlphaPlan {
  /** Arguments for ffmpeg, excluding the executable itself. */
  args: string[];
  /** The frame size the output will be written at. */
  width: number;
  height: number;
}

export interface ClampAlphaOptions {
  /** The clip to clamp. */
  input: string;
  /** A still, single-channel matte. Any size; it is scaled to the clip. */
  matte: string;
  /** Where the ProRes 4444 goes. */
  output: string;
  /** The clip's frame size, from a probe — not guessed. */
  width: number;
  height: number;
  /**
   * Scale the clip to the matte's size instead of the matte to the clip's.
   *
   * Off by default, and the default is the one that keeps the detail: a clip
   * generated at a tier's pixel budget is usually larger than the region it
   * came from, and throwing that away here means throwing it away before
   * After Effects has had the chance to use it.
   */
  toMatte?: { width: number; height: number };
}

/**
 * Plans the clamp, without running it.
 *
 * Separated so the filter graph is testable. Getting an ffmpeg graph wrong is
 * cheap to do and expensive to notice — a wrong `alphamerge` input order
 * produces a clip that looks plausible in a thumbnail and is inverted.
 */
export function planClampAlpha(options: ClampAlphaOptions): ClampAlphaPlan {
  const { input, matte, output } = options;
  if (!input || !matte || !output) {
    throw new SeedError("bad_request", "clamp needs an input, a matte and an output");
  }

  const width = options.toMatte ? options.toMatte.width : options.width;
  const height = options.toMatte ? options.toMatte.height : options.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new SeedError(
      "bad_request",
      `clamp needs the clip's real frame size; received ${options.width}x${options.height}`,
    );
  }
  /*
   * ProRes 4444 is chroma-subsampling-free but still encodes in macroblocks;
   * an odd dimension is accepted and then some decoders drop the last line.
   */
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new SeedError(
      "bad_request",
      `${width}x${height} has an odd dimension; pad or crop to even before clamping`,
    );
  }

  /*
   * `alphamerge` takes the picture first and the matte second, and reads the
   * matte's *luminance*. `format=gray` is not decoration: a matte handed over
   * as RGB would have its alpha read from a channel mix instead of from the
   * values that were authored.
   */
  const filter =
    `[0:v]scale=${width}:${height}:flags=lanczos,format=rgba[v];` +
    `[1:v]format=gray,scale=${width}:${height}:flags=lanczos[m];` +
    `[v][m]alphamerge[out]`;

  return {
    width,
    height,
    args: [
      "-v", "error", "-y",
      "-i", input,
      // One still frame, looped by the filter graph's own frame pacing.
      "-i", matte,
      "-filter_complex", filter,
      "-map", "[out]",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
      "-alpha_bits", "16",
      // Audio is never wanted: these are silent cel elements, and a stray
      // track makes the layer's duration disagree with its frames.
      "-an",
      output,
    ],
  };
}
