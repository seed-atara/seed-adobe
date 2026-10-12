/**
 * Wind, as a warp rather than a generation.
 *
 * Bunting, papel picado, clouds, a flag, and every tree and crop in the
 * scene. Flat geometric artwork — hard-edged pennants, cream cloud bubbles
 * with an even black outline — is what a video model redraws slightly
 * differently on every frame, and across a band spanning an arcade that
 * wobble reads as the whole thing shimmering. A Wave Warp moves the artist's
 * own pixels, so the shapes cannot change because nothing is being drawn.
 *
 * There is also a hard reason. Seedance's widest aspect is 21:9 and
 * `adaptive` crops to it rather than fitting; an 8:1 bunting strand and a
 * 3.5:1 cloud bank were never generatable at their own shape at any price.
 * See `aspectFits` in `animate.ts`.
 */

/**
 * Wave Warp's `Pinning` dropdown, measured edge by edge.
 *
 * ## Why this table is measured and not read off the UI
 *
 * Two earlier guesses at it were wrong, and both times the symptom was a warp
 * that looked almost right. The guesses were not the only problem — the probe
 * was. `layerBounds` asks After Effects for `sourceRectAtTime` with extents,
 * and **that rectangle does not move when a Wave Warp is applied**: a 300px
 * amplitude on a 1316x1647 layer returns byte-identical bounds. So the numbers
 * the old table called "measured" cannot have come from anything that could
 * see the effect.
 *
 * These came from rendered pixels. The layer is soloed, captured at opposite
 * phases, and the alpha-weighted centroid of a band along each edge is
 * compared between the two: an edge that is held does not move, an edge that
 * is free does. Measured on a 478x556 tree, amplitude 12, wavelength 2200,
 * travel in pixels:
 *
 * | value | top | bottom | left | right |
 * |---|---|---|---|---|
 * | 1  | free 34 | free 9.1 | free 6.2 | free 4.1 |
 * | 2  | HELD  8 | HELD 2.2 | HELD 2.0 | HELD 1.5 |
 * | 5  | free 34 | free 9.1 | HELD 2.2 | free 4.1 |
 * | 6  | HELD  8 | free 9.1 | free 5.9 | free 3.8 |
 * | 7  | free 34 | free 9.1 | free 6.2 | HELD 1.7 |
 * | 8  | free 34 | HELD 2.2 | free 6.2 | free 4.1 |
 * | 10 | HELD  8 | HELD 2.2 | free 5.9 | free 3.8 |
 * | 11 | free 34 | free 9.1 | HELD 2.2 | HELD 1.7 |
 *
 * Which reads as a complete, ordinary dropdown — and says plainly that the
 * old entry `leftEdge: 6` was wrong. `6` holds the TOP edge. Left is `5`.
 */
export const WAVE_PINNING = {
  /** No clamping, the whole layer free to displace. */
  none: 1,
  allEdges: 2,
  leftEdge: 5,
  topEdge: 6,
  rightEdge: 7,
  /** What a plant wants: roots held, canopy free. */
  bottomEdge: 8,
  topAndBottomEdges: 10,
  leftAndRightEdges: 11,
} as const;

/**
 * `3`, `4` and `9` were indistinguishable from `none` on all four edges.
 *
 * Recorded rather than dropped, so the next person does not spend the
 * captures finding out again. They are not named, because nothing measured
 * says what they are.
 */
export const WAVE_PINNING_INERT = [3, 4, 9] as const;

/** Wave Warp's `Wave Type` dropdown. Sine is the only one that reads as wind. */
export const WAVE_TYPE_SINE = 1;

/**
 * Which way a Wave Warp pushes, and which way the wave itself runs. Measured.
 *
 * `Direction` is not simply "the way the pixels go" — it also decides the axis
 * the wave VARIES along, and the two are perpendicular. That is the fact that
 * makes a tree possible at all:
 *
 * - `90` displaces vertically, varying along x. Every pixel in a column moves
 *   together. Right for bunting, where a whole pennant should lift at once.
 * - `0` displaces horizontally, varying along y. Every pixel in a ROW moves
 *   together, and the amount changes with height. Right for anything rooted,
 *   because the base and the top can then differ.
 */
export const WAVE_DIRECTION = {
  /** Horizontal displacement, varying with height. */
  sway: 0,
  /** Vertical displacement, varying along the layer. */
  lift: 90,
} as const;

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
 * The number that separates a sway from a wobble is how much the displacement
 * VARIES across one flag width, not how far the strand travels overall.
 * Measured on Bunting05 between opposite phases:
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
 *
 * Pinning stays `none`: the strands are nailed up behind the arcade's brick
 * columns, which sit on top of them in the comp, so the ends are never
 * visible and there is nothing to pin. Pinning the top edge — `6`, now that
 * the table is right — would clamp the very string the flags hang from and
 * damp the whole strand to nearly nothing.
 */
export function buntingWeave(options: WeaveOptions = {}): Record<string, number> {
  const seconds = options.seconds ?? 30;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": options.heightPx ?? 3,
    "Wave Width": options.widthPx ?? 800,
    Direction: options.direction ?? WAVE_DIRECTION.lift,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.1, seconds),
    Pinning: WAVE_PINNING.none,
    Phase: options.phase ?? 0,
  };
}

/**
 * Wavelength for a hanging strand, from how wide it is.
 *
 * One rule rather than a number per layer, because the thing that has to stay
 * true is the ratio: many flag widths to one wave. A strand under about 900px
 * takes the measured 800; a longer one takes 1600, which is what the two
 * 2103-wide strands on the right-hand side shipped with.
 */
export function strandWavelength(strandWidthPx: number): number {
  return strandWidthPx > 900 ? 1600 : 800;
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
    Direction: options.direction ?? WAVE_DIRECTION.sway,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.0667, seconds),
    Pinning: WAVE_PINNING.none,
    Phase: options.phase ?? 0,
  };
}

/**
 * Measured conversion from `Wave Height` to how far the free top actually
 * travels, for a layer swaying about a pinned base at `SWAY_WAVELENGTHS`
 * wavelengths per layer height.
 *
 * Amplitude is not travel. On the 556px avocado tree, `Wave Height` 12 moved
 * the canopy 9.06px peak to peak and the base 2.22px — so the useful thing to
 * ask a caller for is the travel they want to SEE, and this is what turns it
 * back into a parameter.
 */
export const SWAY_TRAVEL_PER_HEIGHT = 0.755;

/**
 * Wavelengths per layer height for a rooted sway.
 *
 * Four, so the plant spans a quarter of a cycle at most. Any shorter and the
 * trunk takes an S-bend — the base going one way while the middle goes the
 * other — which reads as rubber rather than wood.
 */
export const SWAY_WAVELENGTHS = 4;

export interface SwayOptions {
  /** The layer's own height in pixels. Sets the wavelength. */
  elementHeightPx: number;
  /** How far the top should travel, peak to peak, in pixels. */
  travelPx?: number;
  speed?: number;
  seconds?: number;
  phase?: number;
}

/**
 * Wave Warp parameters for anything with roots: a tree, a shrub, a crop bed.
 *
 * Two things make this read as a plant rather than a sticker being shoved:
 *
 * 1. **`Direction` 0**, so the displacement varies with HEIGHT. At 90 every
 *    pixel in a column moves by the same amount and the whole tree shuffles
 *    sideways in one piece.
 * 2. **The bottom edge pinned.** Measured on the avocado tree at amplitude
 *    12: unpinned, the canopy travelled 9.06px and the base 9.08px — the
 *    entire tree sliding. Pinned, the canopy still travelled 9.06px and the
 *    base 2.22px. That difference is the whole effect.
 *
 * Both depend on the corrected `WAVE_PINNING` table above. With the old one
 * there was no value that held a base.
 */
export function foliageSway(options: SwayOptions): Record<string, number> {
  const seconds = options.seconds ?? 30;
  const travel = options.travelPx ?? 6;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": Math.round((travel / SWAY_TRAVEL_PER_HEIGHT) * 100) / 100,
    "Wave Width": Math.round(options.elementHeightPx * SWAY_WAVELENGTHS),
    Direction: WAVE_DIRECTION.sway,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.1, seconds),
    Pinning: WAVE_PINNING.bottomEdge,
    Phase: options.phase ?? 0,
  };
}

export interface FlagOptions {
  /** The flag's width in pixels, hoist to fly. Sets the wavelength. */
  elementWidthPx: number;
  /** Which edge the pole is on. */
  hoist?: "left" | "right";
  heightPx?: number;
  speed?: number;
  seconds?: number;
  phase?: number;
}

/**
 * Wave Warp parameters for a flag on a pole.
 *
 * The opposite of bunting in both respects, and for the same reason in each:
 * a flag is cloth held along ONE edge, so the hoist is pinned and the wave is
 * short enough that a ripple visibly travels out to the fly. One wavelength
 * across the flag — where bunting wants ten or more — because here the point
 * IS that the near end and the far end disagree.
 *
 * It also runs much faster than anything else in the scene. Cloth that size
 * ripples several times a second; a tree does not.
 */
export function flagWave(options: FlagOptions): Record<string, number> {
  const seconds = options.seconds ?? 30;
  return {
    "Wave Type": WAVE_TYPE_SINE,
    "Wave Height": options.heightPx ?? 5,
    "Wave Width": Math.round(options.elementWidthPx),
    Direction: WAVE_DIRECTION.lift,
    "Wave Speed": loopingWaveSpeed(options.speed ?? 0.5, seconds),
    Pinning: options.hoist === "right" ? WAVE_PINNING.rightEdge : WAVE_PINNING.leftEdge,
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
