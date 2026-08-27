/**
 * One session token, generated once and handed to both halves.
 *
 * The token is what stops a stray page on localhost driving After Effects. In
 * development it is printed to a terminal and pasted into the panel by hand,
 * which is fine for the person who wrote it and unacceptable for anyone else.
 *
 * Here the companion owns it: it generates a token, starts the service with
 * it, and writes it beside the installed panel as a one-line script the panel
 * loads. The artist never sees it, and the security property is unchanged —
 * the token is still a per-machine secret sitting in a per-user folder, not
 * something guessable.
 *
 * A script tag rather than a data file, deliberately. ExtendScript's `File`
 * caches the filesystem, and CEP's `file://` fetch is unreliable; a script tag
 * is the one mechanism with neither caveat.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Loaded by apps/panel/index.html; absent in a dev build. */
export const TOKEN_SCRIPT = "seed-token.js";

/**
 * Reads the stored token, or makes one.
 *
 * Stable across launches: regenerating on every start would invalidate a token
 * the panel had already picked up, and present as a panel that was connected a
 * moment ago and now is not.
 */
export function ensureToken(stateDir: string): string {
  const file = path.join(stateDir, "session-token");
  if (existsSync(file)) {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  }

  const token = randomBytes(24).toString("base64url");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows ACLs are not POSIX bits; the per-user folder is the boundary.
  }
  return token;
}

/**
 * Writes the token into the installed panel folder.
 *
 * JSON-encoded rather than interpolated raw: the token is base64url and cannot
 * contain a quote today, but a value written straight into source is a script
 * injection waiting for the day the encoding changes.
 */
export function provisionPanel(panelDir: string, token: string): string {
  const file = path.join(panelDir, "panel", TOKEN_SCRIPT);
  writeFileSync(
    file,
    "/* Written by the SEED companion. Not checked in, not a secret to share. */\n" +
      `window.__SEED_TOKEN__ = ${JSON.stringify(token)};\n`,
    { mode: 0o600 },
  );
  return file;
}
