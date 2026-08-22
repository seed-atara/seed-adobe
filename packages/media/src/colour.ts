import type { RasterImage } from "./png.js";

/**
 * Measuring and matching the colour of a shot.
 *
 * Generative shots drift. Two clips made from the same plates, the same Item
 * and the same prompt come back at different exposures and different casts,
 * and cut together they read as two different days. Nothing in the pipeline
 * noticed, because nothing measured.
 *
 * The measurement is mean and spread per channel in **Lab**, not RGB. Lab
 * separates lightness from colour, so a shot that is merely darker can be
 * corrected without shifting its hue, and a shot with a green cast can be
 * corrected without touching its exposure. Doing this in RGB moves all three
 * at once and turns an exposure difference into a colour shift.
 *
 * The correction is the classic statistical transfer: centre each channel on
 * its own mean, scale by the ratio of spreads, recentre on the reference's
 * mean. It is not a grade and does not pretend to be — it lands two shots in
 * the same neighbourhood, which is what stops a cut from flickering.
 */

/** Mean and standard deviation per Lab channel, over the sampled pixels. */
export interface ColourStats {
  /** L, a, b — lightness 0..100, the opponent axes roughly -128..127. */
  mean: [number, number, number];
  deviation: [number, number, number];
  /** How many pixels went into it, so a thin sample can be distrusted. */
  samples: number;
}

/* ----------------------------------------------------------- conversion -- */

function toLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function toSrgbByte(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** D65, the white point sRGB is defined against. */
const WHITE: [number, number, number] = [0.95047, 1.0, 1.08883];

function pivot(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function unpivot(t: number): number {
  const cubed = t * t * t;
  return cubed > 0.008856 ? cubed : (t - 16 / 116) / 7.787;
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = toLinear(r);
  const gl = toLinear(g);
  const bl = toLinear(b);

  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / WHITE[0];
  const y = (rl * 0.2126 + gl * 0.7152 + bl * 0.0722) / WHITE[1];
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / WHITE[2];

  const fx = pivot(x);
  const fy = pivot(y);
  const fz = pivot(z);

  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb(l: number, a: number, bb: number): [number, number, number] {
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - bb / 200;

  const x = unpivot(fx) * WHITE[0];
  const y = unpivot(fy) * WHITE[1];
  const z = unpivot(fz) * WHITE[2];

  const rl = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const gl = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const bl = x * 0.0557 + y * -0.204 + z * 1.057;

  return [toSrgbByte(rl), toSrgbByte(gl), toSrgbByte(bl)];
}

/* ------------------------------------------------------------ measuring -- */

/**
 * The colour of a frame.
 *
 * Fully transparent pixels are skipped — a region capture is mostly matte, and
 * counting the empty part would report the colour of nothing. Near-black and
 * near-white are kept: they are part of how a shot is exposed.
 *
 * Sampled on a stride rather than every pixel. A 5750x2818 frame is sixteen
 * million pixels and the statistics do not change after the first hundred
 * thousand; measuring all of them would make this too slow to run on import,
 * which is the only moment it is useful.
 */
export function measureColour(image: RasterImage, maxSamples = 120_000): ColourStats {
  const total = image.width * image.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));

  let n = 0;
  const sum: [number, number, number] = [0, 0, 0];
  const sumSquares: [number, number, number] = [0, 0, 0];

  for (let index = 0; index < total; index += stride) {
    const at = index * 4;
    if ((image.rgba[at + 3] ?? 255) === 0) continue;
    const lab = rgbToLab(
      image.rgba[at] ?? 0,
      image.rgba[at + 1] ?? 0,
      image.rgba[at + 2] ?? 0,
    );
    for (let c = 0; c < 3; c += 1) {
      const value = lab[c] as number;
      sum[c] = (sum[c] as number) + value;
      sumSquares[c] = (sumSquares[c] as number) + value * value;
    }
    n += 1;
  }

  if (n === 0) {
    return { mean: [0, 0, 0], deviation: [0, 0, 0], samples: 0 };
  }

  const mean: [number, number, number] = [
    (sum[0] as number) / n,
    (sum[1] as number) / n,
    (sum[2] as number) / n,
  ];
  const deviation: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const average = mean[c] as number;
    const variance = (sumSquares[c] as number) / n - average * average;
    deviation[c] = Math.sqrt(Math.max(0, variance));
  }

  return { mean, deviation, samples: n };
}

/**
 * How far apart two shots are, as one number.
 *
 * Roughly a Lab distance between their averages, with the spread difference
 * folded in — so two shots that share an average but differ wildly in contrast
 * are not reported as identical. Under about 2 is invisible; over about 10 will
 * read as a different setup in a cut.
 */
export function colourDistance(a: ColourStats, b: ColourStats): number {
  if (a.samples === 0 || b.samples === 0) return 0;
  let sum = 0;
  for (let c = 0; c < 3; c += 1) {
    const meanDelta = (a.mean[c] as number) - (b.mean[c] as number);
    const spreadDelta = (a.deviation[c] as number) - (b.deviation[c] as number);
    sum += meanDelta * meanDelta + spreadDelta * spreadDelta * 0.25;
  }
  return Math.sqrt(sum);
}

/* ------------------------------------------------------------ matching --- */

/**
 * Moves an image's colour statistics onto a reference's.
 *
 * `amount` scales the whole correction, because a full match is rarely what an
 * artist wants — it will happily flatten a deliberately warm shot into a
 * neutral one. Partial is the useful default.
 *
 * A channel whose spread is near zero is left alone rather than divided by:
 * a flat grey frame has no contrast to scale, and scaling it would amplify
 * whatever noise it does have into the whole range.
 */
export function matchColour(
  image: RasterImage,
  from: ColourStats,
  to: ColourStats,
  amount = 1,
): RasterImage {
  const out = new Uint8Array(image.rgba.length);
  const strength = Math.max(0, Math.min(1, amount));

  const scale: [number, number, number] = [1, 1, 1];
  for (let c = 0; c < 3; c += 1) {
    const source = from.deviation[c] as number;
    const target = to.deviation[c] as number;
    scale[c] = source > 0.5 ? target / source : 1;
  }

  for (let at = 0; at < image.rgba.length; at += 4) {
    const lab = rgbToLab(
      image.rgba[at] ?? 0,
      image.rgba[at + 1] ?? 0,
      image.rgba[at + 2] ?? 0,
    );

    const corrected: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c += 1) {
      const centred = (lab[c] as number) - (from.mean[c] as number);
      const moved = centred * (scale[c] as number) + (to.mean[c] as number);
      corrected[c] = (lab[c] as number) + (moved - (lab[c] as number)) * strength;
    }

    const [r, g, b] = labToRgb(corrected[0], corrected[1], corrected[2]);
    out[at] = r;
    out[at + 1] = g;
    out[at + 2] = b;
    out[at + 3] = image.rgba[at + 3] ?? 255;
  }

  return { width: image.width, height: image.height, rgba: out };
}

/* ------------------------------------------------------------ proposing -- */

/**
 * A per-channel linear map, in the form After Effects' Levels effect holds.
 *
 * `out = (in - inputBlack) * 255 / (inputWhite - inputBlack)`, per channel,
 * which is exactly what Levels does with gamma left at 1.
 */
export interface LevelsProposal {
  red: { inputBlack: number; inputWhite: number };
  green: { inputBlack: number; inputWhite: number };
  blue: { inputBlack: number; inputWhite: number };
}

/**
 * A correction the artist can see, adjust and disagree with.
 *
 * The measurement is Lab because Lab separates exposure from cast. The
 * *proposal* is a per-channel linear map because that is what an adjustment
 * layer can actually hold — Levels, three channels, no gamma. Those are
 * different jobs and it is worth being plain that this is a fit rather than
 * the correction itself.
 *
 * Fitted rather than derived: the Lab transfer is applied to a sample of real
 * pixels, and a least-squares line is fitted from each source channel to its
 * corrected value. Deriving the numbers from channel statistics alone would
 * assume the correction is linear in RGB, which it is not — fitting measures
 * how well a line can stand in for it, and `residual` reports that honestly.
 *
 * A residual above roughly 6 means the drift is not a linear per-channel
 * shift, and Levels will not express it well however the numbers are chosen.
 */
export function proposeLevels(
  image: RasterImage,
  from: ColourStats,
  to: ColourStats,
  amount = 1,
  maxSamples = 40_000,
): { levels: LevelsProposal; residual: number; samples: number } {
  const total = image.width * image.height;
  const stride = Math.max(1, Math.floor(total / maxSamples));

  // Sums for a least-squares fit of y = m*x + c, per channel.
  const n = [0, 0, 0];
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  const sxx = [0, 0, 0];
  const sxy = [0, 0, 0];
  let residualSum = 0;
  let residualCount = 0;

  const scale: [number, number, number] = [1, 1, 1];
  for (let c = 0; c < 3; c += 1) {
    const source = from.deviation[c] as number;
    const target = to.deviation[c] as number;
    scale[c] = source > 0.5 ? target / source : 1;
  }
  const strength = Math.max(0, Math.min(1, amount));

  const corrected: number[] = [0, 0, 0];
  for (let index = 0; index < total; index += stride) {
    const at = index * 4;
    if ((image.rgba[at + 3] ?? 255) === 0) continue;

    const r = image.rgba[at] ?? 0;
    const g = image.rgba[at + 1] ?? 0;
    const b = image.rgba[at + 2] ?? 0;

    const lab = rgbToLab(r, g, b);
    for (let c = 0; c < 3; c += 1) {
      const centred = (lab[c] as number) - (from.mean[c] as number);
      const moved = centred * (scale[c] as number) + (to.mean[c] as number);
      corrected[c] = (lab[c] as number) + (moved - (lab[c] as number)) * strength;
    }
    const wanted = labToRgb(
      corrected[0] as number,
      corrected[1] as number,
      corrected[2] as number,
    );

    const source = [r, g, b];
    for (let c = 0; c < 3; c += 1) {
      const x = source[c] as number;
      const y = wanted[c] as number;
      n[c] = (n[c] as number) + 1;
      sx[c] = (sx[c] as number) + x;
      sy[c] = (sy[c] as number) + y;
      sxx[c] = (sxx[c] as number) + x * x;
      sxy[c] = (sxy[c] as number) + x * y;
    }
  }

  const fitted: Array<{ inputBlack: number; inputWhite: number }> = [];
  const slopes: number[] = [];
  const intercepts: number[] = [];

  for (let c = 0; c < 3; c += 1) {
    const count = n[c] as number;
    let slope = 1;
    let intercept = 0;
    if (count > 1) {
      const denominator = count * (sxx[c] as number) - (sx[c] as number) * (sx[c] as number);
      if (Math.abs(denominator) > 1e-6) {
        slope = (count * (sxy[c] as number) - (sx[c] as number) * (sy[c] as number)) / denominator;
        intercept = ((sy[c] as number) - slope * (sx[c] as number)) / count;
      }
    }
    /*
     * A slope at or below zero would invert the image, and one that is
     * enormous would clip everything — neither is a correction anybody asked
     * for, so the fit is bounded rather than trusted.
     */
    slope = Math.max(0.2, Math.min(5, slope));
    slopes.push(slope);
    intercepts.push(intercept);

    const inputBlack = -intercept / slope;
    fitted.push({
      inputBlack: Number(inputBlack.toFixed(2)),
      inputWhite: Number((inputBlack + 255 / slope).toFixed(2)),
    });
  }

  // How much of the correction the straight line failed to carry.
  for (let index = 0; index < total; index += stride * 4) {
    const at = index * 4;
    if ((image.rgba[at + 3] ?? 255) === 0) continue;
    const r = image.rgba[at] ?? 0;
    const g = image.rgba[at + 1] ?? 0;
    const b = image.rgba[at + 2] ?? 0;
    const lab = rgbToLab(r, g, b);
    for (let c = 0; c < 3; c += 1) {
      const centred = (lab[c] as number) - (from.mean[c] as number);
      const moved = centred * (scale[c] as number) + (to.mean[c] as number);
      corrected[c] = (lab[c] as number) + (moved - (lab[c] as number)) * strength;
    }
    const wanted = labToRgb(
      corrected[0] as number,
      corrected[1] as number,
      corrected[2] as number,
    );
    const source = [r, g, b];
    for (let c = 0; c < 3; c += 1) {
      const predicted =
        (source[c] as number) * (slopes[c] as number) + (intercepts[c] as number);
      residualSum += Math.abs(predicted - (wanted[c] as number));
      residualCount += 1;
    }
  }

  return {
    levels: {
      red: fitted[0] as { inputBlack: number; inputWhite: number },
      green: fitted[1] as { inputBlack: number; inputWhite: number },
      blue: fitted[2] as { inputBlack: number; inputWhite: number },
    },
    residual: residualCount > 0 ? Number((residualSum / residualCount).toFixed(2)) : 0,
    samples: n[0] as number,
  };
}
