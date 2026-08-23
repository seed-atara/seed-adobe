import { estimateTranslation, type FrameOffset, type TrackOptions } from "./mosaic.js";
import type { RasterImage } from "./png.js";

/**
 * Planar alignment — the transform between two frames, not just the offset.
 *
 * A translation has two degrees of freedom and cannot express a camera that
 * rolls, breathes on the lens, or tilts. Real handheld footage does all three
 * constantly, which is why a translation-only match degrades on it and starts
 * rejecting frames. Mocha's Mega Plate tracks a *plane* for exactly this
 * reason; this is the same idea, built out of the translation matcher that is
 * already here and tested.
 *
 * The method is deliberately not feature detection:
 *
 *   1. Cut the frame into a grid of patches.
 *   2. Measure each patch's own translation with the existing matcher. That
 *      gives a scattered set of point correspondences, each with a confidence.
 *   3. Fit a homography through them with RANSAC.
 *
 * Step 3 is what makes it robust. A subject walking through frame moves its
 * patches differently from the background, and parallax does the same to the
 * near ones — RANSAC calls those outliers and fits the plane the majority
 * agree on, which is the background. A least-squares fit through everything
 * would be dragged towards the actor.
 */

/** Row-major 3x3. `h[8]` is normalised to 1. */
export type Homography = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export interface PlanarFit {
  matrix: Homography;
  /** Share of patches the fit explains, 0..1. */
  confidence: number;
  /** How many patches agreed. Below a handful, treat the fit as a guess. */
  inliers: number;
  /** Patches that produced a usable correspondence at all. */
  candidates: number;
}

export function applyHomography(
  h: Homography,
  x: number,
  y: number,
): { x: number; y: number } {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return { x, y };
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

export function multiply(a: Homography, b: Homography): Homography {
  const out = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      let sum = 0;
      for (let k = 0; k < 3; k += 1) sum += (a[r * 3 + k] as number) * (b[k * 3 + c] as number);
      out[r * 3 + c] = sum;
    }
  }
  const scale = (out[8] as number) === 0 ? 1 : (out[8] as number);
  return out.map((value) => (value as number) / scale) as unknown as Homography;
}

/** Gauss-Jordan with partial pivoting. Small systems, so no need for anything cleverer. */
function solve(matrix: number[][], rhs: number[]): number[] | undefined {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i] as number]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs((a[row] as number[])[col] as number) > Math.abs((a[pivot] as number[])[col] as number)) {
        pivot = row;
      }
    }
    if (Math.abs((a[pivot] as number[])[col] as number) < 1e-10) return undefined;
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];

    const head = a[col] as number[];
    const lead = head[col] as number;
    for (let k = col; k <= n; k += 1) head[k] = (head[k] as number) / lead;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const current = a[row] as number[];
      const factor = current[col] as number;
      if (factor === 0) continue;
      for (let k = col; k <= n; k += 1) {
        current[k] = (current[k] as number) - factor * (head[k] as number);
      }
    }
  }
  return a.map((row) => (row as number[])[n] as number);
}

export interface Correspondence {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  confidence: number;
}

/**
 * Fits a homography through point pairs.
 *
 * Four pairs determine one exactly; more are solved in the least-squares sense.
 * Coordinates are shifted and scaled first — the classic normalisation — because
 * raw pixel values put terms of wildly different magnitude in the same matrix
 * and the solve loses precision.
 */
export function fitHomography(points: Correspondence[]): Homography | undefined {
  if (points.length < 4) return undefined;

  const mean = points.reduce(
    (acc, p) => ({
      fx: acc.fx + p.fromX / points.length,
      fy: acc.fy + p.fromY / points.length,
      tx: acc.tx + p.toX / points.length,
      ty: acc.ty + p.toY / points.length,
    }),
    { fx: 0, fy: 0, tx: 0, ty: 0 },
  );
  const spread = (values: number[]) => {
    const s = Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length);
    return s < 1e-9 ? 1 : Math.SQRT2 / s;
  };
  const sf = spread(points.flatMap((p) => [p.fromX - mean.fx, p.fromY - mean.fy]));
  const st = spread(points.flatMap((p) => [p.toX - mean.tx, p.toY - mean.ty]));

  const rows: number[][] = [];
  const rhs: number[] = [];
  for (const p of points) {
    const x = (p.fromX - mean.fx) * sf;
    const y = (p.fromY - mean.fy) * sf;
    const u = (p.toX - mean.tx) * st;
    const v = (p.toY - mean.ty) * st;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }

  // Normal equations, so an over-determined system needs no SVD.
  const n = 8;
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const atb: number[] = new Array<number>(n).fill(0);
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r] as number[];
    for (let i = 0; i < n; i += 1) {
      atb[i] = (atb[i] as number) + (row[i] as number) * (rhs[r] as number);
      for (let j = 0; j < n; j += 1) {
        (ata[i] as number[])[j] =
          ((ata[i] as number[])[j] as number) + (row[i] as number) * (row[j] as number);
      }
    }
  }

  const solved = solve(ata, atb);
  if (!solved) return undefined;

  const normalised: Homography = [
    solved[0] as number, solved[1] as number, solved[2] as number,
    solved[3] as number, solved[4] as number, solved[5] as number,
    solved[6] as number, solved[7] as number, 1,
  ];

  // Undo the normalisation: T_to^-1 * H * T_from
  const tFrom: Homography = [sf, 0, -sf * mean.fx, 0, sf, -sf * mean.fy, 0, 0, 1];
  const tToInv: Homography = [1 / st, 0, mean.tx, 0, 1 / st, mean.ty, 0, 0, 1];
  return multiply(tToInv, multiply(normalised, tFrom));
}

export interface AlignOptions extends TrackOptions {
  /** Patches across and down. More is slower and more robust. */
  grid?: { x: number; y: number };
  /** Reprojection error, in pixels, that still counts as agreement. */
  inlierTolerance?: number;
  /** RANSAC rounds. */
  iterations?: number;
}

function cropPatch(
  image: RasterImage,
  x0: number,
  y0: number,
  width: number,
  height: number,
): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, x0 + x));
      const sy = Math.min(image.height - 1, Math.max(0, y0 + y));
      const from = (sy * image.width + sx) * 4;
      const to = (y * width + x) * 4;
      rgba[to] = image.rgba[from] as number;
      rgba[to + 1] = image.rgba[from + 1] as number;
      rgba[to + 2] = image.rgba[from + 2] as number;
      rgba[to + 3] = 255;
    }
  }
  return { width, height, rgba };
}

/**
 * Point correspondences from a grid of local matches.
 *
 * Each patch is matched independently, so a patch on a moving subject reports
 * the subject's motion and a patch on the background reports the camera's. The
 * fit below decides which is which.
 */
export function gridCorrespondences(
  a: RasterImage,
  b: RasterImage,
  options: AlignOptions = {},
): Correspondence[] {
  const gx = options.grid?.x ?? 6;
  const gy = options.grid?.y ?? 4;
  const pw = Math.floor(a.width / gx);
  const ph = Math.floor(a.height / gy);
  if (pw < 24 || ph < 24) return [];

  /*
   * One global match first, used as the prior for every patch.
   *
   * Without it each patch searched the whole frame for itself: 24 full searches
   * a pair, which measured at 19.5 seconds on a 1080-square frame and blocked
   * the service for minutes. The camera's overall motion is the answer every
   * patch is near, so measuring it once and letting each patch refine within a
   * few pixels of it costs a fraction and finds the same planes.
   */
  const global = estimateTranslation(a, b, options);
  const seed = global.confidence > 0 ? { x: global.x, y: global.y } : { x: 0, y: 0 };
  const local: AlignOptions = {
    ...options,
    seed,
    maxShift: options.maxShift ?? 24,
    sampleTarget: options.sampleTarget ?? 1024,
  };

  const found: Correspondence[] = [];
  for (let row = 0; row < gy; row += 1) {
    for (let col = 0; col < gx; col += 1) {
      const x0 = col * pw;
      const y0 = row * ph;
      /*
       * The patch is matched against the *same* window of the other frame, so
       * the measured offset is that patch's local motion. Context around it is
       * included by taking a slightly larger window from b, which the matcher
       * searches within.
       */
      const patchA = cropPatch(a, x0, y0, pw, ph);
      const patchB = cropPatch(b, x0, y0, pw, ph);
      const offset = estimateTranslation(patchA, patchB, local);
      if (offset.confidence <= 0) continue;
      found.push({
        fromX: x0 + pw / 2,
        fromY: y0 + ph / 2,
        // `estimateTranslation` reports where a's content moved to in b.
        toX: x0 + pw / 2 + offset.x,
        toY: y0 + ph / 2 + offset.y,
        confidence: offset.confidence,
      });
    }
  }
  return found;
}

/**
 * The plane the majority of the frame agrees on.
 *
 * RANSAC rather than least squares, because the minority that disagrees is
 * exactly the thing that must not influence the answer: a walking subject, a
 * foreground object with parallax, a patch of sky that matched nothing.
 */
export function fitPlane(
  points: Correspondence[],
  options: AlignOptions = {},
): PlanarFit {
  const tolerance = options.inlierTolerance ?? 2.5;
  const iterations = options.iterations ?? 200;
  const usable = points.filter((p) => p.confidence > 0.05);

  if (usable.length < 4) {
    return { matrix: IDENTITY, confidence: 0, inliers: 0, candidates: usable.length };
  }

  const errorOf = (h: Homography, p: Correspondence) => {
    const mapped = applyHomography(h, p.fromX, p.fromY);
    return Math.hypot(mapped.x - p.toX, mapped.y - p.toY);
  };

  let best: { matrix: Homography; inliers: Correspondence[] } = {
    matrix: IDENTITY,
    inliers: [],
  };

  for (let round = 0; round < iterations; round += 1) {
    // Deterministic sampling: the same shot must give the same plate.
    const pick: Correspondence[] = [];
    for (let k = 0; k < 4; k += 1) {
      let h = Math.imul(round + 1, 374761393) ^ Math.imul(k + 1, 668265263);
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      pick.push(usable[((h ^ (h >>> 16)) >>> 0) % usable.length] as Correspondence);
    }
    const candidate = fitHomography(pick);
    if (!candidate) continue;

    const inliers = usable.filter((p) => errorOf(candidate, p) <= tolerance);
    if (inliers.length > best.inliers.length) best = { matrix: candidate, inliers };
    if (best.inliers.length === usable.length) break;
  }

  if (best.inliers.length < 4) {
    return { matrix: IDENTITY, confidence: 0, inliers: 0, candidates: usable.length };
  }

  // Refit through everything that agreed, which is more accurate than the four.
  const refined = fitHomography(best.inliers) ?? best.matrix;
  const inliers = usable.filter((p) => errorOf(refined, p) <= tolerance);

  return {
    matrix: inliers.length >= best.inliers.length ? refined : best.matrix,
    confidence: Number((inliers.length / usable.length).toFixed(3)),
    inliers: inliers.length,
    candidates: usable.length,
  };
}

/** The transform taking `a`'s content to where it lands in `b`. */
export function estimatePlane(
  a: RasterImage,
  b: RasterImage,
  options: AlignOptions = {},
): PlanarFit {
  return fitPlane(gridCorrespondences(a, b, options), options);
}

/** Translation, rotation and scale read off a transform, for a comp to key. */
export function decompose(h: Homography): {
  x: number;
  y: number;
  rotationDegrees: number;
  scale: number;
} {
  const a = h[0] as number;
  const b = h[1] as number;
  const d = h[3] as number;
  const e = h[4] as number;
  return {
    x: h[2] as number,
    y: h[5] as number,
    rotationDegrees: (Math.atan2(d, a) * 180) / Math.PI,
    scale: Math.hypot(a, d),
  };
}

/** Inverse of a 3x3, by adjugate. Small and exact enough for a transform. */
export function invert(h: Homography): Homography | undefined {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det =
    a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-12) return undefined;
  const out = [
    e * j - f * i, c * i - b * j, b * f - c * e,
    f * g - d * j, a * j - c * g, c * d - a * f,
    d * i - e * g, b * g - a * i, a * e - b * d,
  ].map((value) => value / det);
  const scale = (out[8] as number) === 0 ? 1 : (out[8] as number);
  return out.map((value) => (value as number) / scale) as unknown as Homography;
}

export interface PlaneTrack {
  /**
   * Frame-zero coordinates to frame-f coordinates, per frame.
   *
   * This direction, not the other, because warping pulls: to fill a plate pixel
   * you ask which source pixel it came from. Pushing pixels forward leaves holes
   * wherever the transform stretches.
   */
  planes: Homography[];
  /** Where each frame's top-left lands in frame-zero space. */
  offsets: FrameOffset[];
  /** Frames whose plane could not be fitted and were held in place. */
  rejected: number;
  travel: { x: number; y: number };
}

/**
 * Planar track across a shot.
 *
 * Each step is measured against the frame before it and composed, the same
 * accumulation the translation track uses — and with the same caveat, that
 * error compounds along the chain. What is different is that a frame which
 * rolls or breathes now contributes correctly instead of being rejected.
 */
export function trackPlanes(
  frames: RasterImage[],
  options: AlignOptions = {},
): PlaneTrack {
  const minConfidence = options.minConfidence ?? 0.15;
  const planes: Homography[] = [IDENTITY];
  const offsets: FrameOffset[] = [{ x: 0, y: 0, confidence: 1 }];
  let cumulative: Homography = IDENTITY;
  let rejected = 0;

  for (let i = 1; i < frames.length; i += 1) {
    const step = estimatePlane(
      frames[i - 1] as RasterImage,
      frames[i] as RasterImage,
      options,
    );
    if (step.confidence < minConfidence) {
      rejected += 1;
      // Hold position: a bad step would displace every frame after it.
      planes.push(cumulative);
      const held = offsets[offsets.length - 1] as FrameOffset;
      offsets.push({ x: held.x, y: held.y, confidence: step.confidence });
      continue;
    }

    cumulative = multiply(step.matrix, cumulative);
    planes.push(cumulative);

    const back = invert(cumulative);
    const corner = back ? applyHomography(back, 0, 0) : { x: 0, y: 0 };
    offsets.push({
      x: Math.round(corner.x),
      y: Math.round(corner.y),
      confidence: step.confidence,
    });
  }

  const xs = offsets.map((o) => o.x);
  const ys = offsets.map((o) => o.y);
  return {
    planes,
    offsets,
    rejected,
    travel: {
      x: Math.max(...xs) - Math.min(...xs),
      y: Math.max(...ys) - Math.min(...ys),
    },
  };
}
