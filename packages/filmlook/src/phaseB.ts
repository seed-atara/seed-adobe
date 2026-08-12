import { gaussianBlur } from "./blur.js";
import {
  applyMatrix,
  applySaturation,
  contrastAbout,
  luminance,
  whiteBalance,
} from "./color.js";
import type { FilmLookConfig } from "./config.js";
import { applyGrain } from "./grain.js";
import type { FloatImage } from "./image.js";
import { clamp01, cloneImage, lerp, radiusPixels } from "./image.js";
import type { FilmStock } from "./stocks.js";

/**
 * Phase B — the film and the grade, in display space.
 *
 * Everything here happens to an image that has already been developed, which
 * is why nothing that simulates the *camera* may appear in this half. The two
 * exceptions people reach for — vignette and chromatic aberration — belong to
 * Phase A and are there.
 *
 * Order within the phase is still load-bearing in two places the spec calls
 * out: dehalo runs before sharpen, and grain runs last. Everything after grain
 * would be graded onto the grain.
 */
export function runPhaseB(
  image: FloatImage,
  config: FilmLookConfig,
  stock: FilmStock,
  frame: number,
): FloatImage {
  applyStock(image, config, stock);
  applyAutoLevels(image, config.auto_levels);
  applyGrade(image, config);
  applyCdl(image, config);
  applySplitTone(image, config.split_tone);
  applyBleach(image, config.bleach);

  // 19 → 21. Dehalo before sharpen: sharpening an upscaler's rims makes them
  // worse, and no amount of later correction recovers the edge.
  applyDehalo(image, config);
  applyLocalContrast(image, config.clarity, config.clarity_radius);
  applySharpen(image, config.sharpen);

  applyChromaDenoise(image, config);
  applyFade(image, config.fade);

  applyGrain(image, config, stock, frame);

  applyLetterbox(image, config);
  return image;
}

/** Stock colour: matrix, saturation, black lift, white rolloff, contrast. */
function applyStock(
  image: FloatImage,
  config: FilmLookConfig,
  stock: FilmStock,
): void {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    let [r, g, b] = applyMatrix(stock.matrix, data[i]!, data[i + 1]!, data[i + 2]!);

    if (stock.saturation !== 1) {
      [r, g, b] = applySaturation(r, g, b, stock.saturation);
    }

    if (stock.black_lift !== 0) {
      const lift = stock.black_lift;
      r = lift + r * (1 - lift);
      g = lift + g * (1 - lift);
      b = lift + b * (1 - lift);
    }

    if (stock.white_rolloff !== 1) {
      const w = stock.white_rolloff;
      r = rolloff(r, w);
      g = rolloff(g, w);
      b = rolloff(b, w);
    }

    if (stock.contrast !== 1) {
      r = contrastAbout(r, stock.contrast, stock.pivot);
      g = contrastAbout(g, stock.contrast, stock.pivot);
      b = contrastAbout(b, stock.contrast, stock.pivot);
    }

    if (stock.warmth !== 0) {
      [r, g, b] = whiteBalance(r, g, b, stock.warmth, 0);
    }

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Soft shoulder toward a white point below 1. */
function rolloff(value: number, white: number): number {
  if (value <= 0) return value;
  return (value * white) / (1 + Math.max(0, value - white) * 2);
}

/**
 * Per-channel black and white point match.
 *
 * INTERPRETED. The specification names it, gives its default as 0 and warns it
 * is easy to overdo, but does not define the percentiles. This uses the 0.1st
 * and 99.9th percentiles per channel so a handful of hot or dead pixels cannot
 * drag the whole match, blended by `auto_levels`.
 */
function applyAutoLevels(image: FloatImage, amount: number): void {
  if (amount <= 0) return;
  const { data } = image;
  const count = data.length / 4;

  for (let c = 0; c < 3; c++) {
    const values = new Float32Array(count);
    for (let p = 0; p < count; p++) values[p] = data[p * 4 + c]!;
    values.sort();

    const low = values[Math.floor(count * 0.001)]!;
    const high = values[Math.min(count - 1, Math.floor(count * 0.999))]!;
    const span = high - low;
    if (!(span > 1e-6)) continue;

    for (let p = 0; p < count; p++) {
      const i = p * 4 + c;
      const matched = (data[i]! - low) / span;
      data[i] = lerp(data[i]!, matched, amount);
    }
  }
}

/** Lift, gain, contrast, saturation, temperature and tint. */
function applyGrade(image: FloatImage, config: FilmLookConfig): void {
  const { lift, gain, contrast, contrast_pivot, saturation, temp, tint } = config;
  const neutral =
    lift === 0 &&
    gain === 1 &&
    contrast === 1 &&
    saturation === 1 &&
    temp === 0 &&
    tint === 0;
  if (neutral) return;

  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]! * gain + lift;
    let g = data[i + 1]! * gain + lift;
    let b = data[i + 2]! * gain + lift;

    if (contrast !== 1) {
      r = contrastAbout(r, contrast, contrast_pivot);
      g = contrastAbout(g, contrast, contrast_pivot);
      b = contrastAbout(b, contrast, contrast_pivot);
    }
    if (temp !== 0 || tint !== 0) [r, g, b] = whiteBalance(r, g, b, temp, tint);
    if (saturation !== 1) [r, g, b] = applySaturation(r, g, b, saturation);

    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** ASC-CDL: slope, offset, power, then saturation. The standard order. */
function applyCdl(image: FloatImage, config: FilmLookConfig): void {
  const { cdl_slope: s, cdl_offset: o, cdl_power: p, cdl_sat } = config;
  const neutral =
    s[0] === 1 && s[1] === 1 && s[2] === 1 &&
    o[0] === 0 && o[1] === 0 && o[2] === 0 &&
    p[0] === 1 && p[1] === 1 && p[2] === 1 &&
    cdl_sat === 1;
  if (neutral) return;

  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    let r = Math.max(0, data[i]! * s[0] + o[0]) ** p[0];
    let g = Math.max(0, data[i + 1]! * s[1] + o[1]) ** p[1];
    let b = Math.max(0, data[i + 2]! * s[2] + o[2]) ** p[2];
    if (cdl_sat !== 1) [r, g, b] = applySaturation(r, g, b, cdl_sat);
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}

/** Teal shadows, warm highlights. INTERPRETED weighting. */
function applySplitTone(image: FloatImage, amount: number): void {
  if (amount <= 0) return;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const y = clamp01(luminance(data[i]!, data[i + 1]!, data[i + 2]!));
    const shadow = (1 - y) * amount;
    const highlight = y * amount;
    data[i]! += highlight * 0.06 - shadow * 0.04;
    data[i + 1]! += highlight * 0.02 + shadow * 0.01;
    data[i + 2]! += shadow * 0.06 - highlight * 0.03;
  }
}

/** Bleach bypass: desaturate and overlay luminance. INTERPRETED. */
function applyBleach(image: FloatImage, amount: number): void {
  if (amount <= 0) return;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const y = clamp01(luminance(data[i]!, data[i + 1]!, data[i + 2]!));
    for (let c = 0; c < 3; c++) {
      const base = clamp01(data[i + c]!);
      const overlay =
        base < 0.5 ? 2 * base * y : 1 - 2 * (1 - base) * (1 - y);
      data[i + c] = lerp(data[i + c]!, overlay, amount);
    }
  }
}

/**
 * Dehalo — tame the bright rims an upscaler or a generative model leaves.
 *
 * INTERPRETED as clamping each pixel toward a blurred copy where it is
 * brighter than its surroundings. Runs before sharpen because sharpening a rim
 * is how a soft artefact becomes a hard one.
 */
function applyDehalo(image: FloatImage, config: FilmLookConfig): void {
  if (config.dehalo <= 0) return;
  const blurred = gaussianBlur(image, radiusPixels(image, 0.002));
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const value = data[i + c]!;
      const reference = blurred.data[i + c]!;
      if (value > reference) {
        data[i + c] = lerp(value, reference, config.dehalo);
      }
    }
  }
}

/**
 * Clarity — local contrast by unsharp mask.
 *
 * Negative values soften, and that is a feature rather than an oversight: an
 * over-detailed or AI-upscaled frame usually needs less detail, not more.
 */
function applyLocalContrast(
  image: FloatImage,
  amount: number,
  radiusFraction: number,
): void {
  if (amount === 0) return;
  const blurred = gaussianBlur(image, radiusPixels(image, radiusFraction));
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = data[i + c]! + (data[i + c]! - blurred.data[i + c]!) * amount;
    }
  }
}

/** Fine luminance unsharp. Chroma is left alone on purpose. */
function applySharpen(image: FloatImage, amount: number): void {
  if (amount <= 0) return;
  const blurred = gaussianBlur(image, 1.2);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const y = luminance(data[i]!, data[i + 1]!, data[i + 2]!);
    const yBlur = luminance(
      blurred.data[i]!,
      blurred.data[i + 1]!,
      blurred.data[i + 2]!,
    );
    const delta = (y - yBlur) * amount;
    data[i]! += delta;
    data[i + 1]! += delta;
    data[i + 2]! += delta;
  }
}

/**
 * Blur chroma, keep luminance sharp.
 *
 * The correct answer to the colour speckle a generative model produces:
 * denoising the whole image throws away detail that is not the problem.
 */
function applyChromaDenoise(image: FloatImage, config: FilmLookConfig): void {
  if (config.chroma_denoise <= 0) return;

  const source = cloneImage(image);
  const blurred = gaussianBlur(source, radiusPixels(image, 0.003));
  const { data } = image;

  for (let i = 0; i < data.length; i += 4) {
    const y = luminance(data[i]!, data[i + 1]!, data[i + 2]!);
    const yBlur = luminance(
      blurred.data[i]!,
      blurred.data[i + 1]!,
      blurred.data[i + 2]!,
    );
    for (let c = 0; c < 3; c++) {
      // The blurred pixel with its own luminance replaced by the sharp one.
      const chromaOnly = blurred.data[i + c]! + (y - yBlur);
      data[i + c] = lerp(data[i + c]!, chromaOnly, config.chroma_denoise);
    }
  }
}

/** A lifted-black matte. */
function applyFade(image: FloatImage, amount: number): void {
  if (amount <= 0) return;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      data[i + c] = amount * 0.1 + data[i + c]! * (1 - amount * 0.1);
    }
  }
}

/** Optional matte to a target aspect. */
function applyLetterbox(image: FloatImage, config: FilmLookConfig): void {
  if (!config.letterbox) return;
  const { width, height, data } = image;
  const target = config.aspect;
  const current = width / height;
  if (Math.abs(current - target) < 1e-3) return;

  if (current < target) {
    const visible = Math.round(width / target);
    const bar = Math.floor((height - visible) / 2);
    for (let y = 0; y < height; y++) {
      if (y >= bar && y < height - bar) continue;
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  } else {
    const visible = Math.round(height * target);
    const bar = Math.floor((width - visible) / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (x >= bar && x < width - bar) continue;
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
    }
  }
}
