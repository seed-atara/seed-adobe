/**
 * Installing the native After Effects plugins.
 *
 * These are real `.aex` effects — SEED Film Look and SEED Frequency Detailer —
 * and they are the one part of SEED that cannot be installed the way everything
 * else is. Adobe's shared plugin folder lives under Program Files, so writing
 * there needs administrator rights, and the companion is deliberately a
 * per-user install that never asks for a password. So this is a button the
 * artist presses, once, and answers one UAC prompt for.
 *
 * Windows only, and not for a shortage of will: the plugins are built by `.cmd`
 * scripts against the Windows SDK and there is no Xcode project. A macOS build
 * is a real piece of work, not a packaging step.
 *
 * Two things are copied from each plugin's own `install.cmd`, which learned
 * them the hard way (the glob is spelled out rather than written as a path,
 * because a star followed by a slash ends this comment):
 *
 *   - **MediaCore only.** After Effects reads it, Premiere reads it, and it is
 *     the shared location. Installing to AE's own Effects folder as well is not
 *     redundancy, it is a duplicate — and After Effects says so at every launch:
 *     "There is a duplicated effect plugin installed on your drive."
 *   - **Remove the duplicate.** An earlier version of that script did install to
 *     both, so a machine may still carry one. Clearing it is part of installing.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The shared plugin folder both applications read. */
export const MEDIA_CORE = "C:\\Program Files\\Adobe\\Common\\Plug-ins\\7.0\\MediaCore";

export interface EffectFile {
  /** Name as it must appear in MediaCore. */
  name: string;
  /** Where it is inside this application bundle. */
  source: string;
}

export type EffectsState = "unsupported" | "unavailable" | "installed" | "not-installed";

/**
 * What the window should say.
 *
 * `unavailable` is distinct from `not-installed` on purpose: one is "press the
 * button", the other is "this build does not carry them", and telling an artist
 * to press a button that cannot work is worse than saying nothing.
 */
export function effectsState(files: EffectFile[]): EffectsState {
  if (process.platform !== "win32") return "unsupported";
  if (files.length === 0 || !files.every((file) => existsSync(file.source))) {
    return "unavailable";
  }
  if (!existsSync(MEDIA_CORE)) return "unavailable";
  return files.every((file) => existsSync(path.join(MEDIA_CORE, file.name)))
    ? "installed"
    : "not-installed";
}

/**
 * After Effects' own Effects folders, across whichever versions are installed.
 *
 * Discovered rather than hardcoded to a year: `install.cmd` names 2026, and a
 * machine with 2025 still on it would keep its duplicate forever.
 */
export function duplicateFolders(): string[] {
  const adobe = "C:\\Program Files\\Adobe";
  if (!existsSync(adobe)) return [];
  try {
    return readdirSync(adobe)
      .filter((entry) => /^Adobe After Effects/i.test(entry))
      .map((entry) => path.join(adobe, entry, "Support Files", "Plug-ins", "Effects"))
      .filter((folder) => existsSync(folder));
  } catch {
    return [];
  }
}

/**
 * Copies the effects into MediaCore, with one elevation prompt.
 *
 * PowerShell rather than a bundled elevate helper: `Start-Process -Verb RunAs`
 * is the documented way to ask for elevation, and the script it runs is written
 * out rather than passed as a command string so a path with spaces — which
 * every one of these has — cannot be re-parsed into arguments.
 */
export async function installEffects(
  files: EffectFile[],
  stateDir: string,
): Promise<{ ok: boolean; message: string }> {
  const state = effectsState(files);
  if (state === "unsupported") {
    return { ok: false, message: "The native effects are Windows-only." };
  }
  if (state === "unavailable") {
    return existsSync(MEDIA_CORE)
      ? { ok: false, message: "This build does not carry the effects." }
      : {
          ok: false,
          message:
            "No Adobe MediaCore folder on this machine — install After Effects or Premiere first.",
        };
  }

  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$dest = ${quote(MEDIA_CORE)}`,
    ...files.map(
      (file) => `Copy-Item -LiteralPath ${quote(file.source)} -Destination (Join-Path $dest ${quote(file.name)}) -Force`,
    ),
    // The duplicate removal is best effort: failing to delete somebody else's
    // stale copy must not fail an install that has already succeeded.
    ...duplicateFolders().flatMap((folder) =>
      files.map(
        (file) =>
          `Remove-Item -LiteralPath (Join-Path ${quote(folder)} ${quote(file.name)}) -Force -ErrorAction SilentlyContinue`,
      ),
    ),
  ];

  const script = path.join(stateDir, "install-effects.ps1");
  writeFileSync(script, `${lines.join("\n")}\n`, "utf8");

  try {
    await run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
          `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${quote(script)}; ` +
          `exit $p.ExitCode`,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
  } catch {
    // The overwhelmingly likely cause is the person choosing No on the UAC
    // prompt, which is a decision rather than a fault.
    return {
      ok: false,
      message:
        "The effects were not installed — administrator permission is needed to write to Adobe's shared plugin folder.",
    };
  }

  return effectsState(files) === "installed"
    ? {
        ok: true,
        message: "Installed. Restart After Effects, then look under Effect > SEED.",
      }
    : { ok: false, message: "The copy reported success but the files are not there." };
}

/** PowerShell single-quoted literal: the only escape inside one is a doubled quote. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
