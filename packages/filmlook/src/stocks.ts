import type { Rgb } from "./config.js";

/**
 * Film stock definitions.
 *
 * `grain_rms` is per-channel standard deviation in 0..1 display space;
 * `grain_size_mul` scales the per-channel clump sigma. The asymmetry between
 * channels is a real property of a stock rather than a stylistic choice, and
 * it is a large part of why film grain reads as film rather than as noise.
 */
export interface FilmStock {
  /** 3x3 channel mixing matrix, row-major. */
  matrix: readonly [Rgb, Rgb, Rgb];
  saturation: number;
  black_lift: number;
  white_rolloff: number;
  contrast: number;
  pivot: number;
  /** Per-channel noise standard deviation, R G B. */
  grain_rms: Rgb;
  /** Global clump size multiplier. */
  grain_size: number;
  /** Per-channel clump size, when the stock is asymmetric. */
  grain_size_mul?: Rgb;
  halation: number;
  warmth: number;
}

export const STOCKS: Readonly<Record<string, FilmStock>> = {
  /** Near-neutral. The base when only the optical half is wanted. */
  clean: {
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    saturation: 1,
    black_lift: 0.01,
    white_rolloff: 0.96,
    contrast: 1.03,
    pivot: 0.45,
    grain_rms: [0, 0, 0],
    grain_size: 1,
    halation: 0,
    warmth: 0,
  },

  /** Daylight, fine grain, neutral-warm. */
  vision3_250d: {
    matrix: [
      [1.02, 0.01, -0.03],
      [0, 1, 0],
      [-0.02, 0.01, 1.01],
    ],
    saturation: 0.98,
    black_lift: 0.018,
    white_rolloff: 0.93,
    contrast: 1.05,
    pivot: 0.46,
    grain_rms: [0.01, 0.012, 0.018],
    grain_size: 1.1,
    halation: 0.18,
    warmth: 0.03,
  },

  /** Tungsten 500-speed: grainier, richer, warmer, more halation. */
  vision3_500t: {
    matrix: [
      [1.03, 0.02, -0.05],
      [0, 1, 0],
      [-0.03, 0, 1.04],
    ],
    saturation: 1,
    black_lift: 0.024,
    white_rolloff: 0.9,
    contrast: 1.07,
    pivot: 0.46,
    grain_rms: [0.018, 0.02, 0.03],
    grain_size: 1.35,
    halation: 0.32,
    warmth: 0.05,
  },

  /** Print emulation: deeper contrast, richer saturation, strong halation. */
  kodak_2383: {
    matrix: [
      [1.06, 0, -0.06],
      [-0.02, 1.04, -0.02],
      [-0.04, -0.02, 1.08],
    ],
    saturation: 1.08,
    black_lift: 0.012,
    white_rolloff: 0.88,
    contrast: 1.12,
    pivot: 0.44,
    grain_rms: [0.008, 0.01, 0.014],
    grain_size: 1,
    halation: 0.4,
    warmth: 0.04,
  },

  /*
   * The show stock, matched against the master comp. Identity matrix and a
   * global desaturation, with no black lift or white rolloff because the
   * whitepoint tonemap is already doing that work — and a deliberately
   * asymmetric grain: red fine and weak, blue large and strong.
   */
  kodak_5217: {
    matrix: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    saturation: 0.85,
    black_lift: 0,
    white_rolloff: 1,
    contrast: 1,
    pivot: 0.45,
    grain_rms: [0.0145, 0.0127, 0.0262],
    grain_size: 1,
    grain_size_mul: [0.19, 1, 1.17],
    halation: 0,
    warmth: 0,
  },
};

export function requireStock(name: string): FilmStock {
  const stock = STOCKS[name];
  if (!stock) {
    throw new Error(
      `unknown film stock "${name}" — have ${Object.keys(STOCKS).join(", ")}`,
    );
  }
  return stock;
}
