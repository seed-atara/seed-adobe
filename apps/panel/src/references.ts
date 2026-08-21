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
