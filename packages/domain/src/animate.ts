/**
 * Turning one still of artwork into a looping cel element.
 *
 * Not a general video prompt. This is the narrow, repeated job behind a
 * projection assembled from entities: a piece of flat illustration is cut
 * out, stood on a backdrop that can be keyed, animated without the camera
 * moving, and laid back into the plate it came from. Thirty-odd of those make
 * a show.
 *
 * ## Why the shape of the prompt is fixed
 *
 * The wording here is not invented. It is what is already in the generations
 * that worked on this project, read back out of the library and written up in
 * `docs/research/SEEDANCE_2_0_COST_AND_STYLE.md`. Four things recur in every
 * successful one and are absent or weak in the failures:
 *
 * 1. **The artwork described before anything moves.** The description is not
 *    there to tell the model what to draw — it already has the image. It is
 *    there to stop it redesigning, which is what it does when the prompt is
 *    only a list of actions.
 * 2. **Beats with explicit second ranges.** A paragraph of action produces a
 *    shot that spends its whole length on the first clause. Ranges spread it.
 * 3. **`camera locked off` on every beat, not once at the end.** An element
 *    that drifts cannot be comped back into a plate, and a single global note
 *    gets outvoted by three beats that each imply a move.
 * 4. **The backdrop restated at the end.** Said once at the top it survives
 *    about four seconds; the backdrop drifting mid-shot is what turns a clean
 *    key into a day of rotoscoping.
 *
 * Everything the caller writes — the description, the beats — passes through
 * untouched. What this adds is the scaffolding those four points need, in the
 * order measured to work.
 */

export interface Beat {
  /** Start of the beat, in seconds from the top of the clip. */
  from: number;
  /** End of the beat. */
  to: number;
  /** What happens. One or two clauses; the camera note is added. */
  action: string;
}

/**
 * What the element stands on.
 *
 * Green where it will be keyed, white where it is cut another way, none when
 * the element genuinely fills frame. `none` exists so that the clause can be
 * left out honestly rather than by passing an empty string that would leave a
 * dangling sentence in the prompt.
 *
 * ## Why blue is here
 *
 * Green is the default and not the universal answer, because the backdrop has
 * to be a colour the artwork does not contain. Measured on the four GYG
 * entities, as the Chebyshev distance from pure chroma green to the nearest
 * artwork pixel:
 *
 * | element | to green | to blue |
 * |---|---|---|
 * | mariachi trio | 127 | — |
 * | rooftop party crew | 70 | 100 |
 * | cafe tables | 82 | 127 |
 * | taco date | **54** | 82 |
 *
 * The taco date is the argument. Its nearest pixel to green is 54 — inside
 * the matte's default tolerance of 60 before a single frame is generated, so
 * a green backdrop would remove part of the man's shorts and call it
 * background. A Mexican street is full of green; the colour the backdrop has
 * to avoid is whatever the illustrator already used.
 *
 * Blue rather than violet or magenta, which measured marginally better on two
 * of the three: blue screen is the other industry-standard backdrop, so it is
 * as well represented in a video model's training as green and can be relied
 * on to come back FLAT. Flatness is what the matte depends on — a backdrop
 * the model renders as a lit gradient keys worse than one that is slightly
 * nearer the artwork. That tradeoff is a judgement, not a measurement, and is
 * written down here so it can be revisited if a violet test ever runs.
 */
export const BACKDROPS = {
  green: {
    opening: "isolated on a flat chroma-green background with no shadow spill",
    closing:
      "Flat chroma-green backdrop stays pure, even and unchanged for the whole shot",
  },
  blue: {
    opening: "isolated on a flat chroma-blue background with no shadow spill",
    closing:
      "Flat chroma-blue backdrop stays pure, even and unchanged for the whole shot",
  },
  white: {
    opening: "isolated on a plain flat white background with no shadow spill",
    closing: "Flat white backdrop stays pure, even and unchanged for the whole shot",
  },
  none: { opening: "", closing: "" },
} as const;

export type BackdropName = keyof typeof BACKDROPS;

/**
 * The constraint tail, verbatim from the generations that held.
 *
 * Every clause earned its place against a specific failure: scale drift,
 * faces dissolving between frames, a character wandering out of frame, line
 * weight thickening as the shot runs on. Shortening it has not been tested,
 * so it is not shortened.
 */
export const ANIMATE_TAIL =
  "Characters stay fully inside frame at constant scale. Stable faces, clear " +
  "features, normal proportions, natural fluid motion, consistent line weight " +
  "and flat colour, no stuttering or flickering.";

/** Added to every beat. See point 3 above. */
export const CAMERA_NOTE = "camera locked off, no movement";

/**
 * The closing instruction for a loop.
 *
 * Sent as part of the last beat rather than as a separate line, because a
 * global "make it loop" is a note about the clip and this has to be a note
 * about what the characters do in the final second.
 */
export const LOOP_CLOSE =
  "returning to the exact opening pose and position for a seamless loop";

function beatLine(beat: Beat, isLast: boolean, loop: boolean): string {
  const action = beat.action.trim().replace(/[.;]+$/, "");
  const close = isLast && loop ? `, ${LOOP_CLOSE}` : "";
  return `${beat.from}-${beat.to}s  ${action}${close}; ${CAMERA_NOTE}`;
}

export interface AnimateRequest {
  /** What the artwork is. Holds the design; does not describe the motion. */
  describe: string;
  beats: Beat[];
  /** Same still in both frame slots — Ark's `flf2v`. */
  loop?: boolean;
  backdrop?: BackdropName;
}

/**
 * Builds the prompt.
 *
 * Deterministic, so the same request is the same string — a generation's
 * reproducibility record is only worth keeping if the thing that produced it
 * does not drift between runs.
 */
export function animatePrompt(request: AnimateRequest): string {
  const loop = request.loop !== false;
  const backdrop = BACKDROPS[request.backdrop ?? "green"];

  const description = request.describe.trim().replace(/[.]+$/, "");
  const opening = backdrop.opening
    ? `${description}, ${backdrop.opening}.`
    : `${description}.`;

  const beats = request.beats.map((beat, at) =>
    beatLine(beat, at === request.beats.length - 1, loop),
  );

  const closing = backdrop.closing ? `${backdrop.closing}; ` : "";

  return [
    `Image 1 as the first frame, held exactly: ${opening}`,
    "",
    beats.join("\n"),
    "",
    `${closing}${ANIMATE_TAIL}`,
  ].join("\n");
}

/**
 * Beats covering a duration, when the caller has not written any.
 *
 * Three beats, because that is what every ten-second clip in this project
 * used and because two gives the model nowhere to turn around for the loop.
 * A placeholder action rather than an invented performance — a prompt that
 * describes motion nobody asked for is worse than one that asks for little.
 */
export function defaultBeats(durationSeconds: number, action: string): Beat[] {
  const third = Math.round((durationSeconds / 3) * 10) / 10;
  return [
    { from: 0, to: third, action },
    { from: third, to: Math.round(third * 2 * 10) / 10, action: `${action}, continuing` },
    { from: Math.round(third * 2 * 10) / 10, to: durationSeconds, action: `${action}, easing` },
  ];
}

/**
 * What a render will cost, in provider tokens.
 *
 * Measured across 150 completed jobs on this account: the meter is ~1017
 * pixels per token, consistent to within 0.3% across 720p, 1080p and 4K, and
 * a reference video roughly doubles it because the input is tokenized too.
 *
 * Tokens rather than money on purpose. The token count is ours and verified;
 * the rate per token is an account setting that three published sources
 * disagree about, and a confident dollar figure here would be the invented
 * part of an otherwise measured answer.
 */
export const PIXELS_PER_TOKEN = 1017;

export const TIER_PIXELS: Record<string, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
  "4k": 3840 * 2160,
};

export function estimateTokens(
  size: string,
  durationSeconds: number,
  options: { fps?: number; hasVideoReference?: boolean } = {},
): number | undefined {
  const pixels = TIER_PIXELS[size.toLowerCase()];
  if (!pixels) return undefined;
  const fps = options.fps ?? 24;
  const base = (pixels * fps * durationSeconds) / PIXELS_PER_TOKEN;
  return Math.round(base * (options.hasVideoReference ? 2 : 1));
}

/**
 * Which tier to ask for, given how big the element will actually be.
 *
 * The target is **twice** the element's longest edge, not merely enough to
 * cover it, and that is a measurement rather than caution. Every clip in this
 * project runs between 2.0 and 4.2 source pixels per screen pixel, they are
 * all clean, and downscaling by half is what hides the softness and the
 * frame-to-frame wobble a generated clip arrives with. A tier chosen to just
 * cover would put every artefact on screen at full size.
 *
 * Checked against what was actually used here: Rooftop 952px wide → 1080p,
 * Cafe01 296px → 720p, Cafe02 825px → 1080p. Three of five exactly; the
 * other two were taken a tier higher still by hand.
 *
 * Generating above what is needed costs money. Generating below it cannot be
 * recovered at any price, which is why the asymmetry is deliberate.
 */
export function tierFor(
  screenWidth: number,
  screenHeight: number,
  minOversample = 2,
): { size: string; oversample: number; covers: boolean } {
  const need = Math.max(screenWidth, screenHeight) * minOversample;
  const tiers: Array<[string, number]> = [
    ["720p", 1280],
    ["1080p", 1920],
    ["4k", 3840],
  ];
  const longest = Math.max(screenWidth, screenHeight);
  for (const [size, width] of tiers) {
    if (width >= need) {
      return { size, oversample: Math.round((width / longest) * 100) / 100, covers: true };
    }
  }
  /*
   * Bigger than 4K can oversample. Reported with the real ratio rather than
   * rounded up to a comfortable-looking number — an element this large is a
   * reason to cut it into pieces, and hiding that would be the wrong help.
   */
  const oversample = Math.round((3840 / longest) * 100) / 100;
  return { size: "4k", oversample, covers: oversample >= 1 };
}
