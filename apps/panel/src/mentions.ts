import type { Asset } from "@seed-ae/domain";

/**
 * `@name` references to library assets inside a description.
 *
 * The artist thinks in names — "@bar_wide, but colder" — while the generative
 * models know references only by position. Mentions are the bridge: they are
 * resolved to assets here, and the director rewrites the prose into the
 * positional form ("Image 1") the models actually answer to.
 */

/** The token that stands for an asset. Stable, and typeable without quoting. */
export function assetToken(asset: Asset): string {
  return asset.filename.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "_");
}

/** The partial token being typed at the caret, if any. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const match = /@([A-Za-z0-9_-]*)$/.exec(before);
  if (!match) return undefined;
  return { query: match[1] as string, start: caret - match[0].length };
}

/** Assets whose token matches what is being typed, best first. */
export function matchAssets(assets: Asset[], query: string): Asset[] {
  const needle = query.toLowerCase();
  return assets
    .filter((asset) => assetToken(asset).toLowerCase().includes(needle))
    .slice(0, 6);
}

/** Replaces the partial mention at the caret with a complete one. */
export function completeMention(
  text: string,
  caret: number,
  asset: Asset,
): { text: string; caret: number } {
  const at = mentionQueryAt(text, caret);
  if (!at) return { text, caret };
  const token = `@${assetToken(asset)} `;
  return {
    text: text.slice(0, at.start) + token + text.slice(caret),
    caret: at.start + token.length,
  };
}

/**
 * Every mention in the text that names an asset we know.
 *
 * Unknown tokens are ignored rather than rejected — an artist writing prose
 * should not be corrected for using an @ in some other sense.
 */
export function findMentions(
  text: string,
  assets: Asset[],
): Array<{ token: string; assetId: string }> {
  const byToken = new Map(assets.map((asset) => [assetToken(asset), asset.id]));
  const found = new Map<string, string>();
  for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const token = match[1] as string;
    const assetId = byToken.get(token);
    if (assetId) found.set(token, assetId);
  }
  return [...found].map(([token, assetId]) => ({ token, assetId }));
}
