import { z } from "zod";

/**
 * Restoration — crappy footage re-rendered at the quality it should have had.
 *
 * This started as a prohibition engine: a long paragraph forbidding every way a
 * video model helpfully ruins archive, and nothing else. It did not work, and
 * BytePlus's own prompt guidance says why (see docs/research/PROMPT_CRAFT.md):
 *
 *   - **Seedance reads a prompt as a spatial layer and a temporal one.** The
 *     old prompt was pure prohibition, so the temporal layer had nothing to
 *     follow — and a model with nothing to follow invents motion. Measured on
 *     a real airfield clip: the detail was better in places and the *animation
 *     was wrong*, which is exactly the shape of that failure.
 *   - **A model given only prohibitions has no positive objective.**
 *     "Reproduce exactly, change nothing, do not improve" is close to a null
 *     instruction, and we spent the entire prompt suppressing the machinery
 *     that produces quality in the first place.
 *   - **Constraints are published as a short closing tail**, not an opening
 *     wall. We had the shape inverted.
 *
 * So the prompt now leads with what to *make*. The artist describes the look
 * they want — the stock, the optics, the grain, the palette — the reference
 * clip supplies framing, camera and action, and a single closing line holds
 * the shot to it. The old wall of "do not" is gone.
 *
 * One deliberate carry-over. Ark classifies a request carrying a reference
 * video by what the prompt asks for, and only an *edit* is allowed
 * `duration: -1`, which is what keeps the result attached to the source clip
 * rather than becoming a new shot of an arbitrary length. `ANCHOR` below is
 * what holds that classification, so it stays first and stays worded as an
 * edit of existing footage. Rewriting it into "a beautiful shot of ..." would
 * quietly turn every restoration into a fresh generation.
 */

/** A starting point for the look, not a hidden prompt. The artist edits it. */
export const RestorePresetSchema = z.enum([
  "detail",
  "sharp",
  "colourise",
  "monochrome",
  "clean",
]);
export type RestorePresetId = z.infer<typeof RestorePresetSchema>;

export interface RestorePreset {
  id: RestorePresetId;
  label: string;
  /** One line, for the artist choosing between them. */
  purpose: string;
  /**
   * The text dropped into the Look field.
   *
   * Editable on arrival, which is the point: these are openings, not presets
   * in the sense of settings. The artist knows what the footage is and we do
   * not, and their vocabulary is load-bearing per CLAUDE.md.
   */
  look: string;
}

/**
 * What always holds, at every setting of the slider.
 *
 * Two jobs, and both are load-bearing. It keeps Ark's task classification on
 * "edit" so `duration: -1` stays legal — which is the only thing tying the
 * result to the source clip rather than letting it become a new shot of an
 * arbitrary length — and it pins the staging, which is what makes a result
 * recognisably the same footage however freely it is rendered.
 *
 * Deliberately *not* a list of everything a model might do wrong. That list
 * was the original design and it crowded out the description of what to make.
 */
const HOLD =
  "Re-render this exact footage. The reference video is the shot: keep its " +
  "framing, its camera position and movement, its lens and perspective, its " +
  "cuts, its timing, and the position and staging of every person, aircraft, " +
  "vehicle and object in it.";

/**
 * How far the render may depart from the source — the slider.
 *
 * **There is no API parameter for this.** Ark documents `first_frame`,
 * `last_frame`, `reference_image`, `reference_video` and `reference_audio`,
 * and nothing that weights how strongly a reference is followed. Checked
 * against BytePlus's own docs and against our probe notes on 2026-09-01. So
 * this is prompt strength and only prompt strength, and the panel says so:
 * calling it "reference weight" would imply a knob that does not exist.
 *
 * Three bands rather than a continuous blend, because a prompt is text and
 * there is nothing to interpolate. The numbers exist so the control can be a
 * slider — which is the right shape for the artist, since the thing being
 * chosen genuinely is a single axis from faithful to free.
 *
 * The top of the range stops short of "a new shot". Framing and timing stay
 * held at every setting: a version that let those go would be an ordinary
 * generation with a clip attached, which is what the Generate tab already is.
 */
const LATITUDE: ReadonlyArray<{ upTo: number; label: string; text: string }> = [
  {
    upTo: 33,
    label: "Faithful",
    text:
      "Reproduce every surface, material, marking, garment and face exactly " +
      "as it appears in the reference. This is the same picture, only " +
      "properly resolved — nothing is reinterpreted, only rendered better.",
  },
  {
    upTo: 66,
    label: "Balanced",
    text:
      "Keep every subject, material and marking recognisably itself, and " +
      "render it with the detail and clarity the original could not hold. " +
      "Where the footage is too degraded to read, resolve it the way the " +
      "scene plainly implies rather than inventing something new.",
  },
  {
    upTo: 100,
    label: "Free",
    text:
      "Treat the reference as the staging, the camera and the action. " +
      "Reinterpret the surfaces, materials, textures and light freely to " +
      "achieve the look described, as though the same scene had been shot " +
      "again on far better equipment. Subjects stay who and what they are.",
  },
];

/** Which band a slider position falls in. */
export function latitudeFor(freedom: number): { label: string; text: string } {
  const clamped = Math.min(Math.max(freedom, 0), 100);
  const band = LATITUDE.find((entry) => clamped <= entry.upTo) ?? LATITUDE[LATITUDE.length - 1]!;
  return { label: band.label, text: band.text };
}

/**
 * The published closing constraint line.
 *
 * BytePlus document this as an always-append tail, and it is the one place
 * prohibitions belong. Short, and about *stability* rather than content —
 * which is what a re-render actually gets wrong.
 */
const TAIL =
  "Stable faces and stable geometry throughout, fluid natural motion, " +
  "consistent detail frame to frame, no flicker, no warping, no morphing, " +
  "no invented objects or people.";

export const RESTORE_PRESETS: Record<RestorePresetId, RestorePreset> = {
  detail: {
    id: "detail",
    label: "Maximum detail",
    purpose: "Everything the footage should have resolved, and did not.",
    look:
      "Photographed on fine-grained 35mm colour negative with a sharp prime " +
      "lens, scanned at high resolution. Enormous amounts of genuine surface " +
      "detail: individual blades of grass, rivets and panel lines on metal, " +
      "weave and stitching in fabric, individual hairs, real skin texture and " +
      "pores, legible painted lettering and insignia, foliage resolved leaf by " +
      "leaf. Crisp, well-focused edges with no haloing. Rich natural " +
      "contrast, deep blacks, clean highlights, believable period colour.",
  },
  /*
   * The one preset that does not ask for film.
   *
   * Every other opening here describes a stock — 35mm, Kodachrome, natural
   * grain — because restoring archive usually means wanting it to still look
   * like archive. That is the wrong instruction when what is wanted is a
   * clean, modern, fully resolved picture: asking for grain is asking for
   * exactly the texture that measured as fake detail, and asking for period
   * stock is asking for softness.
   *
   * Pair it with the slider toward Free. Held faithful, the model can only
   * re-render what the source already resolved; the detail has to be invented,
   * and inventing is what the upper bands permit.
   */
  sharp: {
    id: "sharp",
    label: "Sharp digital re-render",
    purpose: "Modern camera quality rather than restored film. The most detail available.",
    look:
      "Shot on a modern digital cinema camera with a sharp prime lens: clean, " +
      "crisp, fully resolved imagery, free of film grain and softness. Every " +
      "surface reads — rivets and panel lines on metal, fabric weave and " +
      "stitching, individual hairs, skin texture and pores, crisp legible " +
      "lettering and insignia, grass and foliage resolved blade by blade and " +
      "leaf by leaf. Deep focus, precise micro-contrast, clean edges, rich " +
      "natural colour and a full tonal range from deep blacks to clean " +
      "highlights.",
  },
  colourise: {
    id: "colourise",
    label: "Colourise",
    purpose: "Period-plausible colour on black and white footage.",
    look:
      "Photographed on period colour stock — Kodachrome, slightly muted, " +
      "never vivid or digital. Believable, varied skin tones. Skies, foliage, " +
      "brick, stone, timber, painted metal and fabric in the colours those " +
      "materials plausibly had at the time and place shown. Natural daylight, " +
      "restrained saturation, no teal-and-orange grading. Fine grain and " +
      "abundant real surface detail throughout.",
  },
  monochrome: {
    id: "monochrome",
    label: "Black and white, detail only",
    purpose: "Stays monochrome. Adds resolution and nothing else.",
    look:
      "Black and white throughout — no colour anywhere in frame. " +
      "Photographed on fine-grained 35mm black and white negative with a " +
      "sharp prime lens. A full tonal range: deep blacks, clean whites, " +
      "detailed mid greys. Enormous genuine surface detail — fabric weave, " +
      "metal panel lines and rivets, skin texture, individual hairs, legible " +
      "lettering, grass and foliage resolved. Crisp focus, natural film grain.",
  },
  clean: {
    id: "clean",
    label: "Clean and repair",
    purpose: "Damaged or noisy footage rendered as an undamaged print.",
    look:
      "A pristine first-generation print struck from an undamaged negative: " +
      "smooth unblemished emulsion, an even and perfectly steady exposure, a " +
      "clean continuous image edge to edge. Fine natural film grain, evenly " +
      "distributed, the way a well-kept print of its era looks. Sharp focus " +
      "and abundant real surface detail underneath — fabric weave, metal " +
      "panel lines, skin texture, foliage, crisp legible lettering. Rich " +
      "natural contrast with deep blacks and clean highlights.",
  },
};

/** Offered in this order. Detail is what most footage needs. */
export const RESTORE_ORDER: RestorePresetId[] = [
  "detail",
  "sharp",
  "monochrome",
  "colourise",
  "clean",
];

/**
 * The prompt, in the order Seedance is documented to read.
 *
 * Hold (what this is and what must not move), how far it may depart, the look
 * to render, what the artist knows about the footage, then the stability tail.
 * The artist's own words sit in the middle where they carry weight — not at
 * the end, where a bare appended sentence reads as the most recent and most
 * specific instruction and can override everything above it.
 */
export function restorePrompt(
  look: string,
  options: { freedom?: number; note?: string } = {},
): string {
  const wanted = look.trim();
  const about = (options.note ?? "").trim();

  return [
    HOLD,
    latitudeFor(options.freedom ?? DEFAULT_FREEDOM).text,
    wanted,
    about
      ? "About this footage, as background for the render rather than an " +
        `instruction to change it: ${about}`
      : "",
    TAIL,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Half and half, which is what an artist means by "restore this". */
export const DEFAULT_FREEDOM = 50;

/** The look a preset starts the artist off with. */
export function presetLook(id: RestorePresetId): string {
  return RESTORE_PRESETS[id].look;
}

/**
 * The key-frame prompt — the half of restoration that actually adds detail.
 *
 * Measured, twice: a video model handed a degraded clip re-renders it and
 * cannot exceed what the source already resolved. Held faithful it adds grain
 * and calls it detail; turned loose it melts faces. Neither beats scaling the
 * clip in After Effects, which is the bar this has to clear.
 *
 * An *image* model is a different machine. Seedream given one archive frame
 * will paint a real photograph of that scene — correct anatomy, real fabric,
 * real metal — because generating a convincing still is the thing image models
 * are built for and video models are not.
 *
 * So the work splits in two, and this is the first half:
 *
 *   1. Pull one frame out of the clip and have Seedream render it *properly*.
 *      This is where the quality comes from, and it is judged as a still
 *      before a single second of video is paid for.
 *   2. Hand that still to Seedance as a `reference_image` alongside the clip
 *      as a `reference_video` — verified to combine, 2026-08-11 — so the clip
 *      supplies the motion and the still supplies the look.
 *
 * The still cannot be a `first_frame`: frames are refused beside reference
 * media, and the clip has to travel as reference media for its motion to be
 * read at all.
 *
 * The prompt is emphatic about *this* scene rather than a scene like it. An
 * image model given latitude will compose a better photograph, and a better
 * photograph of different people is worthless here.
 */
export function keyframePrompt(look: string, note?: string): string {
  const wanted = look.trim();
  const about = (note ?? "").trim();

  return [
    "Render this exact scene as a real, high-resolution photograph. Every " +
      "person stays in the same position wearing the same clothing with the " +
      "same posture and expression; every aircraft, vehicle, building, sign " +
      "and object stays exactly where it is and exactly what it is; the " +
      "camera angle, the lens and the direction of the light are unchanged. " +
      "Nothing enters the frame and nothing leaves it.",
    /*
     * The framing lock, said three ways.
     *
     * The first real key frame came back as the right scene at the wrong size:
     * Seedream pushed in hard, filling the frame with the fuselage where the
     * reference had the whole aircraft plus another behind it and a lot of
     * sky. An image model asked for a photograph composes a better one, and a
     * tighter crop is almost always the better photograph — which makes this
     * the model doing its job and the wrong job.
     *
     * It matters more than it looks. The still is handed to the video pass as
     * a reference beside the clip; if the two disagree about how much of the
     * world is in frame, they fight, and the animation gets the worst of both.
     */
    "Match the reference framing exactly. Identical field of view, identical " +
      "crop, identical distance from the subject: every object occupies the " +
      "same position and the same proportion of the frame as it does in the " +
      "reference, and the edges of the picture cut through exactly the same " +
      "places. Do not zoom in, do not push in, do not crop tighter, do not " +
      "recompose, do not centre the subject, do not improve the composition. " +
      "Anything visible at the edges of the reference is still visible at the " +
      "edges here.",
    "This is a photograph of real people and real machinery, so faces are " +
      "specific and anatomically correct with real skin, eyes and hair, hands " +
      "have the right number of fingers, uniforms and equipment are " +
      "physically plausible and correctly worn, and metal, fabric, skin and " +
      "vegetation are each made of the right material.",
    wanted,
    about
      ? `About this footage, as background for the render rather than an ` +
        `instruction to change it: ${about}`
      : "",
    /*
     * Deep focus, named explicitly.
     *
     * The first real key frame came back photoreal and *soft*: a shallow
     * depth of field with the aircraft and the background thrown out. That is
     * what "sharp prime lens, 35mm negative" means to an image model — a
     * flattering modern portrait look — and it is the opposite of archive,
     * which is deep-focus documentary photography where everything reads.
     * Sharpness across the frame has to be asked for; it is not implied by
     * asking for a sharp lens.
     */
    "Every part of the frame is in sharp focus, front to back — deep depth of " +
      "field, small aperture, documentary photography rather than a portrait. " +
      "No shallow focus, no background blur, no bokeh, no motion blur, no " +
      "vignetting. Foreground, subject and far background are all equally " +
      "crisp and fully detailed.",
    "The reference is a degraded, low-resolution frame. Do not reproduce its " +
      "softness, its noise or its damage — render what it is a photograph " +
      "*of*, at full quality.",
  ]
    .filter(Boolean)
    .join(" ");
}
