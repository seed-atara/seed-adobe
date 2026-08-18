import type { AeContext } from "@seed-ae/domain";

/**
 * One line describing how the host was managing colour when a frame was made.
 *
 * This exists because "—" is what the provenance panel showed for every capture
 * ever taken: the field was in the schema and nothing filled it. A treatment
 * chain has to know whether it is being handed sRGB-encoded display values or
 * linearised scene values, and the PNG cannot say — only the project could,
 * and only at the moment of capture.
 *
 * Unknown is reported as unknown. Collapsing "we could not find out" into a
 * confident "sRGB" is how a look ends up double-gamma'd, which reads as a
 * contrast problem and gets corrected with a grade that makes it worse.
 */
export function describeColor(context: AeContext): string {
  const cm = context.colorManagement;
  const parts: string[] = [];

  const space = context.colorSpace ?? cm?.workingSpace;
  if (space !== undefined && space !== "") parts.push(space);
  else if (space === "") parts.push("None");

  if (cm?.bitsPerChannel) parts.push(`${cm.bitsPerChannel}-bit`);

  /*
   * Linearised is the one that changes what the pixels mean, so it is named
   * rather than left to be inferred from the working space.
   */
  if (cm?.linearizeWorkingSpace) parts.push("linearised");
  else if (cm?.linearBlending) parts.push("linear blending");

  if (cm?.workingGamma) parts.push(`γ${cm.workingGamma}`);

  return parts.length > 0 ? parts.join(" · ") : "not recorded";
}

/**
 * Why this frame may not survive a film look, if there is a reason.
 *
 * Kept separate from the description because it is a judgement rather than a
 * fact, and because it should only ever be shown where it can be acted on.
 */
export function colorWarning(context: AeContext): string | undefined {
  const depth = context.colorManagement?.bitsPerChannel;
  if (depth === undefined) return undefined;
  if (depth === 32) return undefined;
  return (
    `Captured from a ${depth}-bit project. The optical half of a film look is ` +
    "physically meaningless below 32-bit float, and the tonemap will band in " +
    "skies and highlight rolloffs."
  );
}

/**
 * Why a *returned* clip may not survive import, if there is a reason.
 *
 * The mirror of `colorWarning`, which is about the frame going out. A Seedance
 * result at 1080p is 10-bit and carries values above nominal white — measured
 * at 983 against a ceiling of 940. Below 32-bit float After Effects clips those
 * at import and they are gone; the extra precision was paid for and thrown
 * away at the door.
 *
 * Only said where it can be acted on: an 8-bit project importing an 8-bit
 * result has nothing to fix.
 */
export function resultDepthWarning(
  context: AeContext | undefined,
  size: string,
  outputFormats: string[],
  /** After Effects calls it a project; Premiere calls it the sequence. */
  scope: "project" | "sequence" = "project",
): string | undefined {
  const depth = context?.colorManagement?.bitsPerChannel;
  if (depth === undefined || depth === 32) return undefined;
  // 10-bit only arrives at 1080p, and only from a provider offering containers.
  if (outputFormats.length === 0 || !/1080/.test(size)) return undefined;
  return (
    `This ${scope} works in ${depth}-bit. A 1080p result is 10-bit and carries ` +
    "highlights above nominal white — those are clipped on the way in below " +
    "32-bit float, and cannot be recovered afterwards."
  );
}
