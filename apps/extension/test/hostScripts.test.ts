import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The host scripts cannot be typechecked and cannot be run outside Adobe, so
 * every mistake in them has been found by an artist with the panel open. These
 * are the two classes that have actually happened, caught cheaply:
 *
 *   - ES5+ syntax in an ES3 engine. ExtendScript accepts `const` at parse time
 *     and then throws on assignment at runtime, so the failure surfaces
 *     nowhere near the line that caused it.
 *   - The panel calling a host function that does not exist. CEP returns the
 *     string "EvalScript error." and nothing else, which says nothing about
 *     which call failed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOSTS = ["seed-host.jsx", "seed-host-ppro.jsx"];

function readHost(name: string): string {
  return readFileSync(path.join(root, "apps/extension/jsx", name), "utf8");
}

/** Strips comments and strings, so prose about `const` is not a finding. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

describe.each(HOSTS)("%s", (name) => {
  const source = readHost(name);
  const body = code(source);

  it.each([
    ["const declarations", /\bconst\s+[A-Za-z_$]/],
    ["let declarations", /\blet\s+[A-Za-z_$]/],
    ["arrow functions", /=>/],
    ["template literals", /`/],
    ["Array.forEach", /\.forEach\s*\(/],
    ["Object.keys", /\bObject\s*\.\s*keys\s*\(/],
    ["JSON.stringify", /\bJSON\s*\.\s*(stringify|parse)\s*\(/],
    ["trailing commas in literals", /,\s*[\]}]/],
  ])("has no %s", (_label, pattern) => {
    const offending = body
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => pattern.test(line));
    expect(offending).toEqual([]);
  });

  it("declares every function before anything calls it", () => {
    /*
     * ES3 hoists declarations, so order is legal — but these files are also
     * read top to bottom by people, and a call above its declaration has twice
     * been a rename that missed one site. Checking that each called seed*
     * function exists at all catches that; ordering is left alone.
     */
    const declared = new Set(
      [...source.matchAll(/^function\s+(seed[A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
    );
    const called = new Set(
      [...body.matchAll(/\b(seed[A-Za-z0-9_]*)\s*\(/g)].map((m) => m[1]),
    );
    const missing = [...called].filter((fn) => !declared.has(fn));
    expect(missing).toEqual([]);
  });
});

/*
 * Calls that deliberately exist in one host only, with the reason and with how
 * the panel coped when it is talking to the other one.
 *
 * An entry here is a claim about the UI, not a way to quiet the check: either
 * the panel never makes the call in the other host, or it makes it and treats
 * the failure as an answer. Both are fine; guessing is not.
 */
const HOST_SPECIFIC: Record<string, { host: string; because: string }> = {
  seedPickupFrame: {
    host: "seed-host-ppro.jsx",
    because:
      "registers a frame Premiere's own Export Frame button produced; After " +
      "Effects captures directly and has no equivalent",
  },
  // Regions are compositions inside compositions. Premiere has no such thing,
  // so listRegions fails there, and the panel reads that failure as "no
  // regions" and hides the whole section rather than offering something that
  // cannot work.
  seedListRegions: { host: "seed-host.jsx", because: "regions are compositions" },
  seedCreateRegion: { host: "seed-host.jsx", because: "regions are compositions" },
  seedCaptureRegion: { host: "seed-host.jsx", because: "regions are compositions" },
  seedInsertRegion: { host: "seed-host.jsx", because: "regions are compositions" },
  seedSetRegionAspect: { host: "seed-host.jsx", because: "regions are compositions" },
  seedSetRegionContain: { host: "seed-host.jsx", because: "regions are compositions" },
};

describe("panel to host contract", () => {
  it("only calls host functions that exist in both hosts' namespaces", () => {
    const bridge = readFileSync(
      path.join(root, "apps/panel/src/api/cep.ts"),
      "utf8",
    );

    /*
     * The panel writes calls as `${hostPrefix()}doThing(...)`, where the prefix
     * resolves to seedAeft_ or seedPpro_. Whatever it names has to exist in the
     * host it is talking to — and since the prefix is chosen at runtime, a call
     * present in only one host is a crash waiting for whichever application the
     * artist happens to open.
     */
    const calls = new Set(
      [...bridge.matchAll(/\$\{hostPrefix\(\)\}([A-Za-z0-9_]+)\s*\(/g)].map(
        (m) => `seed${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`,
      ),
    );
    expect(calls.size).toBeGreaterThan(0);

    for (const host of HOSTS) {
      const source = readHost(host);
      const missing = [...calls].filter((fn) => {
        // Absent from the host it was never meant to be in is not missing.
        const only = HOST_SPECIFIC[fn];
        if (only && only.host !== host) return false;
        return !new RegExp(`function\\s+${fn}\\s*\\(`).test(source);
      });
      expect({ host, missing }).toEqual({ host, missing: [] });
    }
  });

  it("keeps the host-specific list honest about what exists", () => {
    // An entry that is no longer one-sided is an exemption nobody needs.
    for (const [fn, { host, because }] of Object.entries(HOST_SPECIFIC)) {
      expect(because.length).toBeGreaterThan(15);
      expect(new RegExp(`function\\s+${fn}\\s*\\(`).test(readHost(host))).toBe(true);
      const others = HOSTS.filter((name) => name !== host);
      for (const other of others) {
        expect({ fn, other, present: new RegExp(`function\\s+${fn}\\s*\\(`).test(readHost(other)) }).toEqual(
          { fn, other, present: false },
        );
      }
    }
  });
});
