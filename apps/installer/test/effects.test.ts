import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectsState, type EffectFile } from "../src/main/effects.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "seed effects "));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function bundled(): Promise<EffectFile[]> {
  const dir = path.join(root, "effects");
  await mkdir(dir, { recursive: true });
  const names = ["SEED Film Look.aex", "SEED Frequency Detailer.aex"];
  for (const name of names) await writeFile(path.join(dir, name), "aex", "utf8");
  return names.map((name) => ({ name, source: path.join(dir, name) }));
}

describe("what the window is told about the effects", () => {
  it("says Windows-only off Windows, whatever is on disk", async () => {
    if (process.platform === "win32") return;
    expect(effectsState(await bundled())).toBe("unsupported");
  });

  it("says unavailable when this build carries none", () => {
    // Distinct from "not installed": one is press the button, the other is
    // there is no button that could help. A checkout that never built the
    // plugins still produces an installer, and this is what it reports.
    expect(effectsState([])).toBe(process.platform === "win32" ? "unavailable" : "unsupported");
  });

  it("says unavailable when a named file is missing from the bundle", async () => {
    if (process.platform !== "win32") return;
    const files = await bundled();
    await rm(files[0]!.source);
    expect(effectsState(files)).toBe("unavailable");
  });
});
