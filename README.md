# SEED / AE Starter

A development scaffold for a generative-production layer inside Adobe After Effects.

## Core idea

- After Effects = creative operating system
- Seedream / Seedance = generative renderers
- Asset Library = project memory and provenance

The first reliable vertical slice is current AE frame capture -> local asset registration -> Seedream generation -> result registration -> AE import.

Seedance 2.5 is the intended hero video model for the ByteDance demonstration, but its adapter must remain behind an abstraction until its exact official API contract/access is available.

## Status

The V1 loop works end to end against mock providers:

```
AE frame -> Capture -> Asset Library -> generate -> result registered
         -> lineage -> reopen recipe -> variation -> import / insert at playhead
```

**Seedream is verified working against the live BytePlus Ark API** — the loop
above has been run end to end on real generations. The panel ships as a CEP
extension that docks inside After Effects. Seedance stays inert until its
request contract is verified. See `docs/STATUS.md`.

## Quick start

Requires Node >= 22.13 (the service uses the built-in `node:sqlite`).

```bash
npm install
npm test          # 148 tests, no Adobe application needed
npm run typecheck
npm run dev       # local service; prints a session token
```

Then either dock it in After Effects:

```bash
npm run install:extension
# restart AE, then Window > Extensions > SEED / AE
```

or run it in a browser against the mock AE host:

```bash
cd apps/panel && npm run dev    # http://localhost:47830
```

Get the session token onto your clipboard with:

```bash
npm run token
```

Paste it into the panel, press **Capture current frame**, write a prompt, and
press **Generate**.

To verify the whole loop headlessly against a running service:

```bash
npx tsx apps/panel/test/loop.e2e.ts http://127.0.0.1:47831 <token>
```

The service creates `<workspace>/.seed-ae/` for its SQLite database and media.
API reference: `apps/service/README.md`.

## Layout

| Path | Contents |
| --- | --- |
| `apps/service` | Local HTTP service — assets, jobs, providers, credentials |
| `apps/panel` | Panel UI — Generate / Library / Lineage (React + Vite, Win95) |
| `apps/extension` | CEP extension: manifest + ExtendScript host for AE |
| `packages/domain` | Shared schemas, wire contracts, error codes |
| `packages/storage` | SQLite, migrations, repositories, workspace layout |
| `packages/ae-host` | `AeHostAdapter` contract + mock implementation |
| `packages/providers` | Provider contract, mocks, Seedream, Seedance (inert) |
| `packages/media` | Dependency-free PNG codec and resize |

## Start here

1. Read `CLAUDE.md`.
2. Read `docs/architecture/OVERVIEW.md`.
3. Read `docs/research/MODEL_API_NOTES.md`.
4. Follow `docs/roadmap/V0_PLAN.md`.
5. Use `SYSTEM_PROMPT.md` to start a coding agent.
