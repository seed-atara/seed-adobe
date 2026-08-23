import { fitWithin, resize } from "./resize.js";
import type { RasterImage } from "./png.js";

/**
 * Recovering the edges of a shot from the shot itself.
 *
 * Every reframing tool on the market — Luma Reframe, Runway Expand — *invents*
 * the new edges. On a locked-off shot that is the only option. On a shot that
 * moves it throws away the answer: when a camera pans right, the pixels that
 * belong to the right of frame one were photographed, they are simply in a
 * later frame.
 *
 * So this measures the motion, projects every frame into one canvas, and fills
 * the expanded area with real pixels wherever any frame saw them. What is left
 * over — what no frame ever saw — comes back as a mask, so a generator can be
 * asked to complete a picture rather than guess at one.
 *
 * The recovered area is correct by construction and temporally stable by
 * construction, because it is photography rather than a per-frame invention.
 *
 * **Honest limits, stated here and reported per shot.**
 * - Translation only. A pan or a tilt recovers exactly; a dolly does not,
 *   because a translating camera sees genuinely different geometry and no 2D
 *   offset expresses parallax. Rotation and zoom are not modelled either; they
 *   show up as low confidence rather than as a confident wrong answer.
 * - Moving subjects would smear. The accumulation takes a per-pixel median
 *   rather than a mean, so a subject crossing a background pixel is outvoted by
 *   the frames that saw the background — provided enough frames did.
 * - A shot that never moves recovers nothing, and says so with 0% coverage.
 */

export interface FrameOffset {
  /** Where this frame sits relative to the first, in pixels. */
  x: number;
  y: number;
  /**
   * How far the match stood clear of the alternatives, 0..1.
   *
   * Low means the frame did not contain the evidence — a featureless sky, a
   * dissolve, or motion this model cannot express. A low-confidence frame is
   * excluded rather than allowed to smear the result.
   */
  confidence: number;
}

export interface TrackOptions {
  /** Largest offset searched between consecutive frames, in source pixels. */
  maxShift?: number;
  /** Working height for the search. Lower is faster and less precise. */
  workingHeight?: number;
  /** Frames below this confidence stop contributing. */
  minConfidence?: number;
}

/**
 * A deterministic stand-in for a random source.
 *
 * The reservoir needs to choose a slot without `Math.random`, because the same
 * shot must always produce the same plate — a mosaic that differs between runs
 * cannot be compared, cached, or trusted in a comp.
 */
function mix(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Luma at a working size, which is all the matcher needs. */
function luminance(image: RasterImage): Float32Array {
  const out = new Float32Array(image.width * image.height);
  for (let i = 0; i < out.length; i += 1) {
    const at = i * 4;
    out[i] =
      0.2126 * (image.rgba[at] as number) +
      0.7152 * (image.rgba[at + 1] as number) +
      0.0722 * (image.rgba[at + 2] as number);
  }
  return out;
}

/**
 * Mean absolute difference over the overlap, with the worst samples dropped.
 *
 * The trim is what makes this survive a moving subject: an actor walking
 * through frame produces a large error over a small fraction of the pixels, and
 * counting those would pull the match towards tracking the actor instead of the
 * background. Dropping the worst quarter costs nothing on a clean overlap and
 * rescues a dirty one.
 */
function trimmedError(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): { error: number; overlap: number } {
  const x0 = Math.max(0, -dx);
  const x1 = Math.min(width, width - dx);
  const y0 = Math.max(0, -dy);
  const y1 = Math.min(height, height - dy);
  if (x1 <= x0 || y1 <= y0) return { error: Number.POSITIVE_INFINITY, overlap: 0 };

  // Sample rather than walk every pixel; the offset is a global property.
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 4096)));
  const samples: number[] = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const av = a[y * width + x] as number;
      const bv = b[(y + dy) * width + (x + dx)] as number;
      samples.push(Math.abs(av - bv));
    }
  }
  if (samples.length === 0) return { error: Number.POSITIVE_INFINITY, overlap: 0 };

  samples.sort((p, q) => p - q);
  const keep = Math.max(1, Math.floor(samples.length * 0.75));
  let total = 0;
  for (let i = 0; i < keep; i += 1) total += samples[i] as number;
  return { error: total / keep, overlap: (x1 - x0) * (y1 - y0) };
}

/**
 * The translation between two frames.
 *
 * Searched at a reduced working size because an exhaustive search at full
 * resolution is quadratic in the shift, and a shot can travel most of a frame
 * width across its length.
 */
export function estimateTranslation(
  a: RasterImage,
  b: RasterImage,
  options: TrackOptions = {},
): FrameOffset {
  const maxShift = options.maxShift ?? 0;

  /*
   * The finest level is the picture itself.
   *
   * It used to be a 180px-tall proxy, with the winning offset multiplied back
   * up — which quantised every answer to `1/scale` pixels. On a 1080-tall plate
   * that is **six**, so a 7px pan measured as 6, a 13px pan as 12, and the
   * leftover error accumulated frame over frame into a visible staircase in the
   * mosaic. Refining all the way down to full resolution costs a few hundred
   * comparisons on a small image and removes the quantisation entirely.
   *
   * `workingHeight` still caps the finest level for a caller that wants speed
   * over precision, but it is no longer the default.
   */
  const workingHeight = options.workingHeight;
  const scale =
    workingHeight === undefined ? 1 : Math.min(1, workingHeight / a.height);
  const small = (image: RasterImage) =>
    scale === 1
      ? image
      : resize(
          image,
          Math.max(8, Math.round(image.width * scale)),
          Math.max(8, Math.round(image.height * scale)),
        );

  const sa = small(a);
  const sb = small(b);
  if (sa.width !== sb.width || sa.height !== sb.height) {
    return { x: 0, y: 0, confidence: 0 };
  }

  const limit =
    maxShift > 0
      ? Math.max(1, Math.round(maxShift * scale))
      : Math.max(4, Math.round(sa.width * 0.4));

  /*
   * Coarse to fine, because an exhaustive search is quadratic in the shift and
   * a shot can travel most of a frame width.
   *
   * The subtlety is that a coarse level *aliases*. Real footage is full of
   * repeating texture — brick, fencing, foliage, a checkerboard — and at
   * quarter size a periodic pattern matches itself at several offsets equally
   * well. Following only the coarse winner down the pyramid produces a
   * confidently wrong answer, which is the worst thing this can do. So several
   * coarse candidates are carried down and the finest level decides between
   * them, where the period is resolved.
   */
  const levels: Array<{ a: RasterImage; b: RasterImage; scale: number }> = [];
  let levelScale = 1;
  let ca = sa;
  let cb = sb;
  while (true) {
    levels.unshift({ a: ca, b: cb, scale: levelScale });
    const nextW = Math.round(ca.width / 2);
    const nextH = Math.round(ca.height / 2);
    if (nextW < 24 || nextH < 18 || levels.length >= 7) break;
    levelScale /= 2;
    ca = resize(ca, nextW, nextH);
    cb = resize(cb, nextW, nextH);
  }

  const luma = levels.map((level) => ({
    width: level.a.width,
    height: level.a.height,
    a: luminance(level.a),
    b: luminance(level.b),
  }));

  const score = (level: number, dx: number, dy: number): number => {
    const l = luma[level] as { width: number; height: number; a: Float32Array; b: Float32Array };
    const { error, overlap } = trimmedError(l.a, l.b, l.width, l.height, dx, dy);
    // An offset that barely overlaps can score well on almost nothing.
    return overlap < l.width * l.height * 0.3 ? Number.POSITIVE_INFINITY : error;
  };

  // 1. Search the coarsest level exhaustively and keep the whole field.
  const coarse = luma[0] as { width: number; height: number };
  const span = Math.max(2, Math.round(limit * (levels[0]?.scale ?? 1)));
  const field: Array<{ dx: number; dy: number; error: number }> = [];
  for (let dy = -span; dy <= span; dy += 1) {
    for (let dx = -span; dx <= span; dx += 1) {
      const error = score(0, dx, dy);
      if (Number.isFinite(error)) field.push({ dx, dy, error });
    }
  }
  if (field.length < 4) return { x: 0, y: 0, confidence: 0 };
  void coarse;

  // 2. Keep the best few *separated* minima, not the best few pixels — adjacent
  //    offsets all score alike and would crowd out the genuine rival.
  const sorted = [...field].sort((p, q) => p.error - q.error);
  const candidates: Array<{ dx: number; dy: number; error: number }> = [];
  for (const entry of sorted) {
    if (candidates.length >= 5) break;
    const crowded = candidates.some(
      (kept) => Math.abs(kept.dx - entry.dx) <= 2 && Math.abs(kept.dy - entry.dy) <= 2,
    );
    if (!crowded) candidates.push(entry);
  }

  // 3. Refine every candidate down to full resolution, then let the finest
  //    level pick the winner.
  const refined = candidates.map((candidate) => {
    let dx = candidate.dx;
    let dy = candidate.dy;
    let error = candidate.error;
    for (let level = 1; level < luma.length; level += 1) {
      dx *= 2;
      dy *= 2;
      let best = { dx, dy, error: Number.POSITIVE_INFINITY };
      for (let ny = dy - 2; ny <= dy + 2; ny += 1) {
        for (let nx = dx - 2; nx <= dx + 2; nx += 1) {
          const value = score(level, nx, ny);
          if (value < best.error) best = { dx: nx, dy: ny, error: value };
        }
      }
      dx = best.dx;
      dy = best.dy;
      error = best.error;
    }
    return { dx, dy, error };
  });

  refined.sort((p, q) => p.error - q.error);
  const winner = refined[0];
  if (!winner || !Number.isFinite(winner.error)) return { x: 0, y: 0, confidence: 0 };

  /*
   * Confidence has to answer two different doubts, so it is the lesser of two
   * measures:
   *
   * - **Is there a match at all?** A featureless frame matches about equally
   *   everywhere, so the winner sits barely below the median of the field.
   * - **Is the match unique?** Periodic texture produces several equally good
   *   offsets. A rival that scores nearly as well, far enough away to be a
   *   different answer, means the honest reply is "I cannot tell".
   *
   * The second is the one that catches a repeating pattern, and it is why this
   * reports a low number instead of a confident wrong offset.
   */
  const errors = field.map((entry) => entry.error).sort((p, q) => p - q);
  const median = errors[Math.floor(errors.length / 2)] as number;
  const coarseWinner = errors[0] as number;
  const strength =
    median <= 0 ? 0 : Math.max(0, Math.min(1, ((median - coarseWinner) / median) * 2.5));

  const rival = refined.find(
    (entry) => Math.abs(entry.dx - winner.dx) > 3 || Math.abs(entry.dy - winner.dy) > 3,
  );
  /*
   * Compared against the pair's own error scale, not the coarse field's — the
   * two live at different pyramid levels and mixing them compares nothing.
   *
   * The floor matters: vertical stripes match *exactly* at every multiple of
   * their period, so winner and rival are both zero. Dividing one by the other
   * asks 0/0 and a naive ratio answers "perfectly unique" about the most
   * ambiguous input there is.
   */
  const denominator = Math.max(rival?.error ?? 0, winner.error, 1e-6);
  const uniqueness =
    rival && Number.isFinite(rival.error)
      ? Math.max(0, Math.min(1, ((rival.error - winner.error) / denominator) * 4))
      : 1;

  const confidence = Math.min(strength, uniqueness);

  return {
    x: Math.round(winner.dx / scale),
    y: Math.round(winner.dy / scale),
    confidence: Number(confidence.toFixed(3)),
  };
}

export interface MotionTrack {
  /** Cumulative offset of each frame from the first. */
  offsets: FrameOffset[];
  /** How far the shot travelled overall, in pixels. */
  travel: { x: number; y: number };
  /** Frames whose match was too weak to use. */
  rejected: number;
}

/** Consecutive matches, accumulated into positions relative to frame zero. */
export function trackShot(
  frames: RasterImage[],
  options: TrackOptions = {},
): MotionTrack {
  const minConfidence = options.minConfidence ?? 0.15;
  const offsets: FrameOffset[] = [{ x: 0, y: 0, confidence: 1 }];
  let rejected = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 1; i < frames.length; i += 1) {
    const step = estimateTranslation(
      frames[i - 1] as RasterImage,
      frames[i] as RasterImage,
      options,
    );
    if (step.confidence < minConfidence) {
      rejected += 1;
      /*
       * Hold position rather than guess. These accumulate, so one bad step does
       * not merely lose a frame, it displaces every frame after it.
       */
      offsets.push({ x: cx, y: cy, confidence: step.confidence });
      continue;
    }
    // `step` is where the previous frame's content moved to within this one, so
    // the frame itself sits at the negative of it.
    cx -= step.x;
    cy -= step.y;
    offsets.push({ x: cx, y: cy, confidence: step.confidence });
  }

  const xs = offsets.map((o) => o.x);
  const ys = offsets.map((o) => o.y);
  return {
    offsets,
    travel: {
      x: Math.max(...xs) - Math.min(...xs),
      y: Math.max(...ys) - Math.min(...ys),
    },
    rejected,
  };
}

export interface ExpandTarget {
  /** Aspect as width/height, e.g. 16/9. */
  aspect: number;
  /** Where the source sits in the new canvas, normalised. Defaults to centred. */
  sourceRect?: { x: number; y: number; width: number; height: number };
}

export interface CoverageReport {
  canvas: { width: number; height: number };
  source: { x: number; y: number; width: number; height: number };
  /** Pixels in the canvas the source frame does not already cover. */
  newArea: number;
  /** How many of those the footage itself supplied. */
  recovered: number;
  /** recovered / newArea, 0..1. The number an artist decides on. */
  coverage: number;
  /** Per-edge breakdown, because a pan fills one side and not the other. */
  edges: { left: number; right: number; top: number; bottom: number };
  framesUsed: number;
  framesRejected: number;
  travel: { x: number; y: number };
}

/** The canvas a target aspect implies, never smaller than the source. */
export function canvasFor(
  width: number,
  height: number,
  aspect: number,
): { width: number; height: number } {
  const current = width / height;
  if (Math.abs(current - aspect) < 1e-6) return { width, height };
  return current < aspect
    ? { width: Math.round(height * aspect), height }
    : { width, height: Math.round(width / aspect) };
}

export interface MosaicResult {
  /** The expanded plate, with recovered pixels filled in. */
  mosaic: RasterImage;
  /**
   * What still has to be invented: white where nothing was ever photographed.
   *
   * This is the handover to a generator. Sending it a mostly-complete picture
   * and the hole to finish is a different and much easier request than "make
   * this wider", and it is the reason recovering first is worth the trouble.
   */
  residual: RasterImage;
  coverage: CoverageReport;
}

export interface MosaicOptions extends TrackOptions {
  /** Contributions kept per pixel before the median is taken. */
  maxSamples?: number;
  /** Pre-computed track, when the motion has already been measured. */
  track?: MotionTrack;
}

/**
 * Projects a shot into an expanded canvas and reports what was recovered.
 *
 * The per-pixel value is the **median** of every frame that saw it, not the
 * mean. A mean ghosts anything that moved through; a median outvotes it, which
 * is the whole reason this produces a clean plate rather than a smear.
 */
export function expandFromShot(
  frames: RasterImage[],
  target: ExpandTarget,
  options: MosaicOptions = {},
): MosaicResult {
  if (frames.length === 0) throw new Error("expandFromShot needs at least one frame");
  const first = frames[0] as RasterImage;
  const { width: sw, height: sh } = first;

  const canvas = canvasFor(sw, sh, target.aspect);
  const rect = target.sourceRect ?? {
    x: (canvas.width - sw) / 2 / canvas.width,
    y: (canvas.height - sh) / 2 / canvas.height,
    width: sw / canvas.width,
    height: sh / canvas.height,
  };
  const originX = Math.round(rect.x * canvas.width);
  const originY = Math.round(rect.y * canvas.height);

  const track = options.track ?? trackShot(frames, options);
  const minConfidence = options.minConfidence ?? 0.15;
  const maxSamples = Math.max(1, options.maxSamples ?? 5);

  const pixels = canvas.width * canvas.height;
  // A small reservoir of contributions per pixel, so a median can be taken.
  const samples = new Uint8Array(pixels * maxSamples * 3);
  /** How many samples are actually held, which is what the median reads. */
  const counts = new Uint8Array(pixels);
  /** How many frames saw the pixel at all — coverage, and the reservoir's n. */
  const seenCount = new Uint32Array(pixels);

  /*
   * Every frame is visited.
   *
   * An earlier version strode over the list to spread the reservoir across the
   * shot, and it made the coverage number wrong: a shot that is static apart
   * from one handheld jolt reported **0% recoverable** when 42% was, because
   * the single frame that saw the new pixels was the one stepped over. The
   * advisory number is the whole point of measuring first, so it cannot depend
   * on a sampling stride.
   *
   * Spreading is handled per pixel instead, by reservoir sampling below, which
   * gives the median a fair sample of a pixel's whole run without skipping any
   * frame's contribution to what was seen at all.
   */
  let used = 0;

  for (let f = 0; f < frames.length; f += 1) {
    const offset = track.offsets[f];
    if (!offset || offset.confidence < minConfidence) continue;
    const frame = frames[f] as RasterImage;
    if (frame.width !== sw || frame.height !== sh) continue;
    used += 1;

    const baseX = originX + offset.x;
    const baseY = originY + offset.y;
    for (let y = 0; y < sh; y += 1) {
      const cy = baseY + y;
      if (cy < 0 || cy >= canvas.height) continue;
      for (let x = 0; x < sw; x += 1) {
        const cx = baseX + x;
        if (cx < 0 || cx >= canvas.width) continue;
        const index = cy * canvas.width + cx;
        const seen = seenCount[index] as number;
        seenCount[index] = seen + 1;
        if ((counts[index] as number) < maxSamples) counts[index] = seen + 1 > maxSamples ? maxSamples : seen + 1;

        /*
         * Reservoir sampling (Algorithm R), with a hash standing in for the
         * random source so the same shot always produces the same plate.
         * Once the reservoir is full a later sighting replaces a random slot,
         * which is what spreads the median across the pixel's whole run
         * instead of freezing it on whatever passed first.
         */
        let slot = seen;
        if (seen >= maxSamples) {
          slot = mix(index, seen) % (seen + 1);
          if (slot >= maxSamples) continue;
        }
        const from = (y * sw + x) * 4;
        const to = (index * maxSamples + slot) * 3;
        samples[to] = frame.rgba[from] as number;
        samples[to + 1] = frame.rgba[from + 1] as number;
        samples[to + 2] = frame.rgba[from + 2] as number;
      }
    }
  }

  const mosaic: RasterImage = {
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8Array(pixels * 4),
  };
  const residual: RasterImage = {
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8Array(pixels * 4),
  };

  const channel: number[] = [];
  for (let index = 0; index < pixels; index += 1) {
    const n = counts[index] as number;
    const at = index * 4;
    if (n === 0) {
      // Nothing ever saw this. Transparent in the plate, white in the mask.
      residual.rgba[at] = 255;
      residual.rgba[at + 1] = 255;
      residual.rgba[at + 2] = 255;
      residual.rgba[at + 3] = 255;
      continue;
    }
    for (let c = 0; c < 3; c += 1) {
      channel.length = 0;
      for (let s = 0; s < n; s += 1) {
        channel.push(samples[(index * maxSamples + s) * 3 + c] as number);
      }
      channel.sort((p, q) => p - q);
      mosaic.rgba[at + c] = channel[Math.floor(channel.length / 2)] as number;
    }
    mosaic.rgba[at + 3] = 255;
    residual.rgba[at + 3] = 255;
  }

  /*
   * Coverage counts only the area outside the source rectangle. What is inside
   * it was never in question, and including it would inflate every number with
   * pixels the artist already had.
   */
  let newArea = 0;
  let recovered = 0;
  const edges = { left: 0, right: 0, top: 0, bottom: 0 };
  const edgeTotals = { left: 0, right: 0, top: 0, bottom: 0 };

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const inside =
        x >= originX && x < originX + sw && y >= originY && y < originY + sh;
      if (inside) continue;
      newArea += 1;
      const filled = (seenCount[y * canvas.width + x] as number) > 0;
      if (filled) recovered += 1;

      if (x < originX) {
        edgeTotals.left += 1;
        if (filled) edges.left += 1;
      } else if (x >= originX + sw) {
        edgeTotals.right += 1;
        if (filled) edges.right += 1;
      } else if (y < originY) {
        edgeTotals.top += 1;
        if (filled) edges.top += 1;
      } else {
        edgeTotals.bottom += 1;
        if (filled) edges.bottom += 1;
      }
    }
  }

  const ratio = (part: number, whole: number) =>
    whole === 0 ? 0 : Number((part / whole).toFixed(4));

  return {
    mosaic,
    residual,
    coverage: {
      canvas,
      source: { x: originX, y: originY, width: sw, height: sh },
      newArea,
      recovered,
      coverage: ratio(recovered, newArea),
      edges: {
        left: ratio(edges.left, edgeTotals.left),
        right: ratio(edges.right, edgeTotals.right),
        top: ratio(edges.top, edgeTotals.top),
        bottom: ratio(edges.bottom, edgeTotals.bottom),
      },
      framesUsed: used,
      framesRejected: track.rejected,
      travel: track.travel,
    },
  };
}

/**
 * Coverage without building the plate.
 *
 * The cheap question — "is any of this recoverable at all?" — answered before
 * paying for the expensive one. Frames are matched at a working size and only
 * the counts are kept, so this is fast enough to run the moment an artist picks
 * an aspect, and it is what decides whether the mosaic is worth running.
 */
export function measureCoverage(
  frames: RasterImage[],
  target: ExpandTarget,
  options: MosaicOptions = {},
): CoverageReport {
  const previewHeight = 240;
  const scaled = frames.map((frame) =>
    frame.height <= previewHeight ? frame : fitWithin(frame, 10_000, previewHeight),
  );
  return expandFromShot(scaled, target, { ...options, maxSamples: 1 }).coverage;
}
