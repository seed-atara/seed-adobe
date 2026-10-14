import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, loadDotEnv } from "../src/config.js";

const created: string[] = [];

afterEach(async () => {
  delete process.env.SEED_TEST_MARKER;
  for (const dir of created.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("loadDotEnv", () => {
  it("finds .env in an ancestor, not just the working directory", async () => {
    // `npm run dev` starts the service in apps/service while .env sits at the
    // repo root; looking only at cwd meant starting with no credentials.
    const root = await mkdtemp(path.join(tmpdir(), "seed env "));
    created.push(root);
    const nested = path.join(root, "apps", "service");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(root, ".env"), "SEED_TEST_MARKER=found\n");

    const used = loadDotEnv(nested);
    expect(used).toBe(path.join(root, ".env"));
    expect(process.env.SEED_TEST_MARKER).toBe("found");
  });

  it("returns undefined when there is no .env anywhere above", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "seed noenv "));
    created.push(root);
    // A temp dir has no .env above it up to the filesystem root.
    expect(loadDotEnv(root)).toBeUndefined();
  });
});

/*
 * A timeout that covered the answer and not the request.
 *
 * Seedance's own default is 60s. Without an R2 publisher configured, every
 * reference image travels inlined as base64 -- twice over for a loop, which
 * puts the same still in both frame slots -- and five party-city generations
 * died at 62-69s reported as "Seedance POST /contents/generations/tasks
 * failed", with no HTTP status, because an abort in transport never reaches
 * the API to be explained. Nothing ever set `timeoutMs`, so the 60s was not
 * reachable from outside the provider.
 */
describe("the Seedance request timeout", () => {
  const base = {
    ARK_API_KEY: "test-key",
    SEEDANCE_MODEL_ID: "test-model",
  } as NodeJS.ProcessEnv;

  it("is generous by default, because the request carries the references", () => {
    expect(loadConfig({ ...base }).providers.seedanceTimeoutMs).toBe(300_000);
  });

  it("can be set, so a slow link is a setting and not a code change", () => {
    expect(loadConfig({ ...base, SEEDANCE_TIMEOUT_MS: "90000" }).providers.seedanceTimeoutMs).toBe(90_000);
  });

  it("treats absent, empty and zero alike — a zero timeout is not a setting", () => {
    for (const blank of ["", "0"]) {
      expect(
        loadConfig({ ...base, SEEDANCE_TIMEOUT_MS: blank }).providers.seedanceTimeoutMs,
      ).toBe(300_000);
    }
  });

  it("refuses a negative, loudly, rather than quietly using the default", () => {
    /*
     * `parsePositiveInt` throws on a negative, and that is the right behaviour
     * to keep: a timeout somebody typed wrong should stop the service starting,
     * not be silently swapped for one they did not choose.
     */
    expect(() => loadConfig({ ...base, SEEDANCE_TIMEOUT_MS: "-1" })).toThrow(
      /non-negative integer/,
    );
  });
});
