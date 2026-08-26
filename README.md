# SEED / AE

A generative-production layer inside After Effects and Premiere Pro.

Not a prompt box bolted onto a video app. The host application stays the
deterministic creative operating system; Seedream and Seedance act as
renderers; a local Asset Library keeps the media, the recipe that made it, and
its lineage. Every result can be traced back to the frame it came from, reopened
as a recipe, and varied.

```
frame in your timeline
   -> Capture          registers an immutable source asset
   -> Generate         Seedream (image) or Seedance (video)
   -> Library          result, recipe, provenance, parent/child lineage
   -> Insert           back into the comp or sequence, fitted
   -> Variation        same recipe, new seed or new references
```

**Status:** Seedream and Seedance 2.0 / 2.5 are verified working against the
live BytePlus Ark API. Capture, import, insert, timeline reservation, regions
and the direction agent have all been run end to end in both After Effects and
Premiere Pro on Windows. See `docs/STATUS.md`.

---

## Requirements

- **Node.js 22.13 or newer** — the service uses the built-in `node:sqlite`.
- **After Effects 22+** or **Premiere Pro 22+**.
- **A BytePlus / Volcengine Ark account** with access to the Seedream and
  Seedance models. Without a key the panel runs but has nothing to generate
  with.
- Windows or macOS. Windows is the more heavily tested of the two.

## Install

Full cross-platform instructions, including macOS and the dev loop, are in
[`docs/INSTALL.md`](docs/INSTALL.md). The short version:

```bash
git clone https://github.com/seed-atara/seed-adobe.git
cd seed-adobe
npm install
npm run setup             # asks for your keys, writes a git-ignored .env
npm run install:extension # builds the panel and installs it for Adobe
```

`npm run setup` is the only place credentials are entered. It writes `.env` in
the project root, which is git-ignored — **no key belongs in a commit, a
screenshot, or a `.aep` file.** Nothing you type is echoed to the terminal or
sent anywhere. Re-run it any time to change a key; see `.env.example` for the
full set of settings and what each one does.

## API keys

Two places, and a key never reaches the panel or the `.aep` file from either.
Nothing else — not the database, not the generation metadata, not the logs — is
allowed to contain one.

**From the panel.** Click the gear in the title bar. Twelve settings, each with
a line saying what breaks without it; saving rebuilds the providers straight
away and tells you what came online. Stored in `~/.seed-ae/credentials.json` at
mode 0600, outside the project folder — a workspace gets zipped and handed to
other people. This is the route for anyone who is not developing SEED.

**From `.env`.** `npm run setup` asks for each key and writes a git-ignored
`.env`; editing it by hand does the same job. `.env.example` documents every
setting, including the tuning knobs the panel deliberately does not offer.

A value set in the panel **overrides** `.env`, and the panel says which of the
two each current value came from — so an edit to `.env` that appears to do
nothing has a visible reason.

| Variable | What it unlocks | Where it comes from | Needed? |
| --- | --- | --- | --- |
| `ARK_API_KEY` | All image and video generation | Ark console → **API Keys** | **Yes.** Without it no providers are registered and the panel has nothing to generate with |
| `SEED_ARK_AK` + `SEED_ARK_SK` | The asset-library reference route, and model-id discovery | Account console → **Access Keys** | Optional but recommended |
| `ANTHROPIC_API_KEY` | The **Direct** button — the direction agent that writes a prompt from a described shot | `console.anthropic.com` → API keys | Optional; the button is hidden without it |

### The two Ark credentials are not alternatives

This trips everyone up once. Ark has two separate auth systems and they are
different credentials from different console pages:

- **`ARK_API_KEY`** is a single string, sent as `Authorization: Bearer …`. It
  authenticates *inference* — the actual generating.
- **`SEED_ARK_AK` / `SEED_ARK_SK`** are an access-key pair used to HMAC-sign
  asset-library calls. They authenticate *registering a reference image* so it
  can be passed as `asset://…` rather than inlined.

An AK/SK pair cannot generate an image, and an API key cannot sign an
asset-library call. Full detail in `docs/research/MODEL_API_NOTES.md`.

Without AK/SK, references are sent inline, which works — but the asset route is
the sanctioned one when references contain recognisable real people, and the
inline path is intercepted for those. Set `ARK_REFERENCE_POLICY=asset` to fail
loudly rather than quietly fall back.

### Getting an Ark key

Ark reveals an API key **once, at creation**. It cannot be read back later — the
API returns existing keys masked — so if it was not captured at the time, mint a
new one rather than hunting for the old.

Pick the base URL that matches your account, since the CN and global routes are
separate deployments with separate keys:

```
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3   # BytePlus, global
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3         # Volcengine, CN
```

### Model ids

Model ids are per-account, and the console shows a friendly display name rather
than the id the API wants. Once the keys are in `.env`, list what your account
actually has:

```bash
npx tsx --env-file=.env scripts/ark-models.ts
npx tsx --env-file=.env scripts/ark-models.ts seedance
```

Put the results in `SEEDREAM_MODEL_ID` and `SEEDANCE_MODEL_ID` (the latter takes
a comma-separated list — each becomes its own entry in the panel, because 2.0
and 2.5 accept different things). Mind the per-model minimum output area noted
in `.env.example`: the 3.7MP Seedream models reject `1024x1024` outright.

### Session token

`SEED_AE_SESSION_TOKEN` is not a provider credential — it is a local shared
secret between the panel and the service, generated for you by `npm run setup`.
`npm run token` prints it and copies it to the clipboard for pasting into the
panel. Left unset, the service mints a fresh one per process and prints it at
startup.

### If a key leaks

Rotate it in the provider console. That is cheaper than establishing whether
anyone saw it. Since `.env` is the only copy, there is nothing else to clean up.

## Allow the unsigned extension

CEP refuses to load unsigned extensions unless `PlayerDebugMode` is set. The
installer checks and tells you if it is missing — it deliberately does not set
it for you, because it is a machine-wide "allow unsigned code" flag and that
should be your decision:

```powershell
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

macOS:

```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

Restart the Adobe application afterwards.

## Run

```bash
npm run dev     # the local service, on 127.0.0.1:47831
npm run token   # prints the session token and copies it to your clipboard
```

Then in After Effects or Premiere Pro: **Window > Extensions > SEED / AE**.
Paste the token into the panel's token field. The service must be running
whenever the panel is used — it holds the database, the credentials, and the
jobs.

To remove the extension again: `npm run uninstall:extension`.

## Using it

1. Park the playhead on the frame you want and press **Capture current frame**.
   It lands in the Library as an immutable source asset, with the comp or
   sequence, the time, and the dimensions recorded alongside it.
2. Pick references from the Library. Roles are explicit: a reference image, a
   first frame, a last frame, a reference video or audio.
3. Write a prompt — or describe the shot and press **Direct**, and the
   direction agent writes one from your description and the references in front
   of it. It refers to references by position ("Image 1"), because models do not
   resolve asset ids in prose.
4. **Generate**. Video jobs can reserve their space on the timeline first: a
   striped placeholder clip appears at the playhead, and the render replaces it
   in place when it lands, at the right scale, wherever you have since moved it.
5. **Insert at playhead**, or open any result to see its full recipe —
   provider, model, seed, parameters, references, and the frame it came from —
   and branch a variation from it.

Assets are never overwritten. A variation is a child, not a replacement.

### Regions

For work on a large plate: select a region of the composition, and SEED builds
a sub-composition for it, generates into it, and soft-mattes the result back
into the plate with scale and position you can keep animating. Useful for a 2K
by 6K strip where the shot you actually want is a 1K square inside it.

## Development

```bash
npm test          # 205 tests, no Adobe application required
npm run typecheck # service, panel, packages
npm run build
```

The panel also runs in a browser against a mock host, which is the fastest way
to work on UI:

```bash
cd apps/panel && npm run dev    # http://localhost:47830
```

Everything that is not host-specific is testable outside Adobe — that is a
design rule, not an accident. Host-specific logic lives behind `AeHostAdapter`
and nothing else depends on ExtendScript globals.

### Layout

| Path | Contents |
| --- | --- |
| `apps/service` | Local HTTP service — assets, jobs, providers, credentials |
| `apps/panel` | Panel UI — Generate / Library / Lineage (React + Vite) |
| `apps/extension` | CEP extension: manifest + ExtendScript hosts for AE and Premiere |
| `packages/domain` | Shared schemas, wire contracts, error codes |
| `packages/storage` | SQLite, migrations, repositories, workspace layout |
| `packages/ae-host` | `AeHostAdapter` contract + mock implementation |
| `packages/providers` | Provider contract, Seedream, Seedance |
| `packages/media` | Dependency-free PNG codec, resize, MP4 probing |

### Docs

- `docs/STATUS.md` — what works today, verified against live APIs
- `docs/architecture/OVERVIEW.md` — how the pieces fit
- `docs/research/MODEL_API_NOTES.md` — what the Ark API actually accepts, and
  how that was measured rather than assumed
- `docs/research/ADOBE_INTEGRATION_NOTES.md` — CEP and ExtendScript findings,
  including the ones that cost a day
- `docs/decisions/` — architectural decisions
- `docs/roadmap/FUTURE_FEATURES.md` — what is next
- `apps/service/README.md` — HTTP API reference

## Security

Where the keys go and how to rotate them is under [API keys](#api-keys). The
shape that keeps them there:

- The panel never talks to a model provider directly. It calls the local
  service, which is the only process holding a key.
- Credentials live in `.env` only — never in SQLite, logs, generation metadata,
  Adobe projects, or git.
- The service binds to `127.0.0.1` and requires a session token.
- Authorization headers are redacted in logs.
