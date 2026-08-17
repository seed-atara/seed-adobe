import { describe, expect, it } from "vitest";
import { SeedClient } from "../src/api/client.ts";

/**
 * The client serialises bodies in one place, and every method must hand it a
 * plain object.
 *
 * This exists because six item methods passed `JSON.stringify(...)` as the
 * body and it was serialised again, so the service received a JSON *string*
 * where it expected an object and answered "request failed validation" for
 * every write. Nothing caught it: the service tests build their own requests
 * with raw fetch, and the panel render tests never call the network. The seam
 * between them was exactly where it broke.
 */
function captureRequest() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Every write path, with the smallest body each accepts. */
const WRITES: Array<[string, (client: SeedClient) => Promise<unknown>]> = [
  ["adoptItem", (c) => c.adoptItem({ handle: "a", kind: "prop", name: "A", plates: [], traits: [], realPerson: false } as never)],
  ["updateItem", (c) => c.updateItem("itm_1", { name: "B" })],
  ["renameItem", (c) => c.renameItem("itm_1", "b")],
  ["createVariant", (c) => c.createVariant("itm_1", "night", "Night")],
  ["addRevision", (c) => c.addRevision("itm_1", { message: "m" })],
  ["resolvePrompt", (c) => c.resolvePrompt({ prompt: "p", providerId: "x", itemMentions: [] })],
  ["startGeneration", (c) => c.startGeneration({ providerId: "x" })],
];

describe("request bodies are encoded exactly once", () => {
  for (const [name, call] of WRITES) {
    it(`${name} sends an object, not a string of one`, async () => {
      const { calls, restore } = captureRequest();
      try {
        await call(new SeedClient("http://svc", "token"));
      } finally {
        restore();
      }

      const body = calls[0]?.init.body;
      expect(typeof body).toBe("string");
      const parsed = JSON.parse(body as string);
      // Double-encoding leaves a string here instead of the payload object.
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
    });
  }
});
