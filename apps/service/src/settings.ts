/**
 * Credentials an artist can set from the panel, and where they are kept.
 *
 * The service has always read its keys from `.env`. That is right for a
 * developer and wrong for everyone else: it means a teammate cannot use SEED
 * without a text editor, a terminal, and knowing which of forty variables
 * matter. This module adds a second source — a file the panel writes — and
 * keeps the two visibly apart rather than merging them into an unexplained
 * blob.
 *
 * Precedence is **panel over `.env`**, and every read reports which one won.
 * The alternative (`.env` wins) makes a key typed into the UI silently do
 * nothing, which is the worse failure: the artist has no way to see the file
 * that is overriding them. Reporting the source means a developer who edits
 * `.env` and sees no change is told why, in the same place they typed.
 *
 * Where it lives: `~/.seed-ae/credentials.json`, deliberately NOT under the
 * workspace. The workspace is a project folder — it gets zipped, moved to a
 * shared drive, and handed to other people. `CLAUDE.md` forbids secrets in
 * SQLite, logs, `.aep` files and git; a project folder belongs on that list
 * for exactly the same reason.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

/** How a setting is presented, and whether its value may ever be echoed. */
export interface SettingDefinition {
  key: string;
  label: string;
  /** One line: what breaks without it. */
  help: string;
  /** Grouping for the panel, in display order. */
  group: "Generating" | "References" | "Direction" | "Hosting" | "Premiere";
  /**
   * A secret is never sent to the client — only whether it is set, and a hint.
   * A model id or a base URL is not a secret and is far easier to correct when
   * you can see it.
   */
  secret: boolean;
  /** Shown as the field's placeholder when nothing is set. */
  placeholder?: string;
  /**
   * A file on disk rather than a value to type.
   *
   * The panel offers a picker for these through the host's own file dialog —
   * nobody should be transcribing a path to a preset by hand, and on an
   * installed copy there is no `.env` to paste one into either.
   */
  kind?: "path";
  /** Host file-dialog filter, in Adobe's "Label:*.ext" form. */
  filter?: string;
}

/**
 * The settable set, chosen as "what a fresh install needs before it can do
 * anything", not "every variable the service reads". The long tail in
 * `.env.example` stays there: tuning knobs belong in a file, and putting forty
 * fields in a panel is how the four that matter get lost.
 */
export const SETTINGS: readonly SettingDefinition[] = [
  {
    key: "ARK_API_KEY",
    label: "Ark API key",
    help: "Volcengine / BytePlus inference. Without it nothing generates at all.",
    group: "Generating",
    secret: true,
    placeholder: "from the Ark console, API Key page",
  },
  {
    key: "ARK_BASE_URL",
    label: "Ark region",
    help: "Which Ark route to call. The global/SEA host and the CN host hold different accounts.",
    group: "Generating",
    secret: false,
    placeholder: "https://ark.ap-southeast.bytepluses.com/api/v3",
  },
  {
    key: "SEEDREAM_MODEL_ID",
    label: "Seedream model",
    help: "The image model id this account has. Never hard-coded — accounts differ.",
    group: "Generating",
    secret: false,
    placeholder: "seedream-4-0-250828",
  },
  {
    key: "SEEDANCE_MODEL_ID",
    label: "Seedance models",
    help: "Video model ids, comma-separated, in panel order.",
    group: "Generating",
    secret: false,
    placeholder: "dreamina-seedance-2-5-260628",
  },
  {
    key: "SEEDANCE_OUTPUT_FORMAT",
    label: "Video container",
    help: "mov is 4:4:4 and the better master — the panel previews it from a proxy. mp4 is 4:2:0. Same resolution, same price; leave it on mov.",
    group: "Generating",
    secret: false,
    placeholder: "mov",
  },
  {
    key: "SEED_ARK_AK",
    label: "Ark access key id",
    help: "Account-level key for the asset library. Separate from the API key, and optional.",
    group: "References",
    secret: true,
  },
  {
    key: "SEED_ARK_SK",
    label: "Ark secret access key",
    help: "The other half of the pair above.",
    group: "References",
    secret: true,
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Anthropic API key",
    help: "Powers the direction agent. Without it the Direct button is hidden, and nothing else changes.",
    group: "Direction",
    secret: true,
  },
  {
    key: "FAL_KEY",
    label: "fal key",
    help: "IC-Light relighting. Optional; without it the relighter is not offered.",
    group: "Direction",
    secret: true,
  },
  {
    key: "SEED_PPRO_STILL_PRESET",
    label: "Premiere still preset",
    help: "A PNG preset exported from Premiere's Export Settings. Without it frame capture falls back to an undocumented exporter that some builds refuse.",
    group: "Premiere",
    secret: false,
    kind: "path",
    filter: "Premiere preset:*.epr,All files:*.*",
  },
  {
    key: "SEED_PPRO_VIDEO_PRESET",
    label: "Premiere clip preset",
    help: "Required for capturing a range as a clip — without it the button is hidden. Must stay in a codec Ark accepts: a ProRes reference is a refused one.",
    group: "Premiere",
    secret: false,
    kind: "path",
    filter: "Premiere preset:*.epr,All files:*.*",
  },
  {
    key: "SEED_PPRO_QUALITY_PRESET",
    label: "Premiere archival preset",
    help: "Optional. A ProRes preset for clips that stay local. Deliberately separate from the one above, which must remain sendable.",
    group: "Premiere",
    secret: false,
    kind: "path",
    filter: "Premiere preset:*.epr,All files:*.*",
  },
  {
    key: "SEED_R2_ENDPOINT",
    label: "R2 endpoint",
    help: "Video references must be fetchable by URL — Ark refuses an inline clip.",
    group: "Hosting",
    secret: false,
  },
  {
    key: "SEED_R2_BUCKET",
    label: "R2 bucket",
    help: "Stays private; clips are handed over as short-lived presigned links.",
    group: "Hosting",
    secret: false,
  },
  {
    key: "SEED_R2_ACCESS_KEY_ID",
    label: "R2 access key id",
    help: "R2 > Manage R2 API Tokens > Create API Token, Object Read & Write.",
    group: "Hosting",
    secret: true,
  },
  {
    key: "SEED_R2_SECRET_ACCESS_KEY",
    label: "R2 secret access key",
    help: "Shown once by Cloudflare. Signed with SigV4, so this is the S3 secret, not the Cloudflare API token.",
    group: "Hosting",
    secret: true,
  },
] as const;

const SETTABLE = new Set(SETTINGS.map((s) => s.key));

/** Where each effective value came from, so the panel can say so. */
export type SettingSource = "panel" | "env" | "unset";

export interface SettingState {
  key: string;
  label: string;
  help: string;
  group: SettingDefinition["group"];
  secret: boolean;
  placeholder?: string;
  kind?: "path";
  filter?: string;
  source: SettingSource;
  /**
   * For a secret, the last four characters and nothing else — enough to tell
   * two keys apart, useless to anyone reading a screen over a shoulder. For a
   * non-secret, the actual value.
   */
  hint?: string;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SEED_AE_CREDENTIALS?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".seed-ae", "credentials.json");
}

/**
 * Reads the panel-set values. A missing or unreadable file is not an error —
 * it is the normal state of a machine that has only ever used `.env`.
 */
export function readCredentials(
  file: string = credentialsPath(),
): Record<string, string> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Only keys we advertise. A file that has picked up something else does
      // not get to inject arbitrary environment into the service.
      if (SETTABLE.has(key) && typeof value === "string" && value.trim()) {
        out[key] = value.trim();
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merges a patch and writes it back. A key mapped to `null` or `""` is
 * removed, which is how the panel clears one — distinct from "not mentioned",
 * which leaves it alone.
 *
 * Written to a temporary file and renamed, so an interrupted write cannot
 * leave a half-parsed file where the credentials used to be.
 */
export function writeCredentials(
  patch: Record<string, string | null | undefined>,
  file: string = credentialsPath(),
): Record<string, string> {
  const next = { ...readCredentials(file) };
  for (const [key, value] of Object.entries(patch)) {
    if (!SETTABLE.has(key)) continue;
    // `undefined` is "not mentioned" and leaves the key alone. `null` or an
    // empty string is "clear this". A partial record from the route hands us
    // both, and collapsing them would make an untouched field delete a key.
    if (value === undefined) continue;
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed) delete next[key];
    else next[key] = trimmed;
  }

  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  // Belt and braces: `mode` on write only applies when the file is created, so
  // an existing file keeps whatever it had. On Windows this is close to a
  // no-op — NTFS ACLs are not POSIX bits — which is why the file lives in the
  // user profile rather than relying on the mode alone.
  try {
    chmodSync(file, 0o600);
  } catch {
    // Non-fatal: an unsupported filesystem should not fail the save.
  }
  return next;
}

/**
 * The environment the service should actually run with: the process
 * environment (which `.env` has already been folded into) with panel values
 * layered on top.
 */
export function effectiveEnv(
  env: NodeJS.ProcessEnv = process.env,
  stored: Record<string, string> = readCredentials(credentialsPath(env)),
): NodeJS.ProcessEnv {
  return { ...env, ...stored };
}

/** Last four characters, for telling two keys apart without revealing either. */
function hintFor(value: string): string {
  return value.length <= 4 ? "****" : `…${value.slice(-4)}`;
}

/**
 * What the panel renders. Deliberately built from the definitions rather than
 * from whatever happens to be set, so a key you have never configured still
 * appears, with its help text, instead of being invisible until it exists.
 */
export function describeSettings(
  env: NodeJS.ProcessEnv = process.env,
  stored: Record<string, string> = readCredentials(credentialsPath(env)),
): SettingState[] {
  return SETTINGS.map((definition) => {
    const fromPanel = stored[definition.key]?.trim();
    const fromEnv = env[definition.key]?.trim();
    const value = fromPanel || fromEnv;
    const source: SettingSource = fromPanel ? "panel" : fromEnv ? "env" : "unset";

    return {
      key: definition.key,
      label: definition.label,
      help: definition.help,
      group: definition.group,
      secret: definition.secret,
      ...(definition.placeholder ? { placeholder: definition.placeholder } : {}),
      ...(definition.kind ? { kind: definition.kind } : {}),
      ...(definition.filter ? { filter: definition.filter } : {}),
      source,
      ...(value
        ? { hint: definition.secret ? hintFor(value) : value }
        : {}),
    };
  });
}
