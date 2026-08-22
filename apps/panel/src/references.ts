import type { GenerationOperation } from "@seed-ae/domain";

/**
 * Keeping reference roles lined up with the references they describe.
 *
 * Roles are positional: `inputRoles[i]` describes `inputAssetIds[i]`. Nothing
 * enforces that, and the two arrays have drifted apart in practice — removing
 * an asset from the library filtered the ids and left the roles at their old
 * length, so a role survived with no reference under it.
 *
 * That is not a cosmetic drift. `anchored` asks whether any role is a first or
 * last frame, and a leftover "first" answered yes, which raised the "a first or
 * last frame cannot be combined with references" banner and disabled Generate —
 * over a frame the artist could not see in the strip, and therefore could not
 * change back.
 */
export type ReferenceRole = "reference" | "first" | "last" | "loop";

/**
 * The roles for exactly the references that exist.
 *
 * Short arrays fill with `reference`, long ones are cut. Callers should treat
 * this as the only reading of roles, so a desynced form cannot be interpreted.
 */
export function alignRoles(
  assetIds: readonly string[],
  roles: readonly string[],
): ReferenceRole[] {
  return assetIds.map((_, index) => (roles[index] as ReferenceRole) ?? "reference");
}

/** Whether any reference is pinned to a frame slot rather than being one of many. */
export function isAnchored(roles: readonly ReferenceRole[]): boolean {
  return roles.some((role) => role !== "reference");
}

/**
 * Whether the set mixes frames and references, which the provider refuses.
 *
 * "first/last frame content cannot be mixed with reference media content" — so
 * a set that does both cannot be generated, and saying so before Generate is
 * better than being refused after the wait.
 */
export function mixesFrameModes(roles: readonly ReferenceRole[]): boolean {
  return isAnchored(roles) && roles.some((role) => role === "reference");
}

/**
 * Whether a closing frame has been asked for with nothing to open on.
 *
 * Measured from a real 400 on 2026-08-21: Seedance refuses a lone `last_frame`
 * with "last frame image content cannot be mixed with first frame or reference
 * image content" — a complaint about mixing, for a request that mixed nothing.
 * Whatever the wording, a shot has to start somewhere.
 *
 * `loop` is not caught by this: one still carrying both roles is a first frame
 * as well as a last, and Ark names that mode `flf2v`.
 */
export function lastFrameWithoutFirst(roles: readonly ReferenceRole[]): boolean {
  const hasLast = roles.some((role) => role === "last");
  const hasOpening = roles.some((role) => role === "first" || role === "loop");
  return hasLast && !hasOpening;
}

/**
 * Whether the prompt asks the shot to begin from a flat colour.
 *
 * "from fully black" is a real direction and a common one — a fade up out of
 * nothing — but the model needs an opening *image*, not an adjective. Spotting
 * the intent lets the panel offer to make that frame instead of refusing the
 * shot and leaving the artist to work out why.
 *
 * Matched narrowly and on purpose. This only ever *offers*; a loose match that
 * fires on "a black car drives from the left" would be noise, and one that
 * silently attached a reference would be worse.
 */
export function opensFromFlatColour(
  prompt: string,
): { colour: "black" | "white" } | undefined {
  const text = prompt.toLowerCase();
  const from = /\b(?:from|out of|starts? (?:on|at|in))\s+(?:(?:fully|pure|completely|complete|total|solid|full)\s+)?(black|white)\b/;
  const fade = /\b(?:fade|fades|fading)\s+(?:up|in)\s+from\s+(?:(?:fully|pure|solid)\s+)?(black|white)\b/;
  const begins = /\b(?:begin|begins|open|opens)\s+(?:on|in|with)\s+(?:(?:fully|pure|solid|total)\s+)?(black|white)\b/;

  for (const pattern of [fade, begins, from]) {
    const found = pattern.exec(text);
    if (found) return { colour: found[1] === "white" ? "white" : "black" };
  }
  return undefined;
}

/**
 * Whether the prompt asks the shot to finish on a flat colour.
 *
 * The other half of the fade. Same reasoning as opensFromFlatColour and the
 * same restraint: a closing frame is offered, never attached on its own, and
 * the match is narrow enough that "she disappears into black smoke" does not
 * put a black card on the end of the shot.
 */
export function closesToFlatColour(
  prompt: string,
): { colour: "black" | "white" } | undefined {
  const text = prompt.toLowerCase();
  const fade = /\b(?:fade|fades|fading)\s+(?:out\s+)?to\s+(?:(?:fully|pure|solid)\s+)?(black|white)\b/;
  const ends = /\b(?:end|ends|ending|finish|finishes|closes?)\s+(?:on|in|with|at)\s+(?:(?:fully|pure|solid|total)\s+)?(black|white)\b/;
  /*
   * The bare form has to end the phrase. Without that it fires on
   * "she walks into black smoke" and "a cut to black cars", which
   * would put a black card on the end of a shot that never asked for
   * one. A colour followed by a noun is describing something in the
   * frame, not the frame itself.
   */
  const to = /\b(?:to|into|down to|out to)\s+(?:(?:fully|pure|completely|complete|total|solid|full)\s+)?(black|white)\b(?=\s*(?:[.,;!?]|$))/;

  for (const pattern of [fade, ends, to]) {
    const found = pattern.exec(text);
    if (found) return { colour: found[1] === "white" ? "white" : "black" };
  }
  return undefined;
}

/**
 * The provider to move to when a clip is attached, if the current one cannot
 * take one.
 *
 * Attaching a video to a provider that declares `videoReferences: false` is a
 * request that can only be refused — and on a provider accepting a single
 * reference it is worse than refused, because the clip silently evicts the
 * still captured a moment earlier. Returns undefined when the current provider
 * is already fine, or when nothing loaded can take a clip at all.
 */
export function providerForClip<
  T extends {
    id: string;
    videoReferences: boolean;
    operations: readonly GenerationOperation[] | readonly string[];
  },
>(providers: readonly T[], currentId: string): T | undefined {
  const takesClip = (item: T) =>
    item.videoReferences && item.operations.includes("video.generate");

  const current = providers.find((item) => item.id === currentId);
  if (current && takesClip(current)) return undefined;

  return providers.find(takesClip);
}
