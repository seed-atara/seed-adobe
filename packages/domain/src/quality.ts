/**
 * Choosing the size that costs nothing creatively and gives the most quality.
 *
 * Providers speak two size vocabularies and they mean different things:
 *
 *   - **tiers** — `480p`, `720p`, `1080p`, `4K`. Pure resolution; the shape of
 *     the frame is chosen separately by aspect ratio. Picking the largest is a
 *     quality decision and nothing else.
 *   - **explicit sizes** — `1920x1080`, `2160x3840`. These carry an aspect
 *     *and* a resolution, so the largest by pixel count may be a portrait frame
 *     when the artist wanted landscape. Picking one of these for them would be
 *     a creative decision wearing a quality costume.
 *
 * So this only answers where the answer is unambiguous. Where sizes encode
 * shape, it returns nothing and the caller keeps whatever it was doing.
 *
 * It matters on Seedance specifically: `resolution` selects the codec there.
 * 480p and 720p are 8-bit with no colour signalling at all, while 1080p is
 * 10-bit and fully tagged — so defaulting to the first entry in the list was
 * defaulting to the worst cell in the table.
 */

/** Approximate pixel count of a tier, or undefined when it is not one. */
function tierPixels(size: string): number | undefined {
  const progressive = /^(\d+)p$/i.exec(size.trim());
  if (progressive) {
    const height = Number(progressive[1]);
    // Tiers name a height; the width follows the aspect the artist chose.
    return height * height;
  }
  const kilo = /^(\d+)k$/i.exec(size.trim());
  if (kilo) {
    const width = Number(kilo[1]) * 1000;
    return width * width;
  }
  return undefined;
}

/**
 * The highest-quality size, where that is purely a quality question.
 *
 * Returns undefined if any entry encodes an aspect ratio, because then the list
 * is not a ladder and there is no "highest" to pick.
 */
export function bestQualitySize(sizes: string[]): string | undefined {
  if (sizes.length === 0) return undefined;

  const scored: Array<{ size: string; pixels: number }> = [];
  for (const size of sizes) {
    const pixels = tierPixels(size);
    // One explicit size and the whole list is a set of shapes, not a ladder.
    if (pixels === undefined) return undefined;
    scored.push({ size, pixels });
  }

  return scored.sort((a, b) => b.pixels - a.pixels)[0]?.size;
}
