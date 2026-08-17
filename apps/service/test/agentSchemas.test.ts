import { describe, expect, it } from "vitest";
import { TRAIT_SCHEMA } from "../src/agent/describer.js";
import { DRAFT_SCHEMA } from "../src/agent/director.js";

/**
 * Structured output accepts a narrow subset of JSON Schema, and rejects the
 * whole request for anything outside it — not the offending keyword, the
 * request. `maxItems` on an array is a 400 that reaches the artist as "could
 * not describe these plates".
 *
 * Nothing else catches this: the schema is only validated when a real model
 * call is made, which needs a key and costs money, so it fails first in front
 * of whoever is using the panel. This is the cheap guard that runs every time.
 */
const UNSUPPORTED = [
  "maxItems",
  "minItems",
  "maxLength",
  "minLength",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "default",
  "uniqueItems",
];

function keywordsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keywordsIn(entry, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      found.add(key);
      keywordsIn(nested, found);
    }
  }
  return found;
}

describe("agent output schemas stay inside the accepted subset", () => {
  for (const [name, schema] of [
    ["describer", TRAIT_SCHEMA],
    ["director", DRAFT_SCHEMA],
  ] as const) {
    it(`${name} uses no keyword the validator refuses`, () => {
      const used = keywordsIn(schema);
      const offending = UNSUPPORTED.filter((keyword) => used.has(keyword));
      expect(offending).toEqual([]);
    });
  }
});
