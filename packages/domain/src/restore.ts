import { z } from "zod";

/**
 * Restoration — an archive clip made usable, with nothing invented.
 *
 * This is the opposite of everything else SEED asks a model for. A generation
 * is wanted to be surprising; a restoration must not be. The footage is
 * evidence: a documentary cannot ship a shot where the model gave a man a
 * different coat, moved a sign, or smoothed a face into someone else. So the
 * whole design here is about *removing* the model's freedom rather than
 * steering it.
 *
 * That produces the one structural decision worth understanding. A restoration
 * runs down one of two lanes, and the two are genuinely different machines
 * rather than two settings of one:
 *
 *   **measured** — a real upscaler (Topaz). There is no prompt, so no prompt
 *     can drift. The guarantee is not that a model was asked nicely to
 *     preserve the shot; it is that the endpoint has no mechanism for changing
 *     it. Frame count, timing, framing and content are arithmetic. What it
 *     cannot do is invent: it will never colour anything, and it cannot paint
 *     out a scratch.
 *
 *   **generated** — Seedance under a locked restoration prompt, with the clip
 *     as a *reference video*. This is the lane that can invent, which is both
 *     the reason it can colourise and repair damage and the reason it can
 *     drift. It also frequently beats the upscaler on badly degraded footage,
 *     because it understands what it is looking at and an interpolator does
 *     not.
 *
 * Both lanes are offered for the treatments both can do, rather than one being
 * picked on the artist's behalf. They fail differently on different footage and
 * the only reliable way to know which won is to look at the two of them — so
 * the panel can run both at once and put the results side by side.
 *
 * Colourising is the clearest case for the split. No arithmetic recovers the
 * colour of a 1937 omnibus; something has to decide it was red. That is
 * invention, and pretending otherwise would be the dishonest part — not the
 * invention itself.
 */

export const RestoreTreatmentSchema = z.enum([
  "detail",
  "clean",
  "colourise",
  "repair",
]);
export type RestoreTreatment = z.infer<typeof RestoreTreatmentSchema>;

/** Which kind of engine runs the pass, and therefore what it can promise. */
export const RestoreLaneSchema = z.enum(["measured", "generated"]);
export type RestoreLane = z.infer<typeof RestoreLaneSchema>;

export interface RestoreLaneOffer {
  lane: RestoreLane;
  /**
   * The honest promise, shown beside the control.
   *
   * Kept per lane rather than per treatment because the same treatment makes a
   * completely different promise depending on which engine runs it: "cannot
   * change the picture" and "usually does not change the picture" are not the
   * same sentence, and an artist cutting archive needs to know which one they
   * are being given.
   */
  fidelity: string;
  /** The locked prompt. Absent on the measured lane, which has nowhere to put one. */
  prompt?: string;
}

export interface RestorePreset {
  treatment: RestoreTreatment;
  /** What it is called in the panel. */
  label: string;
  /** One line, for the artist deciding whether they want it. */
  purpose: string;
  /** Engines that can do this treatment, best-understood first. */
  lanes: RestoreLaneOffer[];
}

/**
 * The opening every generated restoration carries.
 *
 * Longer and blunter than the render-pass equivalent, and deliberately so.
 * A pass wants the model to *reinterpret* the plate into another domain; a
 * restoration wants it to change nothing but the quality of the recording.
 * Everything a generative video model does by instinct — reframing, re-timing,
 * improving a composition, making a face more attractive, tidying a background
 * — is a failure here, so each one is named. A model left to infer what
 * "restore" means will helpfully make a better shot, which is the wrong shot.
 */
const PIN =
  "This is a RESTORATION of the reference footage, not a new shot and not a " +
  "reinterpretation. Reproduce the reference exactly, frame for frame: " +
  "identical framing, identical crop, identical camera position and camera " +
  "movement, identical lens and perspective, identical timing and duration. " +
  "Every person keeps their exact identity, face, age, build, hair, clothing " +
  "and expression. Every object, vehicle, building, sign, item of text and " +
  "background element stays exactly where it is and exactly what it is. " +
  "Nothing enters the frame and nothing leaves it. Do not reframe, recrop, " +
  "zoom, stabilise, re-time, slow down, speed up, restage, recompose, " +
  "beautify, modernise, or improve the shot. Do not invent detail that the " +
  "footage does not already imply. The result must intercut with the original " +
  "as the same take. Change only the quality of the recording, as described " +
  "below.";

/** Said on every measured lane. One sentence, because it is the whole point. */
const MEASURED_FIDELITY =
  "Cannot change the picture. No prompt reaches a model, so the frames, the " +
  "timing, the framing and the content are arithmetic rather than a promise.";

export const RESTORE_PRESETS: Record<RestoreTreatment, RestorePreset> = {
  detail: {
    treatment: "detail",
    label: "Detail",
    purpose: "Resolve the detail that is already there, at higher resolution.",
    lanes: [
      {
        lane: "measured",
        fidelity: `${MEASURED_FIDELITY} Monochrome stays monochrome.`,
      },
      {
        lane: "generated",
        fidelity:
          "Usually holds the shot, and resolves detail an interpolator cannot " +
          "because it recognises what it is looking at. Check faces and any " +
          "text in frame — those are where it invents when it is unsure.",
        prompt:
          `${PIN} Resolve the detail that this footage already contains, and ` +
          "nothing else. Recover fine texture the original recorded but could " +
          "not hold: fabric weave and stitching, individual hairs, skin " +
          "texture and pores, printed and painted lettering, brickwork, " +
          "stonework, foliage, the grain of timber, the texture of road " +
          "surfaces. Edges become genuinely sharp rather than haloed or " +
          "outlined. Faces gain real skin texture and stay the same faces — " +
          "same features, same age, same expression, never smoothed, never " +
          "made younger or more attractive. Preserve the original tonality " +
          "exactly: if the footage is black and white it stays black and " +
          "white, with the same contrast, the same blacks and the same " +
          "highlights. Add no colour whatsoever. Keep the film's own grain " +
          "structure. Do not clean up damage, do not restyle, do not " +
          "modernise, and do not add anything that is not already implied by " +
          "the picture.",
      },
    ],
  },
  clean: {
    treatment: "clean",
    label: "Clean up",
    purpose: "Take out the noise, video hiss and compression artefacts.",
    lanes: [
      {
        lane: "measured",
        fidelity: `${MEASURED_FIDELITY} Leaves the grain of the film itself alone.`,
      },
      {
        lane: "generated",
        fidelity:
          "Better than the upscaler on heavily compressed or badly telecined " +
          "footage, where the damage is structured rather than random. Watch " +
          "for it smoothing texture it decided was noise.",
        prompt:
          `${PIN} Remove the noise and the artefacts of the recording, and ` +
          "nothing else. Take out video hiss, chroma noise, dot crawl, " +
          "rainbowing, tape dropout, blocking, banding, mosquito noise and " +
          "compression smear. The picture underneath is left exactly as it " +
          "is. Keep every piece of genuine texture — skin pores, fabric " +
          "weave, grit, dust on surfaces, wood grain — and keep edges as " +
          "sharp as they already are. Keep the film's own grain: grain is part " +
          "of the recording, not a fault in it. Faces must not become smooth, " +
          "waxy or plastic; a face with its texture removed is a worse result " +
          "than a noisy one. Do not sharpen, do not colourise, do not repair " +
          "scratches, and do not repaint any surface.",
      },
    ],
  },
  repair: {
    treatment: "repair",
    label: "Repair damage",
    purpose: "Scratches, dust, splices and flicker taken off the film.",
    lanes: [
      {
        lane: "generated",
        fidelity:
          "Paints over physical damage, so what was hidden underneath is " +
          "reconstructed rather than recovered. Reliable on dust and " +
          "tramlines; check any frame where damage crossed a face.",
        prompt:
          `${PIN} Repair the physical damage to this film and nothing else. ` +
          "Remove vertical scratches and tramlines, dust, hairs, dirt, " +
          "sparkle, splice marks and frame joins, tears, mould, chemical " +
          "staining and emulsion damage. Even out frame-to-frame flicker and " +
          "exposure pumping so the brightness is steady. What lay beneath the " +
          "damage is reconstructed from the surrounding frames and the " +
          "surrounding picture, continuing what is already visible — never " +
          "replaced with something new. Keep the film's own grain, its " +
          "tonality, its contrast and its colour exactly as they are: a " +
          "repaired frame still looks like film of its age, not like video. Do " +
          "not sharpen, do not denoise, do not colourise, and do not touch any " +
          "part of the frame that is undamaged.",
      },
    ],
  },
  colourise: {
    treatment: "colourise",
    label: "Colourise",
    purpose: "Natural, period-plausible colour on black and white footage.",
    lanes: [
      {
        lane: "generated",
        fidelity:
          "Invents colour, because nothing recorded it. The tones and the " +
          "content are held to the original, but the colours are a plausible " +
          "guess and should be described as such on screen.",
        prompt:
          `${PIN} Add natural, period-plausible colour to this monochrome ` +
          "footage. Keep every tonal relationship exactly as it is: what is " +
          "bright stays bright, what is dark stays dark, and no part of the " +
          "frame changes exposure or contrast. Only hue and saturation are " +
          "added. Skin tones are believable, varied and appropriate to the " +
          "people shown. Skies, foliage, brick, stone, timber, painted metal, " +
          "paper and fabric take the colours those materials plausibly had at " +
          "the time and place of the footage. Colour is restrained and " +
          "slightly muted, the way early colour stock records the world — not " +
          "vivid, not saturated, not digitally graded, no teal-and-orange, no " +
          "stylisation. Where the correct colour of something cannot be " +
          "inferred, choose the most ordinary and unremarkable option rather " +
          "than an interesting one. Do not add detail, do not sharpen, do not " +
          "clean up damage, and do not change anything that is not colour.",
      },
    ],
  },
};

/** Offered in this order: cheapest and safest first, most invented last. */
export const RESTORE_ORDER: RestoreTreatment[] = [
  "detail",
  "clean",
  "repair",
  "colourise",
];

/** The lanes a treatment can run down, in the order they are offered. */
export function lanesFor(treatment: RestoreTreatment): RestoreLane[] {
  return RESTORE_PRESETS[treatment].lanes.map((offer) => offer.lane);
}

/** What a treatment promises down one lane, or undefined if it cannot run there. */
export function laneOffer(
  treatment: RestoreTreatment,
  lane: RestoreLane,
): RestoreLaneOffer | undefined {
  return RESTORE_PRESETS[treatment].lanes.find((offer) => offer.lane === lane);
}

/**
 * The prompt for a treatment on one lane, with the artist's note.
 *
 * The note is framed as a constraint operating *inside* the restoration rather
 * than as an instruction of its own, which is the difference between "the coat
 * is army green" narrowing the guess and "make it cinematic" turning the shot
 * into something else.
 *
 * Undefined on the measured lane, and the caller must not substitute one: an
 * upscaler has nowhere to put a prompt, and a note that is silently discarded
 * is worse than no note because the artist believes it was applied.
 */
export function restorePrompt(
  treatment: RestoreTreatment,
  lane: RestoreLane,
  note?: string,
): string | undefined {
  const offer = laneOffer(treatment, lane);
  if (!offer?.prompt) return undefined;

  const wanted = (note ?? "").trim();
  if (!wanted) return offer.prompt;

  return (
    `${offer.prompt} The artist has added the following note about this ` +
    "specific footage. Treat it as additional information constraining the " +
    "restoration described above — never as permission to change the shot: " +
    wanted
  );
}
