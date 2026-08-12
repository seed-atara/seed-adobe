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

### Allow the unsigned extension

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

- Credentials live in `.env` only. Never in SQLite, logs, generation metadata,
  Adobe projects, or git.
- The panel never talks to a model provider directly. It calls the local
  service, which holds the keys.
- The service binds to `127.0.0.1` and requires a session token.
- Authorization headers are redacted in logs.

If a key is ever pasted somewhere it should not be, rotate it. That is cheaper
than being sure it was not seen.
