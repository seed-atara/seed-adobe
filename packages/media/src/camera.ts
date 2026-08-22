import type { RasterImage } from "./png.js";

/**
 * Measuring the camera out of a shot.
 *
 * Lighting is only half of why two shots refuse to cut together. The other
 * half is the *camera*: how the corners fall off, how the channels separate
 * towards the edge of the frame, how much grain sits in the midtones, how far
 * a clipped highlight bleeds into the red channel. A colourist matches those
 * by eye because no tool offers to measure them.
 *
 * All of it is measurable on a single frame, none of it needs a model, and
 * SEED already has an engine with exactly these parameters — the film look.
 * So this is the same trick as the lighting solve, applied to the optics: turn
 * a matching-by-eye job into a measurement.
 *
 * Every measurement here is deliberately conservative. A wrong number applied
 * confidently is worse than no number, so each one reports a `confidence`
 * alongside its value, and a low confidence means the frame did not contain
 * the evidence — a shot with no clipped highlights cannot tell you anything
 * about halation, and saying so is the honest answer.
 */

export interface Measured {
  value: number;
  /** 0–1. How much the frame actually supported this number. */
  confidence: number;
}

export interface CameraSignature {
  /** Corner falloff, in the film look's `vignette` units. */
  vignette: Measured;
  /** Lateral chromatic aberration, in `ca_lateral` units. */
  aberration: Measured;
  /** Grain strength, in `grain_scale` units. */
  grain: Measured;
  /** Grain size, in `grain_size` units. */
  grainSize: Measured;
  /** Halation strength, in `halation_scale` units. */
  halation: Measured;
  /** What the frame could not answer, in words. */
  notes: string[];
}

function luma(image: RasterImage, at: number): number {
  return (
    0.2126 * (image.rgba[at] ?? 0) +
    0.7152 * (image.rgba[at + 1] ?? 0) +
    0.0722 * (image.rgba[at + 2] ?? 0)
  );
}

/**
 * Corner falloff, as the ratio of edge brightness to centre brightness.
 *
 * Measured in rings rather than at a few sample points, because a bright
 * object near one corner would otherwise be read as the lens. Averaging a
 * whole annulus makes a single object a small part of a large number.
 *
 * The confidence is low when the frame's own content varies more between rings
 * than the falloff being measured — a shot of a sunset is mostly a gradient,
 * and no amount of care separates that from a vignette on one frame.
 */
export function measureVignette(image: RasterImage): Measured {
  const { width, height } = image;
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.sqrt(cx * cx + cy * cy);

  const rings = 8;
  const sums = new Array<number>(rings).fill(0);
  const counts = new Array<number>(rings).fill(0);
  const squares = new Array<number>(rings).fill(0);

  const stride = Math.max(1, Math.floor((width * height) / 200_000));
  for (let index = 0; index < width * height; index += stride) {
    const x = index % width;
    const y = Math.floor(index / width);
    const at = index * 4;
    if ((image.rgba[at + 3] ?? 255) === 0) continue;

    const dx = x - cx;
    const dy = y - cy;
    const radius = Math.sqrt(dx * dx + dy * dy) / maxRadius;
    const ring = Math.min(rings - 1, Math.floor(radius * rings));
    const value = luma(image, at);
    sums[ring] = (sums[ring] as number) + value;
    squares[ring] = (squares[ring] as number) + value * value;
    counts[ring] = (counts[ring] as number) + 1;
  }

  const mean = (ring: number): number =>
    (counts[ring] as number) > 0 ? (sums[ring] as number) / (counts[ring] as number) : 0;

  const centre = (mean(0) + mean(1)) / 2;
  const edge = (mean(rings - 2) + mean(rings - 1)) / 2;
  if (centre < 8) {
    return { value: 0, confidence: 0 };
  }

  const falloff = Math.max(0, 1 - edge / centre);

  /*
   * Confidence from *shape*, not from strength.
   *
   * A real vignette falls off smoothly and monotonically with radius. A
   * subject on a black background falls off too — abruptly, at whatever radius
   * the subject ends — and measured on strength alone the two are
   * indistinguishable. A product shot came back claiming a 0.92 vignette it
   * did not have.
   *
   * So the ring profile is fitted against the quadratic a lens actually
   * produces, `1 - k·r²`, and the confidence is how well it fits. A step
   * fits badly; a lens fits well.
   */
  let error = 0;
  let counted = 0;
  for (let ring = 0; ring < rings; ring += 1) {
    if ((counts[ring] as number) < 2) continue;
    const radius = (ring + 0.5) / rings;
    const predicted = centre * (1 - falloff * radius * radius);
    error += Math.abs(mean(ring) - predicted);
    counted += 1;
  }
  const misfit = counted > 0 ? error / counted / Math.max(1, centre) : 1;

  /*
   * And a frame whose own content varies more within a ring than the falloff
   * varies between rings cannot be measured either — a sunset is a gradient.
   */
  let spread = 0;
  for (let ring = 0; ring < rings; ring += 1) {
    const n = counts[ring] as number;
    if (n < 2) continue;
    const m = mean(ring);
    spread += Math.sqrt(Math.max(0, (squares[ring] as number) / n - m * m));
  }
  spread /= rings;
  const separable = Math.min(1, Math.abs(centre - edge) / (spread + 1e-3) / 2);

  const confidence = Math.max(0, Math.min(1, (1 - Math.min(1, misfit * 6)) * separable));

  return { value: Number(falloff.toFixed(4)), confidence: Number(confidence.toFixed(2)) };
}

/**
 * Lateral chromatic aberration, from how far red and blue edges disagree.
 *
 * Real lateral CA grows with distance from the centre and vanishes at it, so
 * the measurement compares channel misalignment in the outer third against the
 * inner third. A frame with coloured *subject* edges — a red coat against a
 * blue wall — produces misalignment everywhere, and the ratio is what
 * distinguishes a lens from a wardrobe.
 */
export function measureAberration(image: RasterImage): Measured {
  const { width, height } = image;
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.sqrt(cx * cx + cy * cy);

  let inner = 0;
  let innerCount = 0;
  let outer = 0;
  let outerCount = 0;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 400));
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const at = (y * width + x) * 4;
      const right = (y * width + x + step) * 4;

      // Horizontal edge strength per channel.
      const dr = Math.abs((image.rgba[right] ?? 0) - (image.rgba[at] ?? 0));
      const db = Math.abs((image.rgba[right + 2] ?? 0) - (image.rgba[at + 2] ?? 0));
      const edge = Math.max(dr, db);
      if (edge < 12) continue; // no edge here to measure

      // How much the two channels disagree about the edge, relative to it.
      const disagreement = Math.abs(dr - db) / edge;

      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.sqrt(dx * dx + dy * dy) / maxRadius;
      if (radius < 0.35) {
        inner += disagreement;
        innerCount += 1;
      } else if (radius > 0.65) {
        outer += disagreement;
        outerCount += 1;
      }
    }
  }

  if (innerCount < 30 || outerCount < 30) {
    return { value: 0, confidence: 0 };
  }

  const innerMean = inner / innerCount;
  const outerMean = outer / outerCount;
  // Only the part that *grows* outward is the lens.
  const radial = Math.max(0, outerMean - innerMean);

  return {
    value: Number((radial * 0.01).toFixed(5)),
    confidence: Number(Math.min(1, Math.min(innerCount, outerCount) / 400).toFixed(2)),
  };
}

/**
 * Grain, as the high-frequency residual left after a small blur.
 *
 * Measured in the midtones only. Shadows are where compression noise lives and
 * highlights are where clipping flattens everything, so both would answer a
 * question about grain with something else.
 *
 * Size comes from how far the residual stays correlated: fine grain decorrelates
 * in a pixel, coarse grain takes several.
 */
export function measureGrain(image: RasterImage): { amount: Measured; size: Measured } {
  const { width, height } = image;
  if (width < 16 || height < 16) {
    return { amount: { value: 0, confidence: 0 }, size: { value: 0.5, confidence: 0 } };
  }

  const at = (x: number, y: number): number =>
    luma(image, (Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 4);

  let sum = 0;
  let count = 0;
  let correlated = 0;
  let correlatedCount = 0;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
  for (let y = 2; y < height - 2; y += step) {
    for (let x = 2; x < width - 2; x += step) {
      const centre = at(x, y);
      if (centre < 40 || centre > 210) continue; // midtones only

      /*
       * Flat neighbourhoods only.
       *
       * Grain is the residual in a *flat* area. Measured across an edge, the
       * edge is the residual — and a product shot on black, which is all
       * edges, came back reading maximum grain. Skipping anywhere the
       * five-pixel span is already varying strongly is what separates the two.
       */
      const span =
        Math.max(at(x - 2, y), at(x + 2, y), at(x, y - 2), at(x, y + 2)) -
        Math.min(at(x - 2, y), at(x + 2, y), at(x, y - 2), at(x, y + 2));
      if (span > 18) continue;

      // 3x3 mean, so the residual is what a small blur would remove.
      let local = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) local += at(x + dx, y + dy);
      }
      local /= 9;

      const residual = centre - local;
      sum += Math.abs(residual);
      count += 1;

      // Does the neighbour's residual agree? Coarse grain says yes.
      const neighbour = at(x + 1, y);
      let neighbourLocal = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) neighbourLocal += at(x + 1 + dx, y + dy);
      }
      neighbourLocal /= 9;
      const neighbourResidual = neighbour - neighbourLocal;
      if (Math.abs(residual) > 0.5) {
        correlated += residual * neighbourResidual > 0 ? 1 : 0;
        correlatedCount += 1;
      }
    }
  }

  if (count < 100) {
    return { amount: { value: 0, confidence: 0 }, size: { value: 0.5, confidence: 0 } };
  }

  const mean = sum / count;
  /*
   * Scaled into the film look's own units, where 0.5 is the authored default
   * and roughly two code values of residual. This is a calibration, not a
   * physical constant, and it is stated here rather than buried.
   */
  const amount = Math.max(0, Math.min(3, (mean / 2) * 0.5));

  // Half agreement is pure noise; full agreement is a smooth image.
  const agreement = correlatedCount > 0 ? correlated / correlatedCount : 0.5;
  const size = Math.max(0, Math.min(4, (agreement - 0.5) * 4));

  return {
    amount: { value: Number(amount.toFixed(3)), confidence: Number(Math.min(1, count / 2000).toFixed(2)) },
    size: {
      value: Number(size.toFixed(3)),
      confidence: Number(Math.min(1, correlatedCount / 1000).toFixed(2)),
    },
  };
}

/**
 * Halation, from how much red bleeds around a clipped highlight.
 *
 * Film halation is light scattering back through the emulsion base, and it is
 * red because red penetrates furthest. So: find the pixels that are clipped,
 * look at the ring just outside them, and ask how much redder that ring is
 * than the picture as a whole.
 *
 * A frame with no clipped highlights cannot answer, and reports zero
 * confidence rather than zero halation. Those are different statements.
 */
export function measureHalation(image: RasterImage): Measured {
  const { width, height } = image;
  const radius = Math.max(2, Math.round(Math.min(width, height) * 0.01));

  let ringRedness = 0;
  let ringCount = 0;
  let overallRedness = 0;
  let overallCount = 0;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
  const isClipped = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return luma(image, (y * width + x) * 4) > 244;
  };

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const at = (y * width + x) * 4;
      const r = image.rgba[at] ?? 0;
      const g = image.rgba[at + 1] ?? 0;
      const b = image.rgba[at + 2] ?? 0;
      const redness = r - (g + b) / 2;

      overallRedness += redness;
      overallCount += 1;

      if (isClipped(x, y)) continue; // the highlight itself, not its halo
      // Is there a clipped pixel within a halation radius?
      const near =
        isClipped(x + radius, y) ||
        isClipped(x - radius, y) ||
        isClipped(x, y + radius) ||
        isClipped(x, y - radius);
      if (!near) continue;

      ringRedness += redness;
      ringCount += 1;
    }
  }

  if (ringCount < 20 || overallCount < 100) {
    return { value: 0, confidence: 0 };
  }

  const excess = ringRedness / ringCount - overallRedness / overallCount;
  // Into the film look's halation_scale units, where 0.5 is the default.
  const value = Math.max(0, Math.min(3, (excess / 12) * 0.5));

  return {
    value: Number(value.toFixed(3)),
    confidence: Number(Math.min(1, ringCount / 200).toFixed(2)),
  };
}

/** Everything the frame will say about the camera that shot it. */
export function measureCamera(image: RasterImage): CameraSignature {
  const vignette = measureVignette(image);
  const aberration = measureAberration(image);
  const grain = measureGrain(image);
  const halation = measureHalation(image);

  const notes: string[] = [];
  if (vignette.confidence < 0.3) {
    notes.push(
      "The frame's own brightness varies more than any falloff, so the vignette could not be separated from the picture.",
    );
  }
  if (aberration.confidence < 0.3) {
    notes.push("Too few coloured edges away from the centre to measure aberration.");
  }
  if (grain.amount.confidence < 0.3) {
    notes.push("Not enough midtone to measure grain — try a frame that is not mostly black or blown out.");
  }
  if (halation.confidence < 0.3) {
    notes.push("No clipped highlights, so this frame cannot say anything about halation.");
  }

  return {
    vignette,
    aberration,
    grain: grain.amount,
    grainSize: grain.size,
    halation,
    notes,
  };
}
