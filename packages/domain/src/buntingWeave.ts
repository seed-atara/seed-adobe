/**
 * Bunting in the wind, as a warp rather than a generation.
 *
 * A string of pennants is flat geometric artwork — hard-edged triangles with
 * an even black outline. That is precisely what a video model redraws
 * slightly differently on every frame, and on a six-strand run across an
 * arcade the wobble reads as the whole band shimmering. A Wave Warp moves the
 * artist's own pixels: the flags cannot change shape, because nothing is
 * being drawn.
 *
 * It is also free, and it loops exactly, which a generated clip only
 * approximates.
 */

/** Wave Warp's `Pinning` dropdown, in After Effects' own order. */
export const WAVE_PINNING = {
  none: 1,
  allEdges: 2,
  centerOfEdges: 3,
  leftAndRight: 6,
  topAndBottom: 7,
} as const;

/** Wave Warp's `Wave Type` dropdown. Sine is the only one that reads as wind. */
export const WAVE_TYPE_SINE = 1;

/**
 * A wave speed that returns to its starting phase after exactly `seconds`.
 *
 * This is the number that decides whether the loop closes. Wave Warp's phase
 * advances continuously at `Wave Speed` cycles per second and keeps going
 * past the end of the comp; it does not know the clip repeats. Any speed
 * whose product with the duration is a whole number of cycles lands back
 * where it started, and every other speed leaves a jump at the loop point
 * that no amount of easing hides.
 *
 * So the caller asks for roughly the speed it wants and gets the nearest one
 * that is honest about looping.
 */
export function loopingWaveSpeed(wanted: number, seconds: number): number {
  const cycles = Math.max(1, Math.round(wanted * seconds));
  /*
   * Six places, not four. `cycles / seconds` is often a repeating decimal —
   * one cycle over thirty seconds is 0.0333... — and rounding it short leaves
   * the wave a fraction of a cycle from home at the cut. At six places the
   * worst case is half a thousandth of a cycle over the whole clip, which is
   * under a fifth of a degree of phase: below what the pixel grid can show,
   * where four places was approaching what it could.
   */
  return Math.round((cycles / seconds) * 1e6) / 1e6;
}

export interface WeaveOptions {
  /** How far the cloth lifts, in pixels. Small: this is a breeze, not a gale. */
  heightPx?: number;
  /** Length of one wave along the string, in pixels. */
  widthPx?: number;
  /** Roughly how many wave cycles a second. Snapped to loop. */
  speed?: number;
  /** Seconds the clip must loop over. */
  seconds?: number;
  /** Degrees. 90 makes the wave travel along a horizontal string. */
  direction?: number;
  /** Shifts one strand against its neighbours so the band is not in unison. */
  phase?: number;
}

/**
 * Wave Warp parameters for one bunting strand, by display name.
 *
 * Pinned left and right because a bunting string is tied at both ends: without
 * it the whole strand slides sideways and detaches from the brickwork it is
 * nailed to.
 */
export function buntingWeave(options: WeaveOptions = {}): Record<string, number> {
  const seconds = options.seconds ?? 30;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": options.heightPx ?? 6,
    "Wave Width": options.widthPx ?? 260,
    Direction: options.direction ?? 90,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.4, seconds),
    Pinning: WAVE_PINNING.leftAndRight,
    Phase: options.phase ?? 0,
    Antialiasing: 3,
  };
}

/**
 * Phases for a band of strands, so they weave together but never in step.
 *
 * Measured nowhere — this is a staging choice, and it is here rather than in
 * a caller because the whole point of a "logical group" is that its members
 * share a wind and differ only in where they are in it. Spread across the
 * full cycle rather than clustered, and never two the same.
 */
export function bandPhases(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round((360 / count) * i));
  return out;
}
