import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureWorkspace, resolveStorageUri, resolveWorkspace, toStorageUri } from "../src/index.js";

// A folder with a space: AE projects live in "Client Work/Project 01" far more
// often than in a clean path, and Windows quoting bugs hide there.
const tempRoot = await mkdtemp(path.join(tmpdir(), "seed ae test "));

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("workspace layout", () => {
  it("creates the .seed-ae tree under a path containing spaces", async () => {
    const layout = await ensureWorkspace(resolveWorkspace(tempRoot));
    expect(layout.root).toContain(".seed-ae");
    for (const dir of [
      layout.assetsDir,
      layout.originalsDir,
      layout.generatedDir,
      layout.proxiesDir,
      layout.thumbnailsDir,
      layout.manifestsDir,
    ]) {
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
  });
});

describe("storage URIs", () => {
  const layout = resolveWorkspace(tempRoot);

  it("stores workspace-relative POSIX paths regardless of host separators", () => {
    const absolute = path.join(layout.originalsDir, "HERO f0060.png");
    expect(toStorageUri(layout, absolute)).toBe(
      "assets/originals/HERO f0060.png",
    );
  });

  it("round-trips back to the same absolute path", () => {
    const absolute = path.join(layout.originalsDir, "HERO f0060.png");
    const uri = toStorageUri(layout, absolute);
    expect(resolveStorageUri(layout, uri)).toBe(absolute);
  });

  it("rejects paths that escape the workspace", () => {
    expect(() => toStorageUri(layout, path.join(tempRoot, "outside.png"))).toThrow(
      /outside the SEED workspace/,
    );
    expect(() => resolveStorageUri(layout, "../../secrets.env")).toThrow(
      /escapes the workspace/,
    );
    expect(() => resolveStorageUri(layout, "C:/Windows/system.ini")).toThrow(
      /workspace-relative/,
    );
    expect(() => resolveStorageUri(layout, "")).toThrow(/empty/);
  });
});
