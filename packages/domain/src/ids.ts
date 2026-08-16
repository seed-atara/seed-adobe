import { randomUUID } from "node:crypto";

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
