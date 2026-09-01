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
 * The engine is Seedance, with the clip attached as a **reference video**. That
 * is a deliberate choice over a dedicated upscaler, and it comes with a
 * trade-off worth stating plainly rather than burying:
 *
 *   - An upscaler cannot drift, because it has no prompt to drift with. But it
 *     also cannot invent, so it can never colourise and can never paint out a
 *     scratch — and on badly degraded material it sharpens the damage along
 *     with the picture, because it does not know which is which.
 *   - Seedance can do all of it, because it recognises what it is looking at.
 *     It can also decide to improve the shot, which is the failure mode this
 *     module exists to prevent.
 *
 * Two things hold it. The prompts below, which are almost entirely
 * prohibition; and — more reliably — what the request *omits*. A reference
 * clip sent with no duration and no aspect ratio makes Ark treat the job as an
 * edit, and the output then follows the input's length and framing exactly.
 * The prompt argues; the omission binds.
 *
 * Even so: this lane can drift, and the `fidelity` line on each treatment says
 * where to look when it does. Nothing here is a guarantee, and the panel must
 * never present it as one.
 */

export const RestoreTreatmentSchema = z.enum([
  "detail",
  "clean",
  "colourise",
  "repair",
]);
export type RestoreTreatment = z.infer<typeof RestoreTreatmentSchema>;

export interface RestorePreset {
  treatment: RestoreTreatment;
  /** What it is called in the panel. */
  label: string;
  /** One line, for the artist deciding whether they want it. */
  purpose: string;
  /**
   * How far it can be trusted, and where to look when it fails.
   *
   * Separate from `purpose` because the two answer different questions: what
   * it does, and whether the result can go in a cut without a caption. An
   * editor working with archive needs the second one before they commit a
   * shot, so it is shown on screen rather than kept in a doc.
   */
  fidelity: string;
  /** The prompt, minus anything shot-specific. */
  prompt: string;
}

/**
 * The opening every restoration carries.
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

export const RESTORE_PRESETS: Record<RestoreTreatment, RestorePreset> = {
  detail: {
    treatment: "detail",
    label: "Detail",
    purpose: "Resolve the detail that is already there, at higher resolution.",
    fidelity:
      "Usually holds the shot, and resolves detail an interpolator cannot " +
      "because it recognises what it is looking at. Check faces and any text " +
      "in frame — those are where it invents when it is unsure.",
    prompt:
      `${PIN} Resolve the detail that this footage already contains, and ` +
      "nothing else. Recover fine texture the original recorded but could not " +
      "hold: fabric weave and stitching, individual hairs, skin texture and " +
      "pores, printed and painted lettering, brickwork, stonework, foliage, " +
      "the grain of timber, the texture of road surfaces. Edges become " +
      "genuinely sharp rather than haloed or outlined. Faces gain real skin " +
      "texture and stay the same faces — same features, same age, same " +
      "expression, never smoothed, never made younger or more attractive. " +
      "Preserve the original tonality exactly: if the footage is black and " +
      "white it stays black and white, with the same contrast, the same blacks " +
      "and the same highlights. Add no colour whatsoever. Keep the film's own " +
      "grain structure. Do not clean up damage, do not restyle, do not " +
      "modernise, and do not add anything that is not already implied by the " +
      "picture.",
  },
  clean: {
    treatment: "clean",
    label: "Clean up",
    purpose: "Take out the noise, video hiss and compression artefacts.",
    fidelity:
      "Strongest on heavily compressed or badly telecined footage, where the " +
      "damage is structured rather than random. Watch for it smoothing " +
      "texture it decided was noise — skin is where that shows first.",
    prompt:
      `${PIN} Remove the noise and the artefacts of the recording, and ` +
      "nothing else. Take out video hiss, chroma noise, dot crawl, " +
      "rainbowing, tape dropout, blocking, banding, mosquito noise and " +
      "compression smear. The picture underneath is left exactly as it is. " +
      "Keep every piece of genuine texture — skin pores, fabric weave, grit, " +
      "dust on surfaces, wood grain — and keep edges as sharp as they already " +
      "are. Keep the film's own grain: grain is part of the recording, not a " +
      "fault in it. Faces must not become smooth, waxy or plastic; a face with " +
      "its texture removed is a worse result than a noisy one. Do not sharpen, " +
      "do not colourise, do not repair scratches, and do not repaint any " +
      "surface.",
  },
  repair: {
    treatment: "repair",
    label: "Repair damage",
    purpose: "Scratches, dust, splices and flicker taken off the film.",
    fidelity:
      "Paints over physical damage, so what was hidden underneath is " +
      "reconstructed rather than recovered. Reliable on dust and tramlines; " +
      "check any frame where damage crossed a face.",
    prompt:
      `${PIN} Repair the physical damage to this film and nothing else. ` +
      "Remove vertical scratches and tramlines, dust, hairs, dirt, sparkle, " +
      "splice marks and frame joins, tears, mould, chemical staining and " +
      "emulsion damage. Even out frame-to-frame flicker and exposure pumping " +
      "so the brightness is steady. What lay beneath the damage is " +
      "reconstructed from the surrounding frames and the surrounding picture, " +
      "continuing what is already visible — never replaced with something new. " +
      "Keep the film's own grain, its tonality, its contrast and its colour " +
      "exactly as they are: a repaired frame still looks like film of its age, " +
      "not like video. Do not sharpen, do not denoise, do not colourise, and " +
      "do not touch any part of the frame that is undamaged.",
  },
  colourise: {
    treatment: "colourise",
    label: "Colourise",
    purpose: "Natural, period-plausible colour on black and white footage.",
    fidelity:
      "Invents colour, because nothing recorded it. The tones and the content " +
      "are held to the original, but the colours are a plausible guess and " +
      "should be described as such on screen.",
    prompt:
      `${PIN} Add natural, period-plausible colour to this monochrome ` +
      "footage. Keep every tonal relationship exactly as it is: what is bright " +
      "stays bright, what is dark stays dark, and no part of the frame changes " +
      "exposure or contrast. Only hue and saturation are added. Skin tones are " +
      "believable, varied and appropriate to the people shown. Skies, foliage, " +
      "brick, stone, timber, painted metal, paper and fabric take the colours " +
      "those materials plausibly had at the time and place of the footage. " +
      "Colour is restrained and slightly muted, the way early colour stock " +
      "records the world — not vivid, not saturated, not digitally graded, no " +
      "teal-and-orange, no stylisation. Where the correct colour of something " +
      "cannot be inferred, choose the most ordinary and unremarkable option " +
      "rather than an interesting one. Do not add detail, do not sharpen, do " +
      "not clean up damage, and do not change anything that is not colour.",
  },
};

/** Offered in this order: least invented first, most invented last. */
export const RESTORE_ORDER: RestoreTreatment[] = [
  "detail",
  "clean",
  "repair",
  "colourise",
];

/**
 * The prompt for a treatment, with the artist's note about this footage.
 *
 * The note is framed as a constraint operating *inside* the restoration rather
 * than as an instruction of its own, which is the difference between "the coat
 * is army green" narrowing the guess and "make it cinematic" turning the shot
 * into something else. A note appended bare would sit at the end of the prompt
 * as the most recent and most specific instruction — which is the position
 * that wins.
 */
export function restorePrompt(
  treatment: RestoreTreatment,
  note?: string,
): string {
  const preset = RESTORE_PRESETS[treatment];
  const wanted = (note ?? "").trim();
  if (!wanted) return preset.prompt;

  return (
    `${preset.prompt} The artist has added the following note about this ` +
    "specific footage. Treat it as additional information constraining the " +
    "restoration described above — never as permission to change the shot: " +
    wanted
  );
}
