import { gaussianBlur } from "./blur.js";
import { luminance } from "./color.js";
import type { FilmLookConfig } from "./config.js";
import type { FloatImage } from "./image.js";
import { createImage, lerp } from "./image.js";
import type { FilmStock } from "./stocks.js";

/**
 * Grain. Always last, and never anything else.
 *
 * Grain applied before a grade gets graded, and then reads as digital noise
 * rather than film — the single most common way this look goes wrong. The
 * chain enforces the position; this file only has to be right about the noise.
 *
 * Two properties matter as much as the amount:
 *
 * **Per-channel asymmetry.** A stock's red grain is not its blue grain. The
 * show stock is deliberately lopsided — red fine and weak, blue large and
 * strong — and that asymmetry is a real property of the emulsion and a large
 * part of why the result reads as film.
 *
 * **Sizing independent of raster.** `grain_ref_longedge` sets the resolution
 * grain is generated at. Left at 0 it is generated natively, so grain gets
 * finer relative to the frame as resolution rises and the same preset looks
 * different at HD and 4K. Set to the show's 4096 it is generated as if the long
 * edge were 4096 and scaled, locking grain size to the look. This is also why
 * grain must not follow a preview downsample factor the way every other radius
 * does.
 */
export function applyGrain(
  image: FloatImage,
  config: FilmLookConfig,
  stock: FilmStock,
  frame: number,
): void {
  if (!config.grain_enable || config.grain_scale <= 0) return;

  const rms = stock.grain_rms;
  if (rms[0] === 0 && rms[1] === 0 && rms[2] === 0) return;

  const { width, height } = image;

  /*
   * The resolution grain is generated at. Scaling up from a reference long
   * edge is what keeps clump size tied to the look rather than the raster.
   */
  const longEdge = Math.max(width, height);
  const reference = config.grain_ref_longedge > 0 ? config.grain_ref_longedge : longEdge;
  const genScale = reference > 0 ? longEdge / reference : 1;

  const sizeMul = stock.grain_size_mul ?? [1, 1, 1];

  for (let channel = 0; channel < 3; channel++) {
    const amplitude = rms[channel]! * config.grain_scale;
    if (amplitude <= 0) continue;

    const sigma = config.grain_size * stock.grain_size * sizeMul[channel]! * genScale;
    const noise = channelNoise(width, height, config.seed, frame, channel, sigma);

    const { data } = image;
    for (let p = 0, i = channel; p < width * height; p++, i += 4) {
      /*
       * `grain_chroma` blends between mono grain and fully per-channel grain.
       * At 0 every channel gets the red channel's noise, so the grain is
       * luminance-only; at 1 each channel is independent.
       */
      const mono = noise.mono[p]!;
      const own = noise.own[p]!;
      const n = lerp(mono, own, config.grain_chroma);

      // `grain_gate` weights grain toward shadows rather than letting it peak
      // in the mids, which is where film actually puts it.
      const value = data[i]!;
      const y = luminance(data[i - channel]!, data[i - channel + 1]!, data[i - channel + 2]!);
      const midWeight = 4 * y * (1 - y);
      const shadowWeight = 1 - y;
      const weight = lerp(midWeight, shadowWeight, config.grain_gate);

      data[i] = value + n * amplitude * weight;
    }
  }
}

/**
 * Gaussian noise, clumped, deterministic per (seed, frame, pixel).
 *
 * Stable within a frame so it does not crawl when the artist scrubs, and
 * different between frames so it does not read as dirt on the lens.
 */
function channelNoise(
  width: number,
  height: number,
  seed: number,
  frame: number,
  channel: number,
  sigma: number,
): { mono: Float32Array; own: Float32Array } {
  const mono = whiteNoise(width, height, seed, frame, 0);
  const own = channel === 0 ? mono : whiteNoise(width, height, seed, frame, channel);

  if (sigma > 0.01) {
    return {
      mono: clump(mono, width, height, sigma),
      own: channel === 0 ? clump(mono, width, height, sigma) : clump(own, width, height, sigma),
    };
  }
  return { mono, own };
}

function whiteNoise(
  width: number,
  height: number,
  seed: number,
  frame: number,
  channel: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p++) {
      out[p] = gaussianAt(seed, frame, channel, x, y);
    }
  }
  return out;
}

/**
 * One Gaussian sample from a hash of (seed, frame, channel, x, y).
 *
 * Hash rather than a sequential generator so any pixel can be evaluated
 * independently — which is what makes this portable to a shader later without
 * the grain changing.
 */
function gaussianAt(
  seed: number,
  frame: number,
  channel: number,
  x: number,
  y: number,
): number {
  const u1 = Math.max(hash(seed, frame, channel, x, y, 0), 1e-7);
  const u2 = hash(seed, frame, channel, x, y, 1);
  // Box-Muller.
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** 32-bit integer hash to a float in [0, 1). */
function hash(
  seed: number,
  frame: number,
  channel: number,
  x: number,
  y: number,
  salt: number,
): number {
  let h = 2166136261 >>> 0;
  for (const value of [seed, frame, channel, x, y, salt]) {
    h ^= value >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 13;
  }
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Clump the noise, then restore its standard deviation.
 *
 * Blurring reduces variance, so a clumped field left alone is quieter than the
 * stock asks for — and the grain test measures exactly that. Renormalising
 * makes `grain_rms` mean what it says at any clump size.
 */
function clump(
  noise: Float32Array,
  width: number,
  height: number,
  sigma: number,
): Float32Array {
  const image = createImage(width, height);
  for (let p = 0; p < noise.length; p++) image.data[p * 4] = noise[p]!;

  const blurred = gaussianBlur(image, sigma);

  let sum = 0;
  let sumSq = 0;
  for (let p = 0; p < noise.length; p++) {
    const value = blurred.data[p * 4]!;
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / noise.length;
  const variance = Math.max(sumSq / noise.length - mean * mean, 1e-12);
  const correction = 1 / Math.sqrt(variance);

  const out = new Float32Array(noise.length);
  for (let p = 0; p < noise.length; p++) {
    out[p] = (blurred.data[p * 4]! - mean) * correction;
  }
  return out;
}
