import { z } from "zod";

/**
 * Render passes, asked of a generative model.
 *
 * The trick this rests on is not ours — it is that Seedance 2.5, given a clip
 * as a *video reference* and a prompt insisting the result match the plate
 * exactly, will produce something close to an AOV: an albedo pass, a normal
 * map, a specular pass. Not perfect, and not physically derived the way a real
 * inverse-rendering system does it (see the Beeble notes), but a start, and
 * available today without leaving the timeline.
 *
 * What SEED adds is the part that makes it usable more than once: the prompts,
 * the link back to the plate the pass came from, and somewhere for the result
 * to go afterwards. A normal map with no record of which shot it belongs to is
 * a curiosity.
 *
 * The prompts are the product here. Each one has the same three jobs:
 *
 *   1. Pin the geometry — same framing, same pose, same everything, because a
 *      pass that has drifted from its plate is worthless for compositing.
 *   2. Describe the pass in rendering terms the model has seen in its training
 *      data, not in words a compositor would use to a colleague.
 *   3. Say what must be *absent*. Most of these passes are defined by what
 *      they exclude, and a model left to guess will put the lighting back.
 */

export const PassKindSchema = z.enum([
  "albedo",
  "normal",
  "specular",
  "depth",
  "occlusion",
  "relight",
]);
export type PassKind = z.infer<typeof PassKindSchema>;

export interface PassPreset {
  kind: PassKind;
  /** What it is called in the panel. */
  label: string;
  /** One line, for the artist deciding whether they want it. */
  purpose: string;
  /** The prompt, minus anything shot-specific. */
  prompt: string;
  /**
   * Whether the pass is meaningful as an identity reference.
   *
   * Albedo is: lighting removed means a plate that teaches the model the face
   * and not the lamp. A normal map is not — it carries no colour at all.
   */
  usableAsIdentity: boolean;
}

/** The shared opening. Every pass needs the geometry pinned before anything else. */
const PIN =
  "Reproduce the reference footage exactly: identical framing, identical camera, " +
  "identical subject pose and position, identical timing, frame for frame. " +
  "Do not reinterpret, restyle, recompose or animate anything. This is a " +
  "technical render pass of the reference, not a new shot.";

export const PASS_PRESETS: Record<PassKind, PassPreset> = {
  albedo: {
    kind: "albedo",
    label: "Albedo",
    purpose: "Surface colour with the lighting removed — the best identity plate there is.",
    prompt:
      `${PIN} Output the ALBEDO pass — also called base colour or diffuse ` +
      "colour. Show only the intrinsic surface colour of every material. " +
      "Remove all lighting entirely: no highlights, no specular, no shadows, " +
      "no ambient occlusion, no cast shadows, no rim light, no colour cast " +
      "from any light source. Every surface is evenly and flatly lit as if by " +
      "perfectly uniform white illumination. Skin, fabric and metal keep their " +
      "own colour and texture detail. The result looks flat and unshaded.",
    usableAsIdentity: true,
  },
  normal: {
    kind: "normal",
    label: "Normals",
    purpose: "Surface direction as an RGB map — geometry without colour.",
    prompt:
      `${PIN} Output the NORMAL pass — a tangent-space surface normal map. ` +
      "Encode the surface direction of every pixel as colour: X in red, Y in " +
      "green, Z in blue, so flat surfaces facing the camera are the " +
      "characteristic light lavender-blue (128,128,255). Surfaces turning left " +
      "and right shift red, surfaces turning up and down shift green. Show all " +
      "fine surface relief — pores, fabric weave, hair strands, creases. No " +
      "albedo, no lighting, no shadows, no colour from the original materials.",
    usableAsIdentity: false,
  },
  specular: {
    kind: "specular",
    label: "Specular",
    purpose: "Where the surface is shiny — highlights and reflectivity only.",
    prompt:
      `${PIN} Output the SPECULAR pass — reflectivity only. Show the specular ` +
      "highlights and reflections on a black background: bright where a " +
      "surface is glossy, wet, oily or metallic, dark where it is matte. Skin " +
      "shows sheen on the forehead, nose and cheekbones; eyes and lips are " +
      "bright; cloth is mostly dark. No diffuse colour, no albedo, no ambient " +
      "light — only the reflective component.",
    usableAsIdentity: false,
  },
  depth: {
    kind: "depth",
    label: "Depth",
    purpose: "Distance from camera as greyscale — for defocus and relighting.",
    prompt:
      `${PIN} Output the DEPTH pass — a greyscale depth map. Distance from the ` +
      "camera only: what is nearest is white, what is furthest is black, with " +
      "a smooth continuous gradient between. No colour, no texture, no " +
      "lighting, no material detail. Surfaces at the same distance are the " +
      "same shade regardless of what they are made of.",
    usableAsIdentity: false,
  },
  occlusion: {
    kind: "occlusion",
    label: "Ambient occlusion",
    purpose: "Contact shadow — where surfaces crowd each other.",
    prompt:
      `${PIN} Output the AMBIENT OCCLUSION pass — a greyscale map of how ` +
      "exposed each point is to ambient light. White where a surface is open " +
      "to the sky, darkening in creases, folds, nostrils, eye sockets, under " +
      "the chin, between fingers and wherever two surfaces meet. No directional " +
      "lighting, no cast shadows from any lamp, no colour, no texture detail " +
      "beyond what the geometry itself occludes.",
    usableAsIdentity: false,
  },
  relight: {
    kind: "relight",
    label: "Relight",
    purpose: "The same shot under different light — describe the light you want.",
    prompt:
      `${PIN} Keep the subject, materials and surface detail exactly as they ` +
      "are, and change only the illumination to the following: ",
    usableAsIdentity: false,
  },
};

/** The passes offered as a set, in the order they are useful. */
export const PASS_ORDER: PassKind[] = [
  "albedo",
  "normal",
  "specular",
  "depth",
  "occlusion",
  "relight",
];

/**
 * The prompt for a pass, with the artist's own words where the pass takes them.
 *
 * Only `relight` takes a description — the rest are fully determined, and
 * letting a prompt through would invite exactly the reinterpretation the
 * opening spends three sentences forbidding.
 */
export function passPrompt(kind: PassKind, description?: string): string {
  const preset = PASS_PRESETS[kind];
  if (kind !== "relight") return preset.prompt;
  const wanted = (description ?? "").trim();
  return wanted
    ? `${preset.prompt}${wanted}`
    : `${preset.prompt}soft neutral key light from the front, gentle fill, no hard shadows.`;
}
