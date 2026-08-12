import { gaussianBlur, horizontalBlur } from "./blur.js";
import {
  hableTonemap,
  luminance,
  pathToWhite,
  whitepointTonemap,
} from "./color.js";
import type { FilmLookConfig } from "./config.js";
import type { FloatImage } from "./image.js";
import {
  cloneImage,
  createImage,
  diagonal,
  radiusPixels,
  sampleChannelBilinear,
} from "./image.js";
import type { FilmStock } from "./stocks.js";

/**
 * Phase A — the camera, in scene-linear light.
 *
 * Everything here happens to light before it reaches film. The order is the
 * specification and is not open to rearrangement: an optical effect moved to
 * the wrong side of the tonemap stops being physically meaningful and starts
 * being a filter.
 *
 * Defocus and atmospheric haze are absent rather than approximated. Both are
 * depth-driven, we have no depth map, and both are off in the show preset.
 *
 * Where the specification gives exact maths — the combined distortion/CA
 * gather, the whitepoint tonemap — it is transcribed exactly. Where it
 * describes an effect without pinning the formula — vignette, diffusion,
 * streak, bloom, glare — the interpretation is marked as such so it can be
 * checked against the reference rather than trusted.
 */
export function runPhaseA(
  image: FloatImage,
  config: FilmLookConfig,
  stock: FilmStock,
): FloatImage {
  let current = image;

  applyExposure(current, config.exposure);

  // 3. distortion + lateral CA — ONE combined remap, never two gathers.
  current = distortAndAberrate(
    current,
    config.distortion_k1,
    config.distortion_k2,
    config.ca_lateral,
  );

  // 4. optical vignette
  applyVignette(current, config.vignette, config.vignette_mech);

  // 5. diffusion (pro-mist veil)
  current = applyDiffusion(current, config);

  // 6. anamorphic streak
  current = applyStreak(current, config);

  // 7. bloom
  current = applyBloom(current, config);

  // 8. veiling glare
  current = applyGlare(current, config);

  // 9. halation, from the stock
  current = applyHalation(current, config, stock);

  // 10 + 11. filmic tonemap with path-to-white, then the whitepoint tonemap
  applyTonemaps(current, config);

  return current;
}

function applyExposure(image: FloatImage, exposure: number): void {
  if (exposure === 1) return;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i]! *= exposure;
    data[i + 1]! *= exposure;
    data[i + 2]! *= exposure;
  }
}

/**
 * Distortion and lateral chromatic aberration as a single gather.
 *
 * Exactly as specified: build the sample position once, then take one bilinear
 * sample per channel from it. Running distortion and CA as two passes doubles
 * both the softening and the cost, and the softening is the part that shows.
 *
 *   scale(r) = 1 + k1·r² + k2·r⁴
 *   R and B at scale(r)·(1 ± ca·r), G at scale(r)
 */
export function distortAndAberrate(
  image: FloatImage,
  k1: number,
  k2: number,
  ca: number,
): FloatImage {
  if (k1 === 0 && k2 === 0 && ca === 0) return image;

  const { width, height } = image;
  const out = createImage(width, height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const half = diagonal(image) / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy) / half;
      const r2 = r * r;
      const scale = 1 + k1 * r2 + k2 * r2 * r2;

      const i = (y * width + x) * 4;
      const scaleR = scale * (1 + ca * r);
      const scaleB = scale * (1 - ca * r);

      out.data[i] = sampleChannelBilinear(image, cx + dx * scaleR, cy + dy * scaleR, 0);
      out.data[i + 1] = sampleChannelBilinear(image, cx + dx * scale, cy + dy * scale, 1);
      out.data[i + 2] = sampleChannelBilinear(image, cx + dx * scaleB, cy + dy * scaleB, 2);
      // Alpha follows the green channel's geometry: a matte has no dispersion.
      out.data[i + 3] = sampleChannelBilinear(image, cx + dx * scale, cy + dy * scale, 3);
    }
  }
  return out;
}

/**
 * Optical vignette: cos⁴ illumination falloff plus a mechanical corner term.
 *
 * INTERPRETED. The specification names cos⁴ and a separate mechanical term but
 * does not give the formula for either. This uses the standard identity
 * cos⁴(atan r) = 1/(1+r²)² with r normalised to the half-diagonal, and a
 * smooth mechanical cutoff biting only in the outer third.
 *
 * Applied in linear, as illumination falloff. It is emphatically not a black
 * ellipse multiplied over the picture in display space — that crushes corners
 * where a real lens merely lights them less.
 */
export function applyVignette(
  image: FloatImage,
  amount: number,
  mechanical: number,
): void {
  if (amount === 0 && mechanical === 0) return;

  const { width, height, data } = image;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const half = diagonal(image) / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = Math.hypot(x - cx, y - cy) / half;
      const cos4 = 1 / (1 + r * r) ** 2;
      let factor = 1 - amount * (1 - cos4);

      if (mechanical !== 0) {
        const bite = Math.max(0, (r - 0.66) / 0.34);
        factor *= 1 - mechanical * bite * bite;
      }

      const i = (y * width + x) * 4;
      data[i]! *= factor;
      data[i + 1]! *= factor;
      data[i + 2]! *= factor;
    }
  }
}

/**
 * Diffusion — a pro-mist veil.
 *
 * INTERPRETED as a broad blur lifted back over the original, which is what a
 * diffusion filter does optically: it does not soften the image so much as lay
 * a low-contrast copy of it on top.
 */
function applyDiffusion(image: FloatImage, config: FilmLookConfig): FloatImage {
  if (config.diffusion <= 0) return image;
  const veil = gaussianBlur(image, radiusPixels(image, config.diffusion_radius));
  screenOver(image, veil, config.diffusion);
  return image;
}

/**
 * Anamorphic streak — horizontal, from the highlights.
 *
 * INTERPRETED: threshold to highlights, blur horizontally only at a radius
 * several times the diffusion radius, add back. The horizontal-only blur is
 * the part the specification is explicit about.
 */
function applyStreak(image: FloatImage, config: FilmLookConfig): FloatImage {
  if (config.anamorphic <= 0) return image;
  const highlights = thresholdCopy(image, config.glare_threshold);
  const streak = horizontalBlur(highlights, radiusPixels(image, 0.06));
  addScaled(image, streak, config.anamorphic);
  return image;
}

/** Bloom — achromatic scatter around bright areas. INTERPRETED threshold. */
function applyBloom(image: FloatImage, config: FilmLookConfig): FloatImage {
  if (config.bloom <= 0) return image;
  // Thresholded where highlights begin; see the note on halation below.
  const highlights = thresholdCopy(image, config.glare_threshold);
  const scattered = gaussianBlur(highlights, radiusPixels(image, config.bloom_radius));
  addScaled(image, scattered, config.bloom);
  return image;
}

/** Veiling glare — a wide, low lift across the whole frame. INTERPRETED. */
function applyGlare(image: FloatImage, config: FilmLookConfig): FloatImage {
  if (config.glare_intensity <= 0) return image;
  const highlights = thresholdCopy(image, config.glare_threshold);
  const veil = gaussianBlur(highlights, radiusPixels(image, config.glare_radius));
  addScaled(image, veil, config.glare_intensity);
  return image;
}

/**
 * Halation — the red-orange bloom that film produces and sensors do not.
 *
 * Specified: threshold the bright areas, blur at `halation_radius`, tint by
 * `halation_tint`, add back scaled by the stock's `halation` times
 * `halation_scale`. `halation_color` leaks green to push the halo from red
 * toward orange, which is what practical flame and tungsten actually do.
 */
function applyHalation(
  image: FloatImage,
  config: FilmLookConfig,
  stock: FilmStock,
): FloatImage {
  const strength = stock.halation * config.halation_scale;
  if (strength <= 0) return image;

  /*
   * Thresholded where highlights begin, not at display white.
   *
   * This used to threshold at 1.0 in linear. A maximum-white sRGB pixel is
   * exactly 1.0 there, and the show preset's exposure of 0.97 pulls it below —
   * so nothing ever exceeded the threshold and halation never fired on any
   * ordinary footage. It only worked on input that was already above display
   * white, which an After Effects layer usually is not.
   *
   * The specification says to threshold the bright areas without saying where,
   * so `glare_threshold` is used: it is already the config's answer to the
   * question "where do highlights start".
   */
  const highlights = thresholdCopy(image, config.glare_threshold);
  const halo = gaussianBlur(highlights, radiusPixels(image, config.halation_radius));

  const [tr, tg, tb] = config.halation_tint;
  const green = tg + config.halation_color;

  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i]! += halo.data[i]! * tr * strength;
    data[i + 1]! += halo.data[i + 1]! * green * strength;
    data[i + 2]! += halo.data[i + 2]! * tb * strength;
  }
  return image;
}

/** Stages 10 and 11, per-pixel and in that order. */
function applyTonemaps(image: FloatImage, config: FilmLookConfig): void {
  const { data } = image;
  const filmic = config.tonemap;
  const wp = config.wp_tonemap;

  if (filmic <= 0 && wp <= 0 && config.path_to_white <= 0) return;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]!;
    let g = data[i + 1]!;
    let b = data[i + 2]!;

    if (config.path_to_white > 0) {
      [r, g, b] = pathToWhite(r, g, b, config.path_to_white);
    }

    if (filmic > 0) {
      r = r + (hableTonemap(r) - r) * filmic;
      g = g + (hableTonemap(g) - g) * filmic;
      b = b + (hableTonemap(b) - b) * filmic;
    }

    if (wp > 0) {
      r = whitepointTonemap(r, config.wp_gain, config.wp, config.wp_gamma, wp);
      g = whitepointTonemap(g, config.wp_gain, config.wp, config.wp_gamma, wp);
      b = whitepointTonemap(b, config.wp_gain, config.wp, config.wp_gamma, wp);
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Everything above a threshold, everything else black. */
function thresholdCopy(image: FloatImage, threshold: number): FloatImage {
  const out = cloneImage(image);
  const { data } = out;
  for (let i = 0; i < data.length; i += 4) {
    const y = luminance(data[i]!, data[i + 1]!, data[i + 2]!);
    const keep = y > threshold ? (y - threshold) / Math.max(y, 1e-6) : 0;
    data[i]! *= keep;
    data[i + 1]! *= keep;
    data[i + 2]! *= keep;
  }
  return out;
}

function addScaled(target: FloatImage, source: FloatImage, scale: number): void {
  const a = target.data;
  const b = source.data;
  for (let i = 0; i < a.length; i += 4) {
    a[i]! += b[i]! * scale;
    a[i + 1]! += b[i + 1]! * scale;
    a[i + 2]! += b[i + 2]! * scale;
  }
}

/** Screen blend, used for the diffusion veil. */
function screenOver(target: FloatImage, veil: FloatImage, amount: number): void {
  const a = target.data;
  const b = veil.data;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const base = a[i + c]!;
      const screened = 1 - (1 - Math.min(base, 1)) * (1 - Math.min(b[i + c]!, 1));
      a[i + c] = base + (screened - base) * amount;
    }
  }
}
