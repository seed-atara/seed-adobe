import type { Asset } from "@seed-ae/domain";

/**
 * Matching an output's shape to the frame it came from.
 *
 * Providers express shape in two different vocabularies — Seedance takes a
 * ratio like `16:9`, Seedream takes a size like `1920x1080` — and an artist
 * working from a captured plate wants neither: they want the result to be the
 * shape of the thing they captured. So both vocabularies are read as a number
 * and compared against the reference.
 */

/** The width-to-height ratio an option describes, if it describes one. */
export function parseAspect(option: string): number | undefined {
  const ratio = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(option.trim());
  if (ratio) {
    const width = Number(ratio[1]);
    const height = Number(ratio[2]);
    return height > 0 ? width / height : undefined;
  }

  const size = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(option.trim());
  if (size) {
    const width = Number(size[1]);
    const height = Number(size[2]);
    return height > 0 ? width / height : undefined;
  }

  // "2K", "720p", "adaptive" name a resolution or a policy, not a shape.
  return undefined;
}

/** The shape of an asset, when it knows its own dimensions. */
export function aspectOf(asset: Asset | undefined): number | undefined {
  if (!asset?.width || !asset?.height) return undefined;
  return asset.width / asset.height;
}

/**
 * The option closest in shape to a target.
 *
 * Compared on the log of the ratio, so being twice as wide and half as wide
 * are the same distance away. Comparing the raw quotient would quietly favour
 * wide options, because everything narrower than the target is squeezed into
 * the interval below 1.
 */
export function closestAspect(
  options: string[],
  target: number,
): string | undefined {
  let best: { option: string; distance: number } | undefined;

  for (const option of options) {
    const aspect = parseAspect(option);
    if (aspect === undefined) continue; // not a shape; cannot be closest to one
    const distance = Math.abs(Math.log(aspect / target));
    if (!best || distance < best.distance) best = { option, distance };
  }

  return best?.option;
}

/** How an aspect reads to a person: "1.78 (16:9-ish)". */
export function describeAspect(aspect: number): string {
  if (Math.abs(aspect - 1) < 0.02) return "square";
  return aspect > 1
    ? `${aspect.toFixed(2)}:1 wide`
    : `1:${(1 / aspect).toFixed(2)} tall`;
}
