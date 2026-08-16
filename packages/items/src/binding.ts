import type {
  ItemKind,
  ItemTextTier,
  ItemTrait,
  MentionSyntax,
  PlateRole,
} from "@seed-ae/domain";

/**
 * The materials manifest — the text an Item actually contributes to a prompt.
 *
 * This is the answer to prompt bloat. An Item does *not* inject a description:
 * the plate carries appearance better than any sentence, and putting forty
 * words of character into the prompt spends the attention the shot direction
 * needs. What an Item does inject is **binding** — which material is for what,
 * and what must not be taken from it — because nothing else can carry that and
 * Ark's own guidance requires it: 素材映射关系必须写进提示词.
 *
 * The result grows with the *number of materials*, not with how much
 * personality someone wrote down. Three characters costs three lines.
 */

/** What each plate role tells the model to take from its material. */
const ROLE_PROVIDES: Record<PlateRole, string> = {
  face: "face and features",
  front: "appearance from the front",
  "three-quarter": "appearance in three-quarter view",
  profile: "profile",
  back: "appearance from behind",
  "full-body": "full-body proportions and posture",
  wardrobe: "wardrobe",
  detail: "detail",
  texture: "surface texture",
  "in-situ": "how it sits in a space",
  wide: "the space and its layout",
  establishing: "the location and its layout",
  "style-plate": "colour, grain and lighting only",
  motion: "movement",
  reference: "appearance",
};

/**
 * What must *not* be taken. Ark's guide is explicit that this belongs in the
 * prompt ("不采用图片背景"), and it is the clause that stops a reference
 * dragging its own scene into the shot.
 */
function exclusionFor(role: PlateRole, kind: ItemKind): string | undefined {
  if (role === "style-plate") return "not its subject or composition";
  if (kind === "location") return undefined;
  if (role === "in-situ") return "not its background";
  return "not its background";
}

/** How a provider names the reference at a given position. */
export function referenceLabel(
  syntax: MentionSyntax,
  position: number,
  kind: "image" | "video" | "audio" = "image",
): string {
  if (syntax === "ark-cn") {
    const noun = kind === "video" ? "视频" : kind === "audio" ? "音频" : "图片";
    return `@${noun}${position}`;
  }
  const noun = kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Image";
  return `${noun} ${position}`;
}

export interface PlateBinding {
  label: string;
  role: PlateRole;
}

/**
 * One line of the manifest for one Item.
 *
 * `Image 2 — SARA: face and features. Not its background.`
 */
export function bindingLine(
  name: string,
  kind: ItemKind,
  plates: PlateBinding[],
): string | undefined {
  if (plates.length === 0) return undefined;
  const clauses = plates.map((plate) => {
    const provides = ROLE_PROVIDES[plate.role];
    const exclusion = exclusionFor(plate.role, kind);
    const tail = exclusion ? ` ${capitalise(exclusion)}.` : "";
    return `${plate.label} — ${name}: ${provides}.${tail}`;
  });
  return clauses.join("\n");
}

/**
 * The traits worth spending words on at this tier.
 *
 * `anchor` keeps only the drift-prone ones — the discrete nameable details a
 * reference reliably loses, which are exactly the ones a sentence holds well.
 * Descriptions of things the plate already shows are not repeated.
 */
export function traitsForTier(
  traits: ItemTrait[],
  tier: ItemTextTier,
): ItemTrait[] {
  if (tier === "none") return [];
  const byPriority = [...traits].sort((a, b) => a.priority - b.priority);
  if (tier === "full") return byPriority;
  if (tier === "brief") return byPriority.slice(0, 4);
  return byPriority.filter((trait) => trait.driftProne).slice(0, 3);
}

export function traitLine(name: string, traits: ItemTrait[]): string | undefined {
  if (traits.length === 0) return undefined;
  return `${name}: ${traits.map((trait) => trait.text).join(", ")}.`;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Words, for the budget meter. Punctuation-only runs do not count. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
