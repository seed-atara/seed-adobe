/**
 * Bunting and clouds in the wind, as a warp rather than a generation.
 *
 * Flat geometric artwork — hard-edged pennants, cream cloud bubbles with an
 * even black outline — is what a video model redraws slightly differently on
 * every frame, and across a six-strand band spanning an arcade that wobble
 * reads as the whole thing shimmering. A Wave Warp moves the artist's own
 * pixels, so the flags cannot change shape because nothing is being drawn.
 *
 * There is also a hard reason. Seedance's widest aspect is 21:9 and
 * `adaptive` crops to it rather than fitting; an 8:1 bunting strand and a
 * 3.5:1 cloud bank were never generatable at their own shape at any price.
 * See `aspectFits` in `animate.ts`.
 */

/**
 * Wave Warp's `Pinning` dropdown.
 *
 * **Only the entries below were measured.** The first guess at this table was
 * wrong twice, and both times the symptom was a warp that looked almost
 * right: `6` was taken for "Left and Right Edges" and is actually the left
 * edge alone — the giveaway was the measured travel, 0px at the left end of
 * the strand and 3px at the right. `9` was then taken for the pair and damps
 * the whole layer instead, including the top edge the bunting hangs from, so
 * the flags barely move at all.
 *
 * Rather than guess the rest of the list, this build uses `none`. The strands
 * are nailed up behind the arcade's brick columns, which sit on top of them
 * in the comp, so the ends are never visible and there is nothing to pin.
 */
export const WAVE_PINNING = {
  /** Measured: no clamping, the whole layer free to displace. */
  none: 1,
  /** Measured: the LEFT edge only, despite what the number looks like. */
  leftEdge: 6,
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
 */
export function loopingWaveSpeed(wanted: number, seconds: number): number {
  const cycles = Math.max(1, Math.round(wanted * seconds));
  /*
   * Six places, not four. `cycles / seconds` is often a repeating decimal —
   * one cycle over thirty seconds is 0.0333... — and rounding it short leaves
   * the wave a fraction of a cycle from home at the cut. At six places the
   * worst case is half a thousandth of a cycle over the whole clip, which is
   * under a fifth of a degree of phase.
   */
  return Math.round((cycles / seconds) * 1e6) / 1e6;
}

export interface WeaveOptions {
  /** How far the cloth lifts, in pixels. */
  heightPx?: number;
  /** Length of one wave along the strand, in pixels. See the note below. */
  widthPx?: number;
  /** Roughly how many wave cycles a second. Snapped so the loop closes. */
  speed?: number;
  /** Seconds the clip must loop over. */
  seconds?: number;
  /** Degrees. 90 displaces vertically, 0 horizontally — both measured. */
  direction?: number;
  /** Shifts one strand against its neighbours so the band is not in unison. */
  phase?: number;
}

/**
 * Wave Warp parameters for one bunting strand.
 *
 * ## Why the wavelength matters more than the amplitude
 *
 * The first attempt used After Effects' own defaults — 10px at a wavelength
 * of 40 — and Johannes called it "massive and unrealistic". The amplitude was
 * not the problem. A 40px wavelength across a 644px strand is sixteen waves,
 * so each 60px pennant sat on a different part of the curve and sheared
 * against its neighbour: the flags wobbled like jelly instead of the string
 * swaying.
 *
 * The number that separates a sway from a wobble is how much the
 * displacement VARIES across one flag width, not how far the strand travels
 * overall. Measured on Bunting05 between opposite phases:
 *
 * | settings | travel | variation across one flag |
 * |---|---|---|
 * | height 8, width 400 | 5px | ~4px — still wobbling |
 * | height 5, width 800 | 6px | 2px — strand lifts as one |
 * | height 3, width 800 | 4px | 2px — what shipped |
 *
 * So the wavelength wants to be many times a flag, and the amplitude can then
 * be whatever reads as subtle. On a projection this size, 4px of travel is
 * about a centimetre on the wall.
 */
export function buntingWeave(options: WeaveOptions = {}): Record<string, number> {
  const seconds = options.seconds ?? 30;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": options.heightPx ?? 3,
    "Wave Width": options.widthPx ?? 800,
    Direction: options.direction ?? 90,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.1, seconds),
    Pinning: WAVE_PINNING.none,
    Phase: options.phase ?? 0,
  };
}

/**
 * Wave Warp parameters for a bank of clouds.
 *
 * Horizontal rather than vertical, because clouds drift. And a wavelength
 * deliberately LONGER than the layer — 4000 across a 2083-wide bank — so the
 * whole field slides together instead of one half going left while the other
 * goes right, which is the differential squash that reads as the picture
 * breathing rather than the sky moving.
 */
export function cloudDrift(options: WeaveOptions = {}): Record<string, number> {
  const seconds = options.seconds ?? 30;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": options.heightPx ?? 3,
    "Wave Width": options.widthPx ?? 4000,
    Direction: options.direction ?? 0,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.0667, seconds),
    Pinning: WAVE_PINNING.none,
    Phase: options.phase ?? 0,
  };
}

/**
 * Phases for a band of strands, so they weave together but never in step.
 *
 * A staging choice rather than a measurement, and it lives here because the
 * whole point of a "logical group" is that its members share a wind and
 * differ only in where they are in it.
 */
export function bandPhases(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round((360 / count) * i));
  return out;
}
