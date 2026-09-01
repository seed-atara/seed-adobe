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
 * What holds the result to the source.
 *
 * Short on purpose. Every clause is doing one of two jobs: keeping Ark's task
 * classification on "edit" so `duration: -1` is legal, or naming the specific
 * things that must not move. It is deliberately *not* a list of everything a
 * model might do wrong — that list was what crowded out the description of
 * what to make.
 */
const ANCHOR =
  "Re-render this exact footage at far higher quality. The reference video is " +
  "the shot: keep its framing, its camera position and movement, its lens and " +
  "perspective, its cuts, and the identity, position and action of every " +
  "person, aircraft, vehicle and object in it. Same shot, same performance, " +
  "same timing — rendered as if it had been photographed properly.";

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
 * Anchor (what this is and what must not move), then the look (what to make),
 * then what the artist knows about the footage, then the stability tail. The
 * artist's own words go in the middle where they carry the most weight — not
 * at the end, where a bare appended sentence reads as the most recent and most
 * specific instruction and can override everything above it.
 */
export function restorePrompt(look: string, note?: string): string {
  const wanted = look.trim();
  const about = (note ?? "").trim();

  return [
    ANCHOR,
    wanted,
    about
      ? `About this footage, as background for the render rather than an ` +
        `instruction to change it: ${about}`
      : "",
    TAIL,
  ]
    .filter(Boolean)
    .join(" ");
}

/** The look a preset starts the artist off with. */
export function presetLook(id: RestorePresetId): string {
  return RESTORE_PRESETS[id].look;
}
