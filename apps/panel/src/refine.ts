import type { Asset } from "@seed-ae/domain";

/**
 * Matching a layer in the timeline back to the generation that made it.
 *
 * The link is the file on disk, deliberately. Nothing is written into the
 * Adobe project to mark a layer as ours: a layer can be renamed, duplicated,
 * pre-composed, or copied into another project, and a mark left on it would
 * survive all of that while quietly meaning something else afterwards. A media
 * path cannot drift from its media.
 *
 * Kept out of the component because the interesting part is what happens when
 * the answer is no — and each "no" needs to tell the artist something they can
 * act on, which is worth testing without After Effects open.
 */

export interface RefineCandidate {
  /** Basename of the file backing the selected layer or clip. */
  filename: string;
  /** What to call it when explaining the outcome. */
  layerName: string;
}

export type RefineTarget =
  | { ok: true; asset: Asset }
  | { ok: false; reason: string };

export function resolveRefineTarget(
  selection: RefineCandidate,
  assets: readonly Asset[],
): RefineTarget {
  const wanted = selection.filename.trim().toLowerCase();
  if (wanted.length === 0) {
    return {
      ok: false,
      reason: `${selection.layerName} has no file behind it, so there is nothing to look up.`,
    };
  }

  /*
   * Case-insensitive because Windows paths are, and the same media reached
   * through a different case is the same media. Compared on the basename
   * alone: the library's copy and the project's reference to it are the same
   * file, but the two can be spelled differently once a project moves.
   */
  const matches = assets.filter(
    (asset) => asset.filename.trim().toLowerCase() === wanted,
  );

  if (matches.length === 0) {
    return {
      ok: false,
      reason:
        `${selection.layerName} did not come from SEED — nothing in the ` +
        "library matches its media, so there is no recipe to reopen.",
    };
  }

  /*
   * More than one library entry can name the same file only if something has
   * gone wrong upstream, since generated filenames carry their generation id.
   * Prefer a generated one, then the newest: guessing quietly is worse than
   * being predictable about which one was chosen.
   */
  const generated = matches.filter((asset) => asset.generationId);
  if (generated.length === 0) {
    return {
      ok: false,
      reason:
        `${selection.layerName} is a captured frame rather than a generation, ` +
        "so it has no recipe. Use it as a reference instead.",
    };
  }

  const newest = [...generated].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0]!;
  return { ok: true, asset: newest };
}
