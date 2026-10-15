/**
 * Easing a timelapse in and out without moving either of its end frames.
 *
 * A day-to-night transition generated as a single clip arrives at a constant
 * rate: the sun sets at the same speed in the first second as in the tenth.
 * What reads correctly is the opposite — a second or two of real time at each
 * end, the hours racing through the middle, and the two ends being where the
 * shot joins the static artwork on either side of it.
 *
 * That is a time remap, and a time remap is exact, free and adjustable after
 * the fact, so it does not belong in the prompt. Asking a model for a speed
 * ramp spends money on something arithmetic does better: `setTimeRemap` takes
 * `[compSeconds, sourceSeconds]` pairs and interpolates linearly between them,
 * so a dense enough sampling of any curve IS that curve.
 *
 * ## The constraint that drives the shape
 *
 * The clip's first frame is the golden-hour set and its last frame is the night
 * set, and both of those have to land on the frame the artwork either side of
 * the transition is holding. So:
 *
 *     source(0) = 0        and        source(T) = T
 *
 * are not preferences, they are the whole reason the clip is usable. Every
 * curve here satisfies them by construction rather than by rounding, which is
 * why the speed in the middle is *derived* rather than chosen: slowing the ends
 * down means the middle has to run faster than real time to still consume the
 * whole source in the same wall-clock, and the amount is not a matter of taste.
 *
 *     speed(t) = endSpeed + (peak - endSpeed) * ramp(t)
 *
 * with `ramp` a smoothstep up over the first `rampSeconds`, a flat 1 through
 * the middle, and a smoothstep down over the last `rampSeconds`. A smoothstep
 * integrates to exactly half its interval, so the area under `ramp` is
 * `T - rampSeconds`, and requiring the total to be `T` gives
 *
 *     peak = (T - endSpeed * rampSeconds) / (T - rampSeconds)
 *
 * For a 20s clip ramping over 1.5s at a fifth of speed that is 1.065 — the
 * middle only has to run 6.5% fast to pay for ends that run at 20%, because
 * the ends are short. The ratio the eye reads is 5.3:1 between the slowest and
 * the fastest part of the shot, which is a ramp anyone would call a ramp.
 *
 * Smoothstep rather than a linear ramp because the join at `rampSeconds` is
 * where a ramp gets noticed: linear speed has a corner there, a visible change
 * in the rate of change. Smoothstep's derivative is zero at both of its own
 * ends, so the acceleration starts and finishes gently.
 */

/** A `[compSeconds, sourceSeconds]` pair, ready for the host's `setTimeRemap`. */
export type RemapKey = readonly [number, number];

export interface SpeedRampRequest {
  /**
   * The clip's length, which is also the comp time it occupies.
   *
   * This function only ramps a clip into its own duration — 1:1 overall. A
   * remap that also retimed the whole clip would be a second, independent
   * decision, and conflating the two is how a ramp silently changes which
   * frame lands on the last frame.
   */
  durationSeconds: number;
  /** How long the shot takes to get up to speed, and to come back down. */
  rampSeconds?: number;
  /**
   * Speed at the very first and very last frame, as a fraction of real time.
   *
   * A fifth by default. Not zero: a remap that reaches zero speed holds a
   * single frame, and a held frame at the end of a shot whose brief is
   * "natural wave movement only" is the one thing it must not do.
   */
  endSpeed?: number;
  /** Keys emitted across each ramp. The middle needs none; it is linear. */
  samplesPerRamp?: number;
}

/** Smoothstep. Zero slope at both ends, which is the point of using it. */
function smoothstep(u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  return x * x * (3 - 2 * x);
}

/**
 * The peak speed that makes the clip consume exactly its own length.
 *
 * Exported because it is the number worth printing before spending anything:
 * it says how hard the middle has to run, and an `endSpeed` low enough to push
 * it past about 2x will look like a different shot in the middle rather than
 * the same shot ramped.
 */
export function peakSpeed(
  durationSeconds: number,
  rampSeconds: number,
  endSpeed: number,
): number {
  return (durationSeconds - endSpeed * rampSeconds) / (durationSeconds - rampSeconds);
}

/**
 * Source time at comp time `t`, analytically.
 *
 * Analytic rather than a numeric integral so that `source(T) === T` is true by
 * algebra instead of true to within the step size. The endpoint is the
 * requirement, so it is the thing that must not carry error.
 */
export function sourceAt(t: number, request: SpeedRampRequest): number {
  const T = request.durationSeconds;
  const R = Math.min(request.rampSeconds ?? 1.5, T / 2);
  const vmin = request.endSpeed ?? 0.2;
  if (R <= 0) return t;
  const vmax = peakSpeed(T, R, vmin);

  /** Integral of the ramped segment from its own start, length `R`. */
  const rampArea = (w: number): number =>
    vmin * w * R + (vmax - vmin) * R * (w ** 3 - w ** 4 / 2);

  if (t <= 0) return 0;
  if (t >= T) return T;
  if (t < R) return rampArea(t / R);
  if (t <= T - R) return rampArea(1) + vmax * (t - R);
  // Mirrored, so the tail is the head backwards and the endpoint stays exact.
  return T - rampArea((T - t) / R);
}

/**
 * The keys to hand `setTimeRemap`.
 *
 * Dense across the two ramps, because linear interpolation between keys is all
 * After Effects will do and a curve sampled coarsely is a staircase of speeds.
 * Exactly two keys spanning the middle, because the middle genuinely is linear
 * and extra keys there would be noise in a property an artist has to read.
 */
export function speedRampKeys(request: SpeedRampRequest): RemapKey[] {
  const T = request.durationSeconds;
  const R = Math.min(request.rampSeconds ?? 1.5, T / 2);
  const n = Math.max(2, request.samplesPerRamp ?? 16);
  if (!(T > 0)) throw new Error("a speed ramp needs a positive duration");

  const times: number[] = [];
  for (let i = 0; i <= n; i++) times.push((R * i) / n);
  if (R < T - R) times.push(T - R);
  for (let i = 1; i <= n; i++) times.push(T - R + (R * i) / n);

  const round = (x: number): number => Math.round(x * 1000) / 1000;
  const keys: RemapKey[] = [];
  for (const t of times) {
    const at = round(t);
    // A duplicate time would overwrite the key before it; T/2 ramps collide.
    if (keys.length && keys[keys.length - 1]![0] === at) continue;
    keys.push([at, round(sourceAt(t, request))]);
  }
  return keys;
}

/**
 * How the ramp reads, for printing before it is applied.
 *
 * `slowestRatio` is the one to look at: it is what the eye actually registers
 * as a ramp, and it is not `endSpeed` because the middle moved too.
 */
export function describeRamp(request: SpeedRampRequest): {
  peak: number;
  endSpeed: number;
  rampSeconds: number;
  slowestRatio: number;
} {
  const T = request.durationSeconds;
  const R = Math.min(request.rampSeconds ?? 1.5, T / 2);
  const vmin = request.endSpeed ?? 0.2;
  const peak = R > 0 ? peakSpeed(T, R, vmin) : 1;
  return {
    peak: Math.round(peak * 1000) / 1000,
    endSpeed: vmin,
    rampSeconds: R,
    slowestRatio: Math.round((peak / vmin) * 100) / 100,
  };
}
