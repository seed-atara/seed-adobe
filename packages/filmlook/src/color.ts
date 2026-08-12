import type { FloatImage } from "./image.js";
import { clamp01 } from "./image.js";

/**
 * Colour transfer and per-pixel colour maths.
 *
 * The sRGB transfer functions are the exact piecewise definitions rather than
 * a 2.2 power approximation. The difference lives in the bottom two stops,
 * which is precisely where the optical half of this chain does its work — a
 * gamma 2.2 shortcut shifts every shadow before the tonemap ever sees it.
 */

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Rec.709 luminance weights, matching the working space. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

export function luminance(r: number, g: number, b: number): number {
  return r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
}

/**
 * In place, RGB only — alpha is never transferred.
 *
 * Values above 1.0 are allowed through linearisation: the optical stages are
 * physically meaningless without highlights that exceed display white, and
 * clamping here is the quiet way to lose every bloom and halation the chain is
 * supposed to produce.
 */
export function toLinear(image: FloatImage): void {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = srgbToLinear(data[i]!);
    data[i + 1] = srgbToLinear(data[i + 1]!);
    data[i + 2] = srgbToLinear(data[i + 2]!);
  }
}

export function toSrgb(image: FloatImage): void {
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = linearToSrgb(Math.max(0, data[i]!));
    data[i + 1] = linearToSrgb(Math.max(0, data[i + 1]!));
    data[i + 2] = linearToSrgb(Math.max(0, data[i + 2]!));
  }
}

/** Saturation about luminance. Below 1 desaturates, above 1 boosts. */
export function applySaturation(
  r: number,
  g: number,
  b: number,
  amount: number,
): [number, number, number] {
  const y = luminance(r, g, b);
  return [y + (r - y) * amount, y + (g - y) * amount, y + (b - y) * amount];
}

/** Row-major 3x3 applied to a colour. */
export function applyMatrix(
  matrix: readonly (readonly [number, number, number])[],
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  return [
    matrix[0]![0] * r + matrix[0]![1] * g + matrix[0]![2] * b,
    matrix[1]![0] * r + matrix[1]![1] * g + matrix[1]![2] * b,
    matrix[2]![0] * r + matrix[2]![1] * g + matrix[2]![2] * b,
  ];
}

/**
 * Contrast about a pivot.
 *
 * The pivot is why this is not a plain multiply: pushing contrast about 0.5
 * rather than about black keeps mid-grey where it was, which is what a
 * colourist means by the word.
 */
export function contrastAbout(value: number, amount: number, pivot: number): number {
  return (value - pivot) * amount + pivot;
}

/**
 * Approximate white balance in linear light.
 *
 * `temp` warms toward orange when positive and cools toward blue when
 * negative; `tint` runs magenta to green. Documented as an approximation
 * rather than a chromatic adaptation transform, because it is one — the
 * specification gives the controls and their sense but not their matrix.
 */
export function whiteBalance(
  r: number,
  g: number,
  b: number,
  temp: number,
  tint: number,
): [number, number, number] {
  const rGain = 1 + temp * 0.25 + tint * 0.05;
  const gGain = 1 - tint * 0.15;
  const bGain = 1 - temp * 0.25 + tint * 0.05;
  return [r * rGain, g * gGain, b * bGain];
}

/** Hable's filmic curve, the standard formulation. */
export function hable(x: number): number {
  const a = 0.15;
  const b = 0.5;
  const c = 0.1;
  const d = 0.2;
  const e = 0.02;
  const f = 0.3;
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
}

const HABLE_WHITE = hable(11.2);

export function hableTonemap(x: number): number {
  return hable(x) / HABLE_WHITE;
}

/**
 * The whitepoint tonemap — extended Reinhard, and the look's signature stage.
 *
 * Transcribed exactly from the specification. It is explicitly not
 * interchangeable with a generic filmic curve: it is the stage that produces
 * this particular highlight rolloff, and it was reverse-engineered from the
 * show's master comp rather than authored. If a comparison against the
 * reference ever fails, check here first.
 */
export function whitepointTonemap(
  c: number,
  wpGain: number,
  wp: number,
  wpGamma: number,
  amount: number,
): number {
  if (amount <= 0) return c;
  const x = wpGain * c;
  let out = (x * (1 + x / (wp * wp))) / (1 + x);
  out = Math.max(0, out) ** (1 / wpGamma);
  return c + (out - c) * amount;
}

/**
 * AgX-style highlight desaturation: a smooth path to white.
 *
 * Kills the over-saturated highlights a digital renderer produces, where real
 * film desaturates as it approaches its shoulder.
 */
export function pathToWhite(
  r: number,
  g: number,
  b: number,
  amount: number,
): [number, number, number] {
  if (amount <= 0) return [r, g, b];
  const peak = Math.max(r, g, b);
  if (peak <= 0) return [r, g, b];
  const t = clamp01(peak / (1 + peak)) * amount;
  return [r + (peak - r) * t, g + (peak - g) * t, b + (peak - b) * t];
}
