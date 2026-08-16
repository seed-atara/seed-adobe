/**
 * `@handle` and `@handle/variant` references to Items inside a prompt.
 *
 * The artist thinks in names — "@sara in @bar, @kodak_night" — and the models
 * know references only by position. Mentions are the bridge. Ark's own prompt
 * guide uses the same `@` prefix for materials (`@图片N`), so this converges
 * with the provider's syntax rather than fighting it.
 */

/** A mention as it appears in prose, before any Item lookup. */
export interface ParsedMention {
  /** Everything after `@`, e.g. `sara/red-coat`. */
  token: string;
  handle: string;
  variantSlug?: string;
  /** Character offsets of the whole `@…` run, for replacement. */
  start: number;
  end: number;
}

const MENTION = /@([a-z0-9][a-z0-9_-]*)(?:\/([a-z0-9][a-z0-9_-]*))?/gi;

/**
 * Every `@…` run in the text, in order of appearance.
 *
 * Unknown handles are *not* filtered here — an `@` used in some other sense is
 * ordinary prose, and correcting the artist for writing one would be wrong.
 * Resolution decides what is real; this only finds candidates.
 */
export function parseMentions(text: string): ParsedMention[] {
  const found: ParsedMention[] = [];
  for (const match of text.matchAll(MENTION)) {
    const handle = (match[1] as string).toLowerCase();
    const variantSlug = match[2]?.toLowerCase();
    found.push({
      token: variantSlug ? `${handle}/${variantSlug}` : handle,
      handle,
      ...(variantSlug ? { variantSlug } : {}),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return found;
}

/** The partial token being typed at the caret, for autocomplete. */
export function mentionQueryAt(
  text: string,
  caret: number,
): { query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const match = /@([a-z0-9][a-z0-9_/-]*)?$/i.exec(before);
  if (!match) return undefined;
  return { query: match[1] ?? "", start: caret - match[0].length };
}

/**
 * Replaces mention runs with their resolved labels, right to left.
 *
 * Right to left because every replacement shifts the offsets of everything
 * after it, and walking backwards means the offsets still in play are the ones
 * not yet touched.
 */
export function replaceMentions(
  text: string,
  replacements: Array<{ start: number; end: number; label: string }>,
): string {
  const ordered = [...replacements].sort((a, b) => b.start - a.start);
  let out = text;
  for (const { start, end, label } of ordered) {
    out = out.slice(0, start) + label + out.slice(end);
  }
  return out;
}
