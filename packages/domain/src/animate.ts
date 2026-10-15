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
  /*
   * Magenta is the third because green and blue both run out. The delivery
   * cyclist rides a green bike with a green backpack (47 from green) and
   * wears blue jeans (92 from blue, against a softness ceiling of 90);
   * magenta clears her by 126. Illustration reaches for magenta least, which
   * is exactly what makes it useful and also why it is third rather than
   * first — it is the one of the three a video model has seen fewest flat
   * backdrops of.
   */
  magenta: {
    opening:
      "isolated on a flat chroma-magenta background with no shadow spill",
    closing:
      "Flat chroma-magenta backdrop stays pure, even and unchanged for the whole shot",
  },
  white: {
    opening: "isolated on a plain flat white background with no shadow spill",
    closing:
      "Flat white backdrop stays pure, even and unchanged for the whole shot",
  },
  none: { opening: "", closing: "" },
} as const;

export type BackdropName = keyof typeof BACKDROPS;

/**
 * Holding the subject still, so the artist can move it.
 *
 * A separate idea from `camera locked off`, and the difference is the whole
 * point. A locked camera stops the FRAME moving; this stops the SUBJECT
 * moving within it. A walk cycle that actually walks across frame is a clip
 * you can only use once, at the speed and in the direction the model chose.
 * A walk cycle on the spot is a loop that can be laid anywhere on the
 * timeline and driven by a Position keyframe — the artist decides where it
 * goes, how fast, and whether it stops behind a column and comes back empty
 * handed.
 *
 * Stated in the opening and again at the end, for the same reason the
 * backdrop is: a single mention near the top gets outvoted by every beat
 * that implies travel.
 */
export const IN_PLACE = {
  opening: "animated as a cycle on the spot",
  closing:
    "The subject stays locked in exactly the same place in frame for the whole " +
    "shot — the motion cycles on the spot with no travel across frame, no drift " +
    "and no change of scale, like a walk cycle on a treadmill, so the clip can " +
    "be repositioned and timed by hand afterwards",
} as const;

/**
 * Keeping the subject off the edges of its own frame.
 *
 * Measured across eleven finished GYG elements: **every one of them** had
 * opaque alpha running along at least one frame edge, and five had a lot of
 * it — the car's bumpers were cut flat across 60% of the left edge and 43%
 * of the right, the cyclist lost both wheels at 21% and 24%.
 *
 * The cause is upstream of the model. A plate captured from a PSD layer is
 * that layer's exact bounding box, so the artwork is tangent to the frame
 * before anything is generated, and the clip inherits it. Standing still in
 * the plate it came from nobody notices. The moment the artist translates the
 * layer, that straight cut reads as a line across the artwork.
 *
 * No amount of post-processing fixes it: the pixels beyond the edge were
 * never drawn. The plate has to be padded with backing colour BEFORE
 * generating, and the prompt has to ask for the margin to be kept, or the
 * model composes to fill the frame again and the padding is wasted.
 *
 * Needed by anything the artist will move. Not wanted by an element whose
 * artwork is genuinely meant to run off frame — a balcony railing that
 * continues behind an arch column, a bag being handed out of shot.
 */
export const KEEP_MARGIN = {
  opening:
    "sitting well inside the frame with clear empty space on all four sides",
  closing:
    "Keep a clear empty margin of plain backdrop all the way around the subject " +
    "for the whole shot. The subject must never touch, cross or be cropped by any " +
    "edge of the frame, and must not grow to fill the frame",
} as const;

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

/**
 * The same tail, for artwork whose lamps are supposed to flicker.
 *
 * `ANIMATE_TAIL` ends "no stuttering or flickering", which earned its place
 * against frame-to-frame instability in the *render*. On a street of lanterns
 * it is also, read literally, a ban on the one thing being asked for. The
 * clause is not dropped — temporal instability is still the most common way
 * one of these clips comes back unusable — it is made to say which flicker it
 * means, and the allowance is stated positively so the model has something to
 * do rather than only something to avoid.
 *
 * ## What a global exposure pulse is, and what did NOT fix it
 *
 * Region 6 of the party-city wall is a hillside of small window lights. Asking
 * for them to "breathe at their own uneven rates" produced a **global exposure
 * pulse** instead: lit pixels swinging 14.48%, mid-tone walls swinging 15.72%,
 * correlated at **+0.96** — the whole picture dimming and brightening together,
 * which is the cheapest way for a model to make lamps change brightness. Clips
 * that read correctly correlate *negatively*, -0.79 to -0.86: lamps brightening
 * while the stone around them does not. That sign is the whole test.
 *
 * Two extra sentences were added here to forbid it — each lamp independent, and
 * the overall exposure of the shot constant — and then **measured, and removed
 * again**. They made it worse. Region 6 went from +0.96 to +0.99 and swung
 * 35.7% instead of 14.5%, and region 8, which had been a clean per-lamp -0.79,
 * came back at +0.80. Naming the failure in the prompt appears to summon it:
 * "the picture as a whole never gets brighter or darker" puts the whole picture
 * getting brighter and darker in front of the model.
 *
 * Both re-rolls also changed plate resolution at the same time, so this is not
 * a clean single-variable result — but plate resolution has a direct mechanism
 * for registration and none for brightness, and the regression is in
 * brightness. The honest state is: **this is not solved, and prohibiting it in
 * words has been tried and failed.** Likely next lever is per-lamp wording in
 * the beats, or regions with fewer lights in them.
 */
export const ANIMATE_TAIL_LIGHTS =
  "Characters stay fully inside frame at constant scale. Stable faces, clear " +
  "features, normal proportions, natural fluid motion, consistent line weight " +
  "and flat colour, and no stuttering, strobing or frame-to-frame instability " +
  "in the image itself. Flames and lamps already lit in the first frame may " +
  "vary gently in brightness, and the light they cast varies with them; the " +
  "lamps themselves do not change shape, and nothing else in the artwork " +
  "changes brightness.";

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

/**
 * Naming the parts of the artwork that must not move.
 *
 * The narrowest and most expensive lesson on this project. A market-street
 * element was asked to ripple its awning; the awning overlaps a painted sign
 * and **nothing is drawn behind it**, so the model had to invent the sign
 * every frame and the lettering degraded from a baseline of 31 to 101 over
 * six seconds. Re-rolled with the awning declared rigid, it came back flat at
 * 32.7. Declaring a thing still is what fixed it — the model honours it.
 *
 * Which gives the rule this exists to enforce:
 *
 * > An element may only be asked to move where the artwork has something
 * > drawn behind it. Everywhere else, name it here.
 *
 * It is also the only control over the parts of a region that are not the
 * subject. A region cut from a plate brings its neighbours with it — a stone
 * arch, a column, a planter wall — and those are not optional scenery the
 * model may reinterpret. They are the registration between the clip and the
 * plate it goes back into, so a column that breathes by two pixels is a seam.
 *
 * Stated twice for the reason the backdrop is: one mention near the top is
 * outvoted by every beat that follows it, and this one has to outlast them.
 */
export const RIGID = {
  opening: (what: string): string =>
    `with ${what} completely rigid and motionless`,
  closing: (what: string): string =>
    `${what} must not move, sway, bend, ripple, wobble, scale or change shape ` +
    `at all — they stay pixel-for-pixel identical to the first frame for the ` +
    `whole shot, as if photographed`,
} as const;

/** Joins names the way a sentence would, so the clause reads as English. */
export function rigidPhrase(parts: readonly string[]): string {
  const names = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/**
 * An idle, as opposed to a performance.
 *
 * Most of a projection is not doing anything. A planter of ferns, a vine on a
 * column, bunting over a street: the brief is "alive, not moving", and the
 * distance between those two is where this project keeps losing clips.
 *
 * Asked for a gust that arrives and passes, a video model writes a little
 * drama — and on anything with large distinct leaves it pays for the drama by
 * **re-drawing the plant**. Measured on the GYG proscenium: the monstera vine
 * on Region 3 grew its dark-foliage area to 106.6% of the first frame by 3.8s
 * before coming back to 100.4%, while the three fine-leaved regions beside it,
 * given the same beat sheet, held inside 2%. The big leaves were the tell —
 * a model treats a recognisable shape as content to regenerate and a texture
 * as something to displace.
 *
 * So an idle is specified by what must NOT change — the silhouette, the count,
 * the shape of each part — leaving only displacement. Stated twice, in the
 * opening and again at the end, for the reason the backdrop is.
 *
 * Narrower than `camera locked off`, which stops the frame moving, and than
 * `IN_PLACE`, which stops the subject travelling. Both of those still leave a
 * plant free to reinvent itself on the spot.
 */
/**
 * Keeping the artwork's own focus, against a model that treats blur as damage.
 *
 * Measured on the GYG party-city wall (2026-10-15): region 8 is a deliberately
 * out-of-focus corner of the painting, and the clip generated from it climbed
 * to **193%** of the plate's gradient energy by frame 151 before settling back
 * — soft, then crisp, then soft, inside one ten-second loop. Composited into a
 * window of a wall that stays soft around it, that reads as the patch snapping
 * into focus and out again.
 *
 * "Soft painterly illustration, shallow focus" in the description did not stop
 * it, and neither did "held exactly": a description says what the artwork is,
 * and the model took enhancing it as help. This is the instruction stated where
 * the strong ones live, and stated as what the blur IS — part of the artwork —
 * rather than as a request for less sharpening.
 *
 * **It does not work.** Measured on the re-roll it was written for: 193% before,
 * **204%** after, which is no effect. It is kept because the constraint is
 * correctly stated and costs nothing, and because deleting it would lose the
 * record that this was tried — but nothing should be planned on the assumption
 * that it holds. A soft plate still comes back sharpened, and the only
 * remedies known to work are not generating that region at all, or matching
 * the plate's blur back on afterwards in After Effects.
 */
export const HOLD_DETAIL = {
  opening: "keeping its own focus exactly as it is",
  closing:
    "The focus, blur, grain and level of detail in the first frame are part of " +
    "the artwork, not faults in it. Keep them exactly as they are for the whole " +
    "shot: do not sharpen, enhance, denoise, resolve or add detail to anything " +
    "that is soft or out of focus in the first frame, and do not blur anything " +
    "that is sharp in it",
} as const;

export const IDLE = {
  opening: "in a gentle idle loop, barely moving",
  closing:
    "This is an idle cycle, not a performance: the motion is small, slow, " +
    "continuous and even, with no gust, no event and no build-up. Nothing " +
    "grows, sprouts, unfurls, multiplies, appears or disappears; no part " +
    "changes its shape, size, length or outline; the silhouette and the number " +
    "of leaves, fronds and stems stay exactly as they are in the first frame. " +
    "Only the parts already in the first frame move, and only slightly",
} as const;

/**
 * A time-lapse of the light, which is the opposite brief to an idle.
 *
 * Everything else in this module animates an element that is meant to stay the
 * same while it moves. A day-to-night transition is the other job: the picture
 * is meant to *change*, completely, and the thing that must not move is the
 * geometry. So `IDLE` is not merely unnecessary here, it is wrong on three
 * clauses at once — it forbids anything appearing or disappearing, which a
 * moonrise is; it forbids anything changing shape, which clouds and a setting
 * sun do; and it asks for motion that is "small" when the brief is hours in
 * twenty seconds.
 *
 * What survives from the idle brief is the half that is still wanted: nothing
 * solid moves. That is said positively — a tripod with the shutter left
 * running — because a tripod is a thing a model has seen a great deal of, and
 * "do not move the camera" is a thing it has mostly seen violated.
 *
 * Deliberately silent about the lights coming on. Whether the lamps are lit in
 * the night plate is a fact about the artwork, so it belongs in `describe` and
 * in the beats, where it can be stated once and correctly, rather than being
 * guessed at here for every transition that will ever use this.
 */
export const TIMELAPSE = {
  opening: "as a time-lapse of the light alone",
  closing:
    "This is a time-lapse of the light: the sun, the sky, the clouds, the " +
    "colour of the light and the direction and length of the shadows move " +
    "through hours in the length of the shot, and they are the only things that " +
    "change. Every solid thing in the picture — the architecture, the ground, " +
    "the furniture, the props, the planting, the people — stays exactly where " +
    "it is, at exactly the size and in exactly the shape it is in the first " +
    "frame, as if photographed from a locked tripod with the shutter left " +
    "running. The picture is re-lit, never re-drawn and never re-composed",
} as const;

/**
 * A change carried by spreading light, between two different sets.
 *
 * The third kind of transition on this project, and the only one where the
 * artwork genuinely changes. The GYG show goes coastal night -> party-city
 * square, and those are not one set re-lit: measured on their gradient
 * profiles they match each other at 0.36, where the two ends of the
 * golden-hour-to-night shot matched at 0.59-0.79. Different architecture,
 * different materials, different palette.
 *
 * So `TIMELAPSE` must not be used here, and this exists mainly to make that
 * impossible to do by accident. Its closing clause ends "The picture is re-lit,
 * never re-drawn and never re-composed", which is the correct instruction for a
 * sunset and a flat contradiction of this brief. Reaching for the nearest
 * existing option is exactly how a prompt ends up forbidding the thing it was
 * written to ask for.
 *
 * What it does ask for is the director's own idea: the change is not a
 * dissolve, it is **led by the light**. The party set's lamps, strings of
 * bulbs, star lanterns and lit windows come on, and the new artwork arrives
 * only where their light has reached. That gives the model a mechanism rather
 * than an instruction to morph, and a mechanism is the thing these prompts have
 * consistently answered to.
 *
 * It keeps `TRANSITION_TAIL`, which happens to be exactly right: "a smooth even
 * continuous change from the first frame to the last" is the brief, and the
 * clauses it holds against stuttering, strobing and a drifting lens are all
 * still wanted. `ANIMATE_TAIL` would be wrong twice over here — it opens by
 * pinning everything inside frame at constant scale, and it ends "no stuttering
 * or flickering", which on a shot whose subject is lights kindling reads as a
 * ban on the subject.
 *
 * **Unproven.** This clause has not been measured against a finished clip. It
 * is written for a low-resolution test whose entire purpose is to find out
 * whether the model can carry a change between two unrelated sets at all; the
 * honest expectation is that it may not, and that the blend may belong in After
 * Effects as a luminance matte grown from the party plate's own lights.
 */
export const TRANSFORM = {
  opening: "changing only where the new light has reached",
  closing:
    "The change is carried by the light and happens only where the light " +
    "reaches: strings of small warm bulbs, star-shaped paper lanterns, wall " +
    "lamps and lit windows kindle one after another, and each one brightens " +
    "into its own pool of warm light. Inside those pools, and only inside them, " +
    "the artwork of the second image is what is revealed — its painted walls, " +
    "balconies, flowers, paper flags and the lit town beyond. The pools widen " +
    "and meet until they have covered the frame and the second image is the " +
    "whole picture. Outside the light that has arrived so far, the first " +
    "image's cool blue moonlight is still exactly as it was",
} as const;

/**
 * Arriving at the last frame still in motion.
 *
 * The specific failure this exists for: given a `last_frame` to hit, a model
 * will often *ease into* it, slowing the whole shot to a dead hold for the
 * final half second so that it can be sure of landing. On a transition that is
 * spliced into a plate whose own brief is "natural wave movement only", a
 * frozen tail is the one thing that cannot be used — and it is invisible on
 * every other measurement, which is why `check-daynight-transition.ts`
 * measures the last ten frames on their own.
 *
 * Stated as what the end of the shot IS, not as a ban on freezing, following
 * the one clear lesson of `ANIMATE_TAIL_LIGHTS`: a clause that names a defect
 * tends to summon it. "The shot continues past the last frame" gives the model
 * a thing to render; "do not freeze" gives it the word freeze.
 */
export const LAND_ON_LAST = {
  opening: "running at its own natural speed as it arrives",
  closing:
    "The final frame is where the shot arrives at speed: through the last two " +
    "seconds the water, the foliage and the air are all still moving at their " +
    "own ordinary speed, and the shot reaches the last frame mid-motion, as " +
    "though the camera simply carried on running past it",
} as const;

/**
 * The tail for a transition, rather than for an element on a backdrop.
 *
 * `ANIMATE_TAIL` opens "Characters stay fully inside frame at constant scale",
 * which is right for the thirty-odd cut-out elements this module was built for
 * and is a direct contradiction of this brief: the moon is asked to rise,
 * cross and **leave frame**. A contradiction in the tail is the expensive kind,
 * because the tail is global and the beats are local, and on this project the
 * global note has won every time it has been tested against a beat.
 *
 * Everything the tail is actually for is kept. "No stuttering or flickering"
 * stays and stays unqualified: unlike the lanterns of the party-city wall,
 * nothing in a sunset is supposed to flicker, so there is no conflict to
 * resolve and the clause does the job it earned.
 */
export const TRANSITION_TAIL =
  "Stable geometry, consistent line weight and flat painted colour, natural " +
  "fluid motion, a smooth even continuous change from the first frame to the " +
  "last with no stuttering, strobing, pulsing or jumping between frames, and " +
  "no change of lens, framing or scale at any point.";

export interface AnimateRequest {
  /** What the artwork is. Holds the design; does not describe the motion. */
  describe: string;
  beats: Beat[];
  /** Same still in both frame slots — Ark's `flf2v`. */
  loop?: boolean;
  backdrop?: BackdropName;
  /** Cycle on the spot rather than travelling. See `IN_PLACE`. */
  inPlace?: boolean;
  /** Hold the subject clear of every frame edge. See `KEEP_MARGIN`. */
  margin?: boolean;
  /**
   * Parts of the artwork that must not move at all. See `RIGID`.
   *
   * Named positively — "the stone arch", "the planter wall" — not as a
   * negation of the motion. The model is being told what the still parts of
   * its own first frame are, which is a different instruction from being
   * told to animate less.
   */
  rigid?: readonly string[];
  /**
   * A gentle idle rather than a performance. See `IDLE`.
   *
   * Wanted by nearly everything in a projection, and the one option that
   * stops a model re-drawing an element instead of moving it.
   */
  idle?: boolean;
  /**
   * Hold the plate's own focus and detail. See `HOLD_DETAIL`.
   *
   * Wanted by any plate cut from artwork with depth of field in it, and the
   * cheapest insurance there is: a region whose sharpness pulses does not
   * register with the static artwork around it however well it is keyed.
   */
  holdDetail?: boolean;
  /**
   * The artwork's lamps are meant to flicker. See `ANIMATE_TAIL_LIGHTS`.
   *
   * Only set this when a light source in the first frame is supposed to vary,
   * because it trades one word of the stability tail for an explicit licence
   * to change brightness, and a model given that licence on artwork with no
   * lamps in it will find something else to apply it to.
   */
  lights?: boolean;
  /**
   * A time-lapse of the light rather than an idle. See `TIMELAPSE`.
   *
   * Also swaps the stability tail for `TRANSITION_TAIL`, because the standard
   * one opens by requiring everything to stay inside frame at constant scale
   * and a transition is the one job here that asks something to leave.
   */
  timelapse?: boolean;
  /**
   * A change between two DIFFERENT sets, led by the light. See `TRANSFORM`.
   *
   * Mutually exclusive with `timelapse` in intent: that one promises the
   * picture is never re-drawn, and this one is the case where it must be. Set
   * one or the other, never both.
   */
  transform?: boolean;
  /**
   * Arrive at the last frame still moving. See `LAND_ON_LAST`.
   *
   * Only meaningful with a genuine `last_frame`, so it is worth nothing on a
   * loop — a loop's last frame is its first one and a freeze there would be
   * the point.
   */
  landOnLast?: boolean;
  /**
   * What the second image is, for a clip that runs between two frames.
   *
   * Seedance takes `first_frame` and `last_frame` as separate roles, and its
   * capabilities declare `requiresBindingText`: the prompt has to say which
   * image is which or the two stills are just two references. Setting this
   * changes the lead-in line to name both, and the description of image 2 goes
   * where the model reads it last before the beats start.
   */
  arriveAt?: string;
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
  const clauses = [description];
  const rigid = rigidPhrase(request.rigid ?? []);
  if (request.idle) clauses.push(IDLE.opening);
  if (request.timelapse) clauses.push(TIMELAPSE.opening);
  if (request.transform) clauses.push(TRANSFORM.opening);
  if (request.landOnLast) clauses.push(LAND_ON_LAST.opening);
  if (request.holdDetail) clauses.push(HOLD_DETAIL.opening);
  if (rigid) clauses.push(RIGID.opening(rigid));
  if (request.inPlace) clauses.push(IN_PLACE.opening);
  if (request.margin) clauses.push(KEEP_MARGIN.opening);
  if (backdrop.opening) clauses.push(backdrop.opening);
  const opening = `${clauses.join(", ")}.`;

  const beats = request.beats.map((beat, at) =>
    beatLine(beat, at === request.beats.length - 1, loop),
  );

  /*
   * Where the subject must stay comes before the generic stability tail: it
   * is the stronger and more specific instruction, and the last thing read
   * carries least.
   */
  const closing = [
    ...(backdrop.closing ? [backdrop.closing] : []),
    ...(rigid ? [RIGID.closing(rigid)] : []),
    // Last of the specific clauses, because it is the strongest note about
    // how much to move and the last specific thing read carries most.
    ...(request.idle ? [IDLE.closing] : []),
    ...(request.timelapse ? [TIMELAPSE.closing] : []),
    ...(request.transform ? [TRANSFORM.closing] : []),
    ...(request.holdDetail ? [HOLD_DETAIL.closing] : []),
    ...(request.inPlace ? [IN_PLACE.closing] : []),
    ...(request.margin ? [KEEP_MARGIN.closing] : []),
    /*
     * Last of the specific clauses on a transition, and deliberately after
     * TIMELAPSE: between "nothing is re-composed" and "the shot is still
     * moving when it lands" the second is the one that must win, because a
     * frozen tail is unusable and a slightly loose one is gradeable.
     */
    ...(request.landOnLast ? [LAND_ON_LAST.closing] : []),
    request.timelapse || request.transform
      ? TRANSITION_TAIL
      : request.lights
        ? ANIMATE_TAIL_LIGHTS
        : ANIMATE_TAIL,
  ].join("; ");

  /*
   * Which image is which. Seedance declares `requiresBindingText`, so a pair
   * of stills sent as `first_frame` and `last_frame` still has to be named in
   * the prompt; unnamed, the second one reads as another reference and the
   * shot wanders towards it instead of ending on it.
   */
  const arriveAt = request.arriveAt?.trim().replace(/[.]+$/, "");
  const lead = arriveAt
    ? `Image 1 as the first frame and Image 2 as the last frame, both held ` +
      `exactly. Image 1: ${opening} Image 2, which is where the shot ends: ` +
      `${arriveAt}.`
    : `Image 1 as the first frame, held exactly: ${opening}`;

  return [lead, "", beats.join("\n"), "", closing].join("\n");
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
    {
      from: third,
      to: Math.round(third * 2 * 10) / 10,
      action: `${action}, continuing`,
    },
    {
      from: Math.round(third * 2 * 10) / 10,
      to: durationSeconds,
      action: `${action}, easing`,
    },
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
 * The widest and tallest shapes Seedance will actually produce.
 *
 * 21:9 is the end of the list, and `adaptive` does not escape it — it picks
 * the nearest supported aspect and **crops to it**, which is not the same as
 * letterboxing and is far worse.
 *
 * Found by spending it. The GYG cloud bank is 2083x591, which is 3.53:1.
 * Asked for at `adaptive`, Ark returned 2206x946 — 21:9 — having zoomed into
 * the middle of the plate and discarded most of the clouds. The clip was
 * unusable and the money was gone before anything said the shape was out of
 * range.
 *
 * So this is checked before submitting, not diagnosed afterwards. An element
 * outside the range has to be split into pieces that are inside it, or
 * animated in After Effects instead — which for the long flat things that
 * trip this (a cloud strip, an 8:1 bunting run) is usually the better answer
 * anyway.
 */
/**
 * The aspects Seedance has actually been observed to return.
 *
 * **Observed on this account, not read from a contract.** Every ratio here is
 * one a finished clip came back at; the list is used to predict what
 * `adaptive` will do, never sent as a parameter unless it is also what the
 * plate measures.
 */
export const SEEDANCE_ASPECTS: Record<string, number> = {
  "21:9": 21 / 9,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "3:4": 3 / 4,
  "9:16": 9 / 16,
  "9:21": 9 / 21,
};

/**
 * What `adaptive` will actually do to a plate of this shape.
 *
 * The correction that cost $12. `aspectFits` was checking the only thing it
 * knew to check — whether a shape is inside 21:9..9:21 — and the GYG
 * proscenium background is 5750x2818, which is 2.04:1 and comfortably inside
 * it. Sent at `adaptive` it came back **3840x2160**, having snapped to 16:9
 * and centre-cropped 370px off each side. Measured, not inferred: normalised
 * correlation 0.92 against a centre 5010px crop and 0.71 against a squeeze.
 *
 * So `adaptive` does not mean "the plate's own shape". It means **the nearest
 * shape on the list, cropped to**. The note that used to be here claimed
 * otherwise on the strength of the mariachi element — 564x421, asked for at
 * 1080p, returned 1664x1248 — and read that as the element's own shape. It was
 * 4:3 exactly. The element simply happened to be within half a percent of a
 * listed ratio, so a crop of nothing looked like a fit.
 *
 * Being inside the range only means `adaptive` will not reach for a wildly
 * wrong shape. It still crops to the nearest listed one, and the fix is to pad
 * the plate out to a named ratio before sending it — which costs nothing when
 * the artwork extends past the frame, as a projection plate usually does.
 */
export function adaptiveCrop(
  width: number,
  height: number,
): {
  nearest: string;
  ratio: number;
  cropPercent: number;
  axis: "width" | "height" | "none";
} {
  const aspect = width / height;
  let nearest = "1:1";
  let ratio = 1;
  let best = Infinity;
  /*
   * Linear distance between ratios, not the ratio between them — decided by
   * the measurement, not by taste. The proscenium background is 2.0405, which
   * sits between 16:9 (1.7778) and 21:9 (2.3333). In log space 21:9 is the
   * nearer of the two; linearly 16:9 is. Ark returned 16:9, so linear is what
   * it does, and a tidier-looking metric here would mispredict the one case
   * this function exists for.
   */
  for (const [name, candidate] of Object.entries(SEEDANCE_ASPECTS)) {
    const distance = Math.abs(aspect - candidate);
    if (distance < best) {
      best = distance;
      nearest = name;
      ratio = candidate;
    }
  }

  /*
   * Cropping happens on the axis the plate has too much of. A plate wider than
   * the target loses width; a taller one loses height. Reported as a
   * percentage of that axis, because that is the number somebody has to decide
   * whether they can live with.
   */
  const keptFraction = aspect > ratio ? ratio / aspect : aspect / ratio;
  const cropPercent = Math.round((1 - keptFraction) * 1000) / 10;
  const axis =
    cropPercent < 0.05 ? "none" : aspect > ratio ? "width" : "height";
  return { nearest, ratio: Math.round(ratio * 1000) / 1000, cropPercent, axis };
}

export const WIDEST_ASPECT = 21 / 9;
export const TALLEST_ASPECT = 9 / 21;

export function aspectFits(
  width: number,
  height: number,
): {
  fits: boolean;
  aspect: number;
  nearest: string;
  why?: string;
  /** What `adaptive` would crop. Present whether or not the shape fits. */
  crop: ReturnType<typeof adaptiveCrop>;
  /**
   * Set when the shape is in range but `adaptive` would still crop it.
   *
   * A separate field from `why` so that `fits: true` can carry it: the shape
   * is generatable, and sending it unpadded would still lose pixels.
   */
  warn?: string;
} {
  const aspect = Math.round((width / height) * 1000) / 1000;
  const crop = adaptiveCrop(width, height);
  const nearest =
    aspect > WIDEST_ASPECT
      ? "21:9"
      : aspect < TALLEST_ASPECT
        ? "9:16"
        : "adaptive";
  if (aspect > WIDEST_ASPECT) {
    return {
      fits: false,
      aspect,
      nearest,
      crop,
      why:
        `${width}x${height} is ${aspect}:1, wider than the widest shape Seedance ` +
        `makes (21:9 = 2.333). \`adaptive\` will crop into the middle of the plate ` +
        `rather than fit it. Split it, or animate it in After Effects.`,
    };
  }
  if (aspect < TALLEST_ASPECT) {
    return {
      fits: false,
      aspect,
      nearest,
      crop,
      why:
        `${width}x${height} is taller than 9:21, past what Seedance makes. ` +
        `\`adaptive\` will crop it.`,
    };
  }

  /*
   * In range, and that is not the same as safe. Half a percent is the
   * rounding on a plate measured in whole pixels; past that, `adaptive` takes
   * real artwork off the edge.
   */
  if (crop.cropPercent > 0.5) {
    return {
      fits: true,
      aspect,
      nearest,
      crop,
      warn:
        `${width}x${height} is ${aspect}:1, which is in range but is not a shape ` +
        `Seedance returns. \`adaptive\` will pick ${crop.nearest} and crop ` +
        `${crop.cropPercent}% off the ${crop.axis}. Pad the plate out to ` +
        `${crop.nearest} and ask for it by name instead.`,
    };
  }
  return { fits: true, aspect, nearest, crop };
}

/**
 * Which tier to ask for, given how big the element will actually be.
 *
 * The target is **twice** the element's linear size, not merely enough to
 * cover it, and that is a measurement rather than caution. Every clip in this
 * project runs between 2.0 and 4.2 source pixels per screen pixel, they are
 * all clean, and downscaling by half is what hides the softness and the
 * frame-to-frame wobble a generated clip arrives with. A tier chosen to just
 * cover would put every artefact on screen at full size.
 *
 * Generating above what is needed costs money. Generating below it cannot be
 * recovered at any price, which is why the asymmetry is deliberate.
 *
 * ## A tier is a pixel budget, not a width — corrected 2026-10-12
 *
 * This used to compare a tier's nominal width (1280, 1920, 3840) against the
 * element's longest edge. That is only right for an element shaped 16:9, and
 * wrong by a wide margin for anything else, because `aspectRatio: "adaptive"`
 * spends the tier's pixels in the element's own shape.
 *
 * Measured, not reasoned: the mariachi element is 564x421, it was asked for
 * at 1080p, and it came back **1664x1248** — 2,076,672 pixels against 1080p's
 * 2,073,600. Not 1920 wide. The comp then reported a pixel ratio of 2.95, and
 * `sqrt(2073600 / (564 * 421))` is 2.955.
 *
 * So the whole thing collapses to one line, and the aspect cancels out
 * because the clip and the element are the same shape:
 *
 * ```
 * oversample = sqrt(tier pixels / element pixels)
 * ```
 *
 * The old rule cost real money in the only direction that matters. A 2103x262
 * bunting strand is 8:1; by nominal width it "needed" 4K, when 1080p actually
 * delivers 4080x508 and oversamples it 1.94x. That is a 4x overspend on a
 * recommendation whose entire job is to not overspend. Across the thirteen
 * elements of this side it was the difference between 9.7M tokens and 4.4M.
 */
export function tierFor(
  screenWidth: number,
  screenHeight: number,
  minOversample = 2,
): { size: string; oversample: number; covers: boolean } {
  const elementPixels = screenWidth * screenHeight;
  /* Linear oversample, so a tier must hold minOversample^2 times the area. */
  const want = elementPixels * minOversample * minOversample;

  const ladder = ["480p", "720p", "1080p", "4k"] as const;
  const ratio = (size: string): number =>
    Math.round(Math.sqrt(TIER_PIXELS[size]! / elementPixels) * 100) / 100;

  for (const size of ladder) {
    if (TIER_PIXELS[size]! >= want)
      return { size, oversample: ratio(size), covers: true };
  }

  /*
   * Bigger than 4K can oversample. Reported with the real ratio rather than
   * rounded up to a comfortable-looking number — an element this large is a
   * reason to cut it into pieces, and hiding that would be the wrong help.
   */
  const oversample = ratio("4k");
  return { size: "4k", oversample, covers: oversample >= 1 };
}
