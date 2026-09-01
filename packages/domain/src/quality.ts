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

/**
 * The largest size a provider offers, for a frame whose shape is already known.
 *
 * `bestQualitySize` deliberately declines on a mixed list, because choosing an
 * explicit `2160x3840` when the artist may have wanted landscape is a creative
 * decision wearing a quality costume. That caution is right in the Generate
 * form and wrong here: a restoration already *has* a source frame, so its
 * aspect is a fact rather than a choice, and declining meant sending no size
 * at all — which is how a "4K key frame" came back as a 2848x1600 JPEG.
 *
 * Tiers win when a provider offers them, because a tier names a height and
 * lets the aspect follow the input, which is exactly what is wanted. Failing
 * that, the biggest explicit size whose shape is closest to the source.
 */
export function largestSize(sizes: string[], aspect?: number): string | undefined {
  if (sizes.length === 0) return undefined;

  const tiers = sizes.filter((size) => tierPixels(size) !== undefined);
  if (tiers.length > 0) {
    return tiers.reduce((best, size) =>
      (tierPixels(size) ?? 0) > (tierPixels(best) ?? 0) ? size : best,
    );
  }

  const explicit = sizes
    .map((size) => {
      const match = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
      if (!match) return undefined;
      const width = Number(match[1]);
      const height = Number(match[2]);
      return { size, pixels: width * height, aspect: width / height };
    })
    .filter((entry): entry is { size: string; pixels: number; aspect: number } => !!entry);
  if (explicit.length === 0) return undefined;

  // Shape first, then pixels. A 4K portrait frame is not a better answer than
  // a smaller landscape one when the source is landscape.
  const wanted = aspect && Number.isFinite(aspect) ? aspect : undefined;
  const ranked = explicit.slice().sort((a, b) => {
    if (wanted !== undefined) {
      const da = Math.abs(a.aspect - wanted);
      const db = Math.abs(b.aspect - wanted);
      if (Math.abs(da - db) > 0.05) return da - db;
    }
    return b.pixels - a.pixels;
  });
  return ranked[0]?.size;
}
