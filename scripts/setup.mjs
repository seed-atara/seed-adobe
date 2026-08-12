#!/usr/bin/env node
/**
 * Writes a local `.env` by asking for what it needs.
 *
 * Credentials are the one part of setup that cannot be checked in, so they have
 * to be collected. Asking is better than leaving someone to copy
 * `.env.example` and work out which of twenty settings actually matter — most
 * do not, and the ones that do are not obvious.
 *
 * Nothing here is sent anywhere: the answers are written to `.env`, which is
 * git-ignored, and the file is created readable only by its owner where the
 * platform allows it.
 *
 *   npm run setup
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, ".env");

/*
 * One readline, writing through a gate we can shut.
 *
 * Muting the *output* rather than switching stdin to raw mode keeps a single
 * reader on stdin — two of them race, and the loser is the echo suppression,
 * which is the one thing here that must not fail. It also leaves line editing
 * intact, which matters when what is being typed is fifty characters of key.
 */
const gate = new Writable({
  write(chunk, _encoding, done) {
    if (!gate.muted) process.stdout.write(chunk);
    done();
  },
});
gate.muted = false;

const rl = createInterface({
  input: process.stdin,
  output: gate,
  terminal: process.stdin.isTTY === true,
});
rl.on("SIGINT", () => process.exit(130));

/** Asks a question, offering a default that Enter accepts. */
function ask(question, fallback = "") {
  const shown = fallback ? ` [${fallback}]` : "";
  return new Promise((resolve) =>
    rl.question(`${question}${shown}: `, (answer) =>
      resolve(answer.trim() || fallback),
    ),
  );
}

/**
 * Asks for a secret without echoing it.
 *
 * A key typed into a terminal stays in the scrollback, and scrollback ends up
 * in screenshots and screen shares.
 */
function askSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    gate.muted = true;
    rl.question("", (answer) => {
      gate.muted = false;
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

console.log(`
SEED / AE setup
---------------
This writes a .env in the project root. It is git-ignored, and nothing you type
is sent anywhere. Press Enter to accept a default, or leave a key blank to skip
the feature that needs it.
`);

if (existsSync(target)) {
  const overwrite = await ask("A .env already exists. Overwrite it? (y/N)", "n");
  if (overwrite.toLowerCase() !== "y") {
    console.log("Left it alone.");
    rl.close();
    process.exit(0);
  }
}

const workspace = await ask(
  "Project folder for captures and results (where .seed-ae will live)",
  process.cwd(),
);

console.log(`
Volcengine / BytePlus Ark — image and video generation.
  ARK_API_KEY is the Bearer key for inference. Without it no providers are
  registered at all, and the panel has nothing to generate with.`);
const arkApiKey = await askSecret("ARK_API_KEY");

console.log(`
  The AK/SK pair is a separate credential, for the asset library. Optional:
  without it references are sent inline, which works, but the asset route is
  the right one when references contain recognisable real people.`);
const arkAk = await askSecret("SEED_ARK_AK (optional)");
const arkSk = arkAk ? await askSecret("SEED_ARK_SK") : "";

console.log(`
Anthropic — the direction agent, which turns a described shot into a prompt.
  Optional: without it the panel simply does not offer the Direct button.`);
const anthropic = await askSecret("ANTHROPIC_API_KEY (optional)");

console.log(`
Model ids. These are account-specific, so the defaults may not exist on yours.
List what you actually have with:
  npx tsx --env-file=.env scripts/ark-models.ts`);
const seedream = await ask("SEEDREAM_MODEL_ID", "seedream-4-0-250828");
const seedance = await ask(
  "SEEDANCE_MODEL_ID (comma-separated for several)",
  "dreamina-seedance-2-5-260628,dreamina-seedance-2-0-260128",
);

const token = randomBytes(16).toString("base64url");

const env = `# Written by \`npm run setup\`. Git-ignored — keep it that way.

SEED_AE_HOST=127.0.0.1
SEED_AE_PORT=47831

# Shared secret between the panel and the service. Generated locally.
SEED_AE_SESSION_TOKEN=seed-${token}

# Folder that will contain .seed-ae/ — the database, media and thumbnails.
SEED_AE_WORKSPACE=${workspace}

# --- Volcengine / BytePlus Ark ----------------------------------------------
ARK_API_KEY=${arkApiKey}
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
SEED_ARK_AK=${arkAk}
SEED_ARK_SK=${arkSk}
ARK_OPENAPI_HOST=open.byteplusapi.com
ARK_REGION=ap-southeast-1
ARK_ASSET_GROUP=seed-ae
ARK_REFERENCE_POLICY=asset-or-inline
ARK_SKIP_MODERATION=false

SEEDREAM_MODEL_ID=${seedream}
SEEDANCE_MODEL_ID=${seedance}

# --- Direction agent --------------------------------------------------------
ANTHROPIC_API_KEY=${anthropic}
SEED_AE_DIRECTOR_MODEL=claude-opus-5
SEED_AE_DIRECTOR_EFFORT=low
SEED_AE_DIRECTOR_FAST=false

# --- Optional ---------------------------------------------------------------
# A PNG still preset (.epr) exported from Premiere's Export Settings dialog.
# Presets are per-install, so none can be shipped.
SEED_PPRO_STILL_PRESET=

# Offers the mock providers alongside the real ones. Off unless exactly "true".
SEED_AE_MOCK_PROVIDERS=false

# See .env.example for the settings this script does not ask about
# (SEEDANCE_SIZES, SEEDANCE_MAX_REFERENCES, ARK_* routing) — all of which have
# working defaults.
`;

writeFileSync(target, env, { mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows ignores POSIX modes; the file is git-ignored either way.
}

console.log(`
Wrote ${target}

Next:
  npm run install:extension     put the panel where Adobe looks for it
  npm run dev                   start the service
  npm run token                 copy the session token for the panel

Then open the panel in After Effects or Premiere Pro:
  Window > Extensions > SEED / AE
`);

if (!arkApiKey) {
  console.log(
    "No ARK_API_KEY, so no providers will be registered — the panel will\n" +
      "connect but have nothing to generate with. Re-run this to add one.\n",
  );
}

rl.close();
