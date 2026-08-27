import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUNDLE_ID, cepExtensionsDir, installPanel, installedPanel, removePanel } from "../src/main/cep.js";
import { ensureToken, provisionPanel } from "../src/main/token.js";

let root: string;
let source: string;
let target: string;

beforeEach(async () => {
  // A space in the path, because a real machine has "Application Support".
  root = await mkdtemp(path.join(tmpdir(), "seed companion "));
  source = path.join(root, "bundled extension");
  target = path.join(root, "cep", BUNDLE_ID);
  await mkdir(path.join(source, "panel"), { recursive: true });
  await writeFile(path.join(source, "panel", "index.html"), "<!doctype html>", "utf8");
  await mkdir(path.join(source, "CSXS"), { recursive: true });
  await writeFile(path.join(source, "CSXS", "manifest.xml"), "<ExtensionManifest/>", "utf8");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("where the panel goes", () => {
  it("uses Adobe's per-user folder on both platforms", () => {
    // Both branches are exercised from whichever platform is running, by
    // handing in the environment. Reading it ambiently made the Windows branch
    // throw on a macOS runner — which is to say, made it uncheckable exactly
    // where it most needed checking. CI found that on its first ever run.
    const win = cepExtensionsDir("win32", { APPDATA: String.raw`C:\Users\a\AppData\Roaming` });
    expect(win).toMatch(/Adobe[\\/]CEP[\\/]extensions$/);

    const mac = cepExtensionsDir("darwin", { HOME: "/Users/a" });
    expect(mac).toMatch(/Library[\\/]Application Support[\\/]Adobe[\\/]CEP[\\/]extensions$/);

    // Never the machine-wide location: that needs elevation, and asking an
    // artist for an admin password to place an HTML folder is a smell.
    expect(win).not.toMatch(/Program Files/i);
    expect(mac.startsWith("/Library")).toBe(false);
  });
});

describe("installing the panel", () => {
  it("copies the bundle and stamps what it installed", async () => {
    const result = installPanel(source, "1.2.3", target);
    expect(result.changed).toBe(true);
    expect(existsSync(path.join(target, "panel", "index.html"))).toBe(true);
    expect(existsSync(path.join(target, "CSXS", "manifest.xml"))).toBe(true);
    expect(installedPanel(target)?.version).toBe("1.2.3");
  });

  it("does nothing when the same version is already there", () => {
    installPanel(source, "1.2.3", target);
    const again = installPanel(source, "1.2.3", target);
    expect(again.changed).toBe(false);
  });

  it("replaces an older version, and says which one it replaced", () => {
    installPanel(source, "1.0.0", target);
    const upgrade = installPanel(source, "1.1.0", target);
    expect(upgrade.changed).toBe(true);
    expect(upgrade.previousVersion).toBe("1.0.0");
    expect(installedPanel(target)?.version).toBe("1.1.0");
  });

  it("clears out files an older panel left behind", async () => {
    installPanel(source, "1.0.0", target);
    const stale = path.join(target, "panel", "assets-from-an-old-build.js");
    await writeFile(stale, "// left over", "utf8");

    installPanel(source, "1.1.0", target);

    // A copy that merged rather than replaced would leave a stale chunk that
    // the new index.html does not reference but the browser may still load.
    expect(existsSync(stale)).toBe(false);
  });

  it("refuses a bundle with no panel in it, rather than installing a shell", () => {
    const empty = path.join(root, "empty");
    expect(() => installPanel(empty, "1.0.0", target)).toThrow(/incomplete|no panel/i);
    expect(existsSync(target)).toBe(false);
  });

  it("treats a corrupt stamp as unknown, so the next launch reinstalls", async () => {
    installPanel(source, "1.0.0", target);
    await writeFile(path.join(target, ".seed-installed.json"), "{not json", "utf8");
    expect(installedPanel(target)).toBeUndefined();
    expect(installPanel(source, "1.0.0", target).changed).toBe(true);
  });

  it("removes cleanly, and says whether there was anything to remove", () => {
    installPanel(source, "1.0.0", target);
    expect(removePanel(target)).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(removePanel(target)).toBe(false);
  });
});

describe("the token the artist never types", () => {
  it("is stable across launches", () => {
    const state = path.join(root, "state");
    const first = ensureToken(state);
    expect(first.length).toBeGreaterThan(20);
    // Regenerating would invalidate the token the panel already picked up, and
    // present as a panel that was connected a moment ago and now is not.
    expect(ensureToken(state)).toBe(first);
  });

  it("reaches the panel as a loadable script, encoded not interpolated", async () => {
    installPanel(source, "1.0.0", target);
    const token = ensureToken(path.join(root, "state"));
    const written = provisionPanel(target, token);

    const contents = await readFile(written, "utf8");
    expect(written).toBe(path.join(target, "panel", "seed-token.js"));
    expect(contents).toContain(`window.__SEED_TOKEN__ = ${JSON.stringify(token)};`);

    // The value is JSON-encoded rather than pasted in raw. base64url cannot
    // contain a quote today, but a value written straight into source is a
    // script injection waiting for the day the encoding changes.
    //
    // Asserting the payload is *absent* would be the wrong test — it appears
    // quite legitimately inside the string literal. The property that matters
    // is that it stays data: run the generated script and the token must come
    // back exactly as it went in, with nothing else having happened.
    const payload = 'a"; globalThis.stolen = 1; "';
    const script = await readFile(provisionPanel(target, payload), "utf8");
    const sandbox: { __SEED_TOKEN__?: string; stolen?: number } = {};
    new Function("window", "globalThis", script)(sandbox, sandbox);

    expect(sandbox.__SEED_TOKEN__).toBe(payload);
    expect(sandbox.stolen).toBeUndefined();
  });
});
