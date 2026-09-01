/**
 * Ids, from whichever crypto the runtime has.
 *
 * `globalThis.crypto` is the Web Crypto API, and both Node (18+) and every
 * browser expose it — so importing `node:crypto` here was the one line in the
 * whole domain package that made it node-only. That went unnoticed while the
 * panel imported nothing but types from this package, and broke the panel
 * build the moment it imported an actual function. A shared package that only
 * runs on one side of the wire is not shared.
 */
const randomUUID = (): string => globalThis.crypto.randomUUID();

/**
 * Entity id prefixes. Prefixes make ids self-describing in logs, filenames and
 * provider payloads without needing a lookup.
 */
export const ID_PREFIX = {
  asset: "ast",
  generation: "gen",
  job: "job",
  correlation: "cor",
  item: "itm",
  itemVariant: "itv",
  itemRevision: "itr",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID()}`;
}

export function isId(kind: IdKind, value: string): boolean {
  return value.startsWith(`${ID_PREFIX[kind]}_`);
}
