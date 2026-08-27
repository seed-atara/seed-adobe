/**
 * Putting the panel where After Effects will find it.
 *
 * This is the same job `scripts/install-extension.mjs` does for a developer,
 * moved inside the shipped app so an artist never opens a terminal. The
 * difference is that the source is no longer the repo — it is the copy of the
 * panel that travelled inside this application bundle.
 *
 * Idempotent on purpose. It runs on every launch, not just the first: an
 * update to the companion carries a new panel with it, and the alternative
 * (install once, then diverge silently) is exactly the "my fix isn't showing"
 * failure this project already knows well.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Must match the folder name the manifest and the uninstaller both use. */
export const BUNDLE_ID = "ai.seedstudios.seedae";

/**
 * Where Adobe looks for user-installed extensions.
 *
 * Both paths are Adobe's published per-user locations. We never write to the
 * machine-wide ones: those need elevation, and an installer that asks an
 * artist for an admin password to place an HTML folder has failed a smell test.
 */
export function cepExtensionsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "win32") {
    // Taken as an argument rather than read from ambient state so the Windows
    // path can be asked for from anywhere. CI found this the hard way: a test
    // calling cepExtensionsDir("win32") on a macOS runner threw, because
    // APPDATA only exists on Windows. A function whose Windows branch cannot
    // be exercised on a Mac is a function nobody will check on a Mac.
    const appData = env.APPDATA;
    if (!appData) throw new Error("APPDATA is not set, so the CEP folder cannot be located");
    return path.join(appData, "Adobe", "CEP", "extensions");
  }
  // macOS. Linux has no After Effects, so anything else is a configuration
  // error rather than a platform to support.
  const home = env.HOME || os.homedir();
  return path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
}

export function panelTargetDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(cepExtensionsDir(platform, env), BUNDLE_ID);
}

/** A marker so we can tell which build of the panel is currently installed. */
const STAMP = ".seed-installed.json";

export interface InstalledPanel {
  version: string;
  installedAt: string;
}

export function installedPanel(target = panelTargetDir()): InstalledPanel | undefined {
  const stamp = path.join(target, STAMP);
  if (!existsSync(stamp)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(stamp, "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as InstalledPanel).version === "string") {
      return parsed as InstalledPanel;
    }
  } catch {
    // A corrupt stamp means "unknown", which reinstalls. That is the safe way
    // round: reinstalling a current panel costs a folder copy.
  }
  return undefined;
}

export interface InstallResult {
  target: string;
  changed: boolean;
  previousVersion?: string;
}

/**
 * Copies the bundled panel into place, replacing whatever is there.
 *
 * `dereference` so a symlinked development build cannot leave After Effects
 * reading files outside the extensions folder — the same reason the developer
 * script does it.
 */
export function installPanel(
  source: string,
  version: string,
  target = panelTargetDir(),
): InstallResult {
  if (!existsSync(path.join(source, "panel", "index.html"))) {
    throw new Error(`the bundled panel is incomplete: no panel/index.html under ${source}`);
  }

  const previous = installedPanel(target);
  if (previous?.version === version) {
    return { target, changed: false, previousVersion: previous.version };
  }

  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });

  writeFileSync(
    path.join(target, STAMP),
    `${JSON.stringify({ version, installedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  return {
    target,
    changed: true,
    ...(previous ? { previousVersion: previous.version } : {}),
  };
}

export function removePanel(target = panelTargetDir()): boolean {
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
