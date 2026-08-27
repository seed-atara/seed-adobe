/**
 * Where generated media and the catalogue live.
 *
 * Defaults inside the app's own data folder, which is right for a first run —
 * an artist should be able to install and generate without first answering a
 * question about disk layout.
 *
 * It cannot *stay* there, though. Generated clips are project media: they
 * belong on the drive the job lives on, alongside the plates, backed up by
 * whatever backs that drive up. Burying them in Application Support means the
 * one folder nobody thinks to copy when the job moves.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FILE = "workspace.json";

/** The default, and the marker that the artist has not chosen one. */
export function defaultWorkspace(stateDir: string): string {
  return path.join(stateDir, "workspace");
}

export function readWorkspace(stateDir: string): string {
  const file = path.join(stateDir, FILE);
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const chosen = (parsed as { path?: unknown })?.path;
      // A folder that has been unplugged or renamed falls back rather than
      // failing to start: a missing external drive should cost the artist
      // their recent library, not the whole application.
      if (typeof chosen === "string" && chosen.trim() && existsSync(chosen)) {
        return chosen;
      }
    } catch {
      // Unreadable means unchosen.
    }
  }
  return defaultWorkspace(stateDir);
}

export function writeWorkspace(stateDir: string, chosen: string): string {
  const resolved = path.resolve(chosen);
  mkdirSync(resolved, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, FILE),
    `${JSON.stringify({ path: resolved }, null, 2)}
`,
    "utf8",
  );
  return resolved;
}

/** True when the artist has not moved it off the default. */
export function isDefaultWorkspace(stateDir: string, current: string): boolean {
  return path.resolve(current) === path.resolve(defaultWorkspace(stateDir));
}
