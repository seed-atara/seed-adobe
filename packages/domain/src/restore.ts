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
