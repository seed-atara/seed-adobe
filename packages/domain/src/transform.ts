import { z } from "zod";

/**
 * Transformation — the same plate, in a different season, hour or weather.
 *
 * This is not restoration and it fails for the opposite reason, which is why
 * it is a separate module rather than another restore preset.
 *
 * Restoration holds *everything* and improves the rendering. A transformation
 * has to change something on purpose, and the whole difficulty is that a
 * generative model given permission to change one thing will cheerfully change
 * all of them. Run through the restore path, summer-to-winter came back as a
 * different shot that happened to be wintry: the camera had moved, the
 * buildings had changed shape, the people were other people. A director
 * checking a transformed plate against the original sees that instantly, and
 * it is the difference between a usable comp and a pitch image.
 *
 * Two causes, both structural, both fixed here.
 *
 * **1. The licence was unbounded.** The only control that would make a restore
 * change anything was the freedom slider, whose top band reads "reinterpret
 * the surfaces, materials, textures and light freely ... as though the same
 * scene had been shot again". That is permission to change everything, granted
 * in order to obtain one change. So there is no freedom slider here. There is
 * a `depth` — how far into the scene the named change is allowed to reach —
 * and every band of it holds the plate.
 *
 * **2. The key frame prompt contradicted the request.** It insisted that every
 * object stays "exactly what it is" with "the direction of the light
 * unchanged", which cannot be satisfied at the same time as "make it winter".
 * A contradicted model resolves the contradiction arbitrarily, and differently
 * each run — which is precisely the inconsistency that looked like randomness.
 *
 * The shape that replaces both: name the axis, describe positively what that
 * axis does to a real place, then enumerate the invariants a supervisor
 * actually checks. `KEEP` is long and specific on purpose. It is the one place
 * in this codebase where a wall of constraint is correct, because here the
 * model has been handed a genuine licence and the constraint is what bounds
 * it — unlike restoration, where the prohibitions had nothing to bound and
 * crowded out the description of what to make.
 */

export const TransformPresetSchema = z.enum([
  "winter",
  "summer",
  "autumn",
  "spring",
  "night",
  "golden",
  "overcast",
  "rain",
  "fog",
]);
export type TransformPresetId = z.infer<typeof TransformPresetSchema>;

export interface TransformPreset {
  id: TransformPresetId;
  label: string;
  /** One line, for the artist choosing between them. */
  purpose: string;
  /**
   * The text dropped into the Change field — editable on arrival.
   *
   * Describes what the axis *does to a real place*, not what a picture of that
   * season looks like. "Snow lies on every upward-facing surface" renders
   * snow on the surfaces that are already in the plate; "a beautiful winter
   * scene" renders a different place.
   */
  change: string;
}

/**
 * The plate lock.
 *
 * First, and worded as an edit of existing footage, for the same reason
 * restoration's is: Ark classifies a request carrying a reference clip by what
 * the prompt asks for, and only an *edit* may send `duration: -1`. Rewriting
 * this into "a winter shot of ..." would turn every transformation into a
 * fresh generation of an arbitrary length, which is the failure this whole
 * module exists to prevent.
 */
const PLATE =
  "Re-render this exact footage with one deliberate change, described below. " +
  "The reference video is the plate: it supplies the camera, the framing, the " +
  "geometry of the place and the action, and all of that is to survive the " +
  "change untouched.";

/**
 * What survives, enumerated.
 *
 * Every line here is something a supervisor puts a wipe on. They are grouped
 * the way a review runs — camera, then geometry, then people, then cut —
 * because a model reading a list attends to the groups, and because a
 * reviewer's objection can be traced back to the line that failed to hold it.
 */
const KEEP =
  "Everything else is identical to the plate. The camera is in the same " +
  "place at the same height on the same lens, with the same field of view, " +
  "the same perspective and the same move; nothing is reframed, recomposed, " +
  "zoomed or stabilised. Every building, wall, road, fence, vehicle, tree " +
  "trunk and permanent object keeps its exact shape, size, position and " +
  "proportion in frame, and the horizon sits at the same height. The sun is " +
  "in the same part of the sky, so every shadow falls in the same direction " +
  "as it does in the plate. Every person is the same person — the same face, " +
  "build, hair and skin, standing where they stand, doing what they do, at " +
  "the moment they do it. Nothing enters the frame and nothing leaves it; " +
  "nothing is added, removed, tidied or improved. The cuts and the timing are " +
  "the plate's.";

/**
 * How deep the change is allowed to cut.
 *
 * This replaces restoration's freedom slider, and the difference is the point.
 * Freedom asked *how freely may this be rendered*, which is a licence over the
 * whole picture. Depth asks *how far into the scene does the season reach*,
 * which is a licence over one axis and leaves the plate lock untouched at
 * every setting.
 *
 * The bands are the three honest answers a supervisor gives when asked how
 * far to take it, in the order they escalate: on top of the world, through
 * the world, or into what the people are wearing. The last one is where
 * identity risk actually lives, which is why it is opt-in rather than the
 * default.
 */
const DEPTH: ReadonlyArray<{ upTo: number; label: string; text: string }> = [
  {
    upTo: 33,
    label: "Surface",
    text:
      "Apply the change only to the surfaces of the world as it already " +
      "stands. Every object keeps the shape and silhouette it has in the " +
      "plate — foliage stays exactly where and as dense as it is, and the " +
      "change lies on top of the scene rather than rebuilding it. The safest " +
      "setting, and the one that composites cleanly against the original.",
  },
  {
    upTo: 66,
    label: "Seasonal",
    text:
      "Let the change reach the state of living and weathering things — " +
      "foliage, ground cover, water, the colour and quality of the light and " +
      "the air — as it genuinely would in the same place at that time. " +
      "Structures, terrain, vehicles and people are untouched by it beyond " +
      "the light that falls on them and what settles on them.",
  },
  {
    upTo: 100,
    label: "Full",
    text:
      "Let the change reach everything it plausibly would, including what " +
      "the people are wearing for the conditions and what the air itself " +
      "does — visible breath, haze, precipitation in flight. Each person " +
      "remains unmistakably the same individual with the same face and the " +
      "same build; only what is appropriate to the conditions differs.",
  },
];

/** Which band a slider position falls in. */
export function depthFor(depth: number): { label: string; text: string } {
  const clamped = Math.min(Math.max(depth, 0), 100);
  const band = DEPTH.find((entry) => clamped <= entry.upTo) ?? DEPTH[DEPTH.length - 1]!;
  return { label: band.label, text: band.text };
}

/** Seasonal, which is what a director means by "make it winter". */
export const DEFAULT_DEPTH = 50;

/**
 * The closing tail.
 *
 * Restoration's tail is about stability — flicker, warping, morphing — because
 * that is what a re-render gets wrong. A transformation gets *scope* wrong, so
 * this tail closes the scope instead, and does it by naming the test the work
 * will actually be put to. "Wipe between the two" is not decoration: an A/B
 * wipe against the plate is literally how this is reviewed, and a model told
 * the test optimises for it.
 */
const TAIL =
  "The named change is the only difference between this and the plate. Wiped " +
  "against the original, every edge, every silhouette and every face must " +
  "line up. Stable geometry throughout, fluid natural motion, consistent " +
  "frame to frame, no flicker, no warping, no morphing, no drift.";

export const TRANSFORM_PRESETS: Record<TransformPresetId, TransformPreset> = {
  winter: {
    id: "winter",
    label: "Winter",
    purpose: "Deep winter — snow, bare branches, cold low light.",
    change:
      "The same place in deep winter. Fresh snow lies on every upward-facing " +
      "surface — ground, roofs, walls, branches, the tops of vehicles and " +
      "posts — thick where it settles and thin where it slides, following the " +
      "exact contours already in frame. Deciduous trees and bushes are bare, " +
      "showing dark wet branch structure where their summer foliage was; " +
      "evergreens hold their needles under snow. Grass and undergrowth are " +
      "covered or dead straw showing through. Standing water is frozen, mud " +
      "is hard and rutted. The light is low, cold and blue-grey with weak " +
      "sun, long soft shadows and a pale overcast sky. Bare, wet, cold " +
      "materials: dark damp stone and timber, frost on metal.",
  },
  summer: {
    id: "summer",
    label: "Summer",
    purpose: "High summer — full foliage, dry ground, hard warm light.",
    change:
      "The same place in high summer. Every deciduous tree and bush is in " +
      "full dense green leaf on the branches already in frame; grass is long, " +
      "green and growing, with wildflowers and weeds at verges and wall " +
      "bases. The ground is dry — dust, pale dry earth, cracked mud where " +
      "water stood. The light is high, strong and warm, with hard short " +
      "shadows, bright specular highlights on metal and glass, and a deep " +
      "blue sky with high fair-weather cloud. Warm dry materials: sun-bleached " +
      "timber, dry dusty stone, heat shimmer over open ground.",
  },
  autumn: {
    id: "autumn",
    label: "Autumn",
    purpose: "Turning leaves, wet ground, low golden light.",
    change:
      "The same place in late autumn. The deciduous foliage already in frame " +
      "has turned — russet, ochre, deep red and brown — and is thinning, with " +
      "fallen leaves drifted along walls, kerbs and the bases of trees. Grass " +
      "is long, lank and going over. The ground is wet and dark, with " +
      "standing puddles holding reflections and mud at the edges of paths. " +
      "The light is low and golden with long shadows, a soft haze in the air, " +
      "and a sky of broken grey and gold cloud.",
  },
  spring: {
    id: "spring",
    label: "Spring",
    purpose: "New growth, fresh green, bright clean light.",
    change:
      "The same place in early spring. The trees and bushes already in frame " +
      "carry new small bright-green leaves, not yet dense, so branch " +
      "structure still reads through them; blossom where the species would " +
      "carry it. Grass is short, vivid and freshly green, with early " +
      "wildflowers at the verges. The ground is damp but firm. The light is " +
      "bright, clean and neutral with crisp shadows, and the sky is a washed " +
      "blue with fast-moving white cloud.",
  },
  night: {
    id: "night",
    label: "Night",
    purpose: "The same shot after dark, lit by what is in it.",
    change:
      "The same place at night. The scene is lit only by sources that " +
      "plausibly exist in it — windows, doorways, street lamps, vehicle " +
      "lights, fire — each throwing light onto the surfaces nearest it and " +
      "falling off with distance, with everything beyond their reach in deep " +
      "blue-black shadow that still holds detail. Cool moonlight fills the " +
      "open sky and picks out upward-facing surfaces. Dark sky with stars or " +
      "cloud. Wet surfaces catch and stretch the light sources as " +
      "reflections.",
  },
  golden: {
    id: "golden",
    label: "Golden hour",
    purpose: "Low warm sun, long shadows, same sun direction.",
    change:
      "The same place at golden hour, minutes before sunset. The sun is low " +
      "and warm, coming from the same direction as in the plate but far " +
      "closer to the horizon: long raked shadows, warm orange light skimming " +
      "across upward and sun-facing surfaces, cool blue shadow on the rest. " +
      "Rim light on edges and figures facing the sun. Warm haze in the air " +
      "and a graded sky, deep above and gold near the horizon.",
  },
  overcast: {
    id: "overcast",
    label: "Overcast",
    purpose: "Flat soft grey light. Useful as a neutral base plate.",
    change:
      "The same place under heavy overcast. The light is flat, soft and " +
      "shadowless, coming evenly from a white-grey sky, with no direct sun " +
      "and no hard shadow anywhere; contrast is low, colours are muted and " +
      "slightly cool, and every surface reads clearly in even light. A solid " +
      "featureless pale grey cloud deck.",
  },
  rain: {
    id: "rain",
    label: "Rain",
    purpose: "Wet weather — soaked surfaces, spray, flat grey light.",
    change:
      "The same place in steady rain. Every surface is wet and darkened, with " +
      "sheen and reflection on roads, roofs, metal and stone; water runs at " +
      "edges and gutters and stands in puddles that reflect what is above " +
      "them. Rain falls visibly through the frame, heavier against dark " +
      "backgrounds, with spray and splash where it lands. The light is flat " +
      "and grey with no sun, and a low dark cloud deck. Soaked fabric hangs " +
      "heavy and dark.",
  },
  fog: {
    id: "fog",
    label: "Fog",
    purpose: "Atmospheric depth — near reads, far falls away.",
    change:
      "The same place in thick fog. Contrast and colour fall off steeply with " +
      "distance: the nearest objects read almost normally, the middle ground " +
      "is pale and desaturated, and anything far away dissolves into flat " +
      "grey-white. Light sources bloom into soft haloes. The air itself is " +
      "visible and slightly luminous, the ground is damp, and the sky is an " +
      "indistinct white with no horizon line.",
  },
};

/** Offered in this order. The season changes lead, because they are the ask. */
export const TRANSFORM_ORDER: TransformPresetId[] = [
  "winter",
  "summer",
  "autumn",
  "spring",
  "golden",
  "night",
  "overcast",
  "rain",
  "fog",
];

/** The change a preset starts the artist off with. */
export function presetChange(id: TransformPresetId): string {
  return TRANSFORM_PRESETS[id].change;
}

/**
 * The video prompt, in the order Seedance is documented to read.
 *
 * Plate lock, the change, how deep it cuts, what the artist knows, the
 * invariants, then the scope tail. `KEEP` sits *after* the change rather than
 * before it: BytePlus publish constraints as a closing tail, and the change
 * itself has to be the positively-described thing the model is rendering
 * towards. Putting the invariants first would rebuild the prohibition wall
 * that measured badly for restoration.
 */
export function transformPrompt(
  change: string,
  options: { depth?: number; note?: string } = {},
): string {
  const wanted = change.trim();
  const about = (options.note ?? "").trim();

  return [
    PLATE,
    wanted,
    depthFor(options.depth ?? DEFAULT_DEPTH).text,
    about
      ? "About this plate, as background for the render rather than an " +
        `instruction to change it: ${about}`
      : "",
    KEEP,
    TAIL,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The key-frame prompt for a transformation.
 *
 * Same two-step architecture as restoration — an image model renders one frame
 * properly, then the video model animates towards it — for the same measured
 * reason: a video model in edit mode cannot exceed what its source resolved.
 *
 * But the prompt cannot be restoration's. That one forbids the very thing
 * being asked for: "every object stays exactly what it is", "the direction of
 * the light are unchanged". Handed that alongside "make it winter", the model
 * has to violate something, and which thing it violates varies run to run.
 *
 * Here the licence and the lock are disjoint by construction. The change names
 * what may differ; `KEEP` names what may not; and the two lists do not
 * overlap. Light is the one that needs care and gets it explicitly: the
 * *direction* of the sun is an invariant because it is what makes shadows
 * match and a comp work, while the *quality* of the light is part of the
 * change. Restoration had no reason to separate those. This does.
 */
export function transformKeyframePrompt(
  change: string,
  options: { depth?: number; note?: string } = {},
): string {
  const wanted = change.trim();
  const about = (options.note ?? "").trim();

  return [
    "Re-photograph this exact place with one deliberate change, described " +
      "below. This is the same location, the same camera and the same moment " +
      "as the reference — not a new photograph of a similar place.",
    wanted,
    depthFor(options.depth ?? DEFAULT_DEPTH).text,
    /*
     * The framing lock, said three ways.
     *
     * Carried over from the restoration key frame, where it was added after a
     * still came back as the right scene at the wrong size — Seedream pushed
     * in hard, because an image model asked for a photograph composes a better
     * one and tighter is usually better.
     *
     * It matters more for a transformation than it did there. The still goes
     * to the video pass as a reference beside the plate; if the two disagree
     * about how much world is in frame they fight, and a transformation is
     * already asking the model to change something, so a framing disagreement
     * lands on top of a licence it can use.
     */
    "Match the reference framing exactly. Identical field of view, identical " +
      "crop, identical distance from the subject: every object occupies the " +
      "same position and the same proportion of the frame as it does in the " +
      "reference, and the edges of the picture cut through exactly the same " +
      "places. Do not zoom in, do not push in, do not crop tighter, do not " +
      "recompose, do not centre the subject, do not improve the composition. " +
      "Anything visible at the edges of the reference is still visible at the " +
      "edges here.",
    KEEP,
    about
      ? "About this plate, as background for the render rather than an " +
        `instruction to change it: ${about}`
      : "",
    "This is a real photograph of a real place: correct and specific faces " +
      "with real skin and hair, hands with the right number of fingers, " +
      "clothing and equipment physically plausible and correctly worn, and " +
      "stone, metal, timber, fabric, water and vegetation each made of the " +
      "right material.",
    /*
     * Deep focus, for the reason it was needed in restoration: "sharp prime
     * lens" reads to an image model as a flattering portrait look, and the
     * shallow depth of field that comes with it will not match a plate.
     */
    "Every part of the frame is in sharp focus, front to back — deep depth of " +
      "field, documentary photography rather than a portrait. No shallow " +
      "focus, no background blur, no bokeh, no motion blur, no vignetting.",
    "The reference frame may be soft, noisy or low-resolution. Do not " +
      "reproduce those faults — render the place it is a photograph of, at " +
      "full quality, with the change applied.",
  ]
    .filter(Boolean)
    .join(" ");
}
