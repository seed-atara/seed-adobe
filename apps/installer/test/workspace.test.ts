import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  defaultWorkspace,
  isDefaultWorkspace,
  readWorkspace,
  writeWorkspace,
} from "../src/main/workspace.js";

let root: string;
let stateDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "seed ws "));
  stateDir = path.join(root, "state");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("where generated media goes", () => {
  it("starts inside the app's own folder, and says so", () => {
    const chosen = readWorkspace(stateDir);
    expect(chosen).toBe(defaultWorkspace(stateDir));
    // The window flags this state: it is the one folder nobody thinks to copy
    // when a job moves to another drive.
    expect(isDefaultWorkspace(stateDir, chosen)).toBe(true);
  });

  it("remembers a folder the artist picked, and creates it", () => {
    const target = path.join(root, "Client Work", "Big Job", "seed media");
    const written = writeWorkspace(stateDir, target);

    expect(existsSync(written)).toBe(true);
    expect(readWorkspace(stateDir)).toBe(path.resolve(target));
    expect(isDefaultWorkspace(stateDir, readWorkspace(stateDir))).toBe(false);
  });

  it("falls back when the chosen folder has gone away", async () => {
    const target = path.join(root, "external drive");
    writeWorkspace(stateDir, target);
    expect(readWorkspace(stateDir)).toBe(path.resolve(target));

    // An unplugged drive should cost the artist their recent library, not the
    // ability to start the application at all.
    await rm(target, { recursive: true, force: true });
    expect(readWorkspace(stateDir)).toBe(defaultWorkspace(stateDir));
  });

  it("treats an unreadable record as unchosen", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "workspace.json"), "{ not json", "utf8");
    expect(readWorkspace(stateDir)).toBe(defaultWorkspace(stateDir));
  });
});
