import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/config.js";

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
