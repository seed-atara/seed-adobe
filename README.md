# SEED / AE Starter

A development scaffold for a generative-production layer inside Adobe After Effects.

## Core idea

- After Effects = creative operating system
- Seedream / Seedance = generative renderers
- Asset Library = project memory and provenance

The first reliable vertical slice is current AE frame capture -> local asset registration -> Seedream generation -> result registration -> AE import.

Seedance 2.5 is the intended hero video model for the ByteDance demonstration, but its adapter must remain behind an abstraction until its exact official API contract/access is available.

## Status

The local service half of Milestone 0 works: capture the current AE frame,
register it as an immutable asset with its provenance, list and serve it back.
There is no panel yet, and the AE host is still `MockAeHostAdapter`. See
`docs/STATUS.md`.

## Quick start

Requires Node >= 22.13 (the service uses the built-in `node:sqlite`).

```bash
npm install
npm test          # 48 tests, no Adobe application needed
npm run typecheck
npm run dev       # starts the local service and prints a session token
```

The service creates `<workspace>/.seed-ae/` for its SQLite database and media.
API reference: `apps/service/README.md`.

## Layout

| Path | Contents |
| --- | --- |
| `apps/service` | Local HTTP service — assets, jobs, providers, credentials |
| `apps/panel` | After Effects panel UI (not started) |
| `packages/domain` | Shared schemas, wire contracts, error codes |
| `packages/storage` | SQLite, migrations, repositories, workspace layout |
| `packages/ae-host` | `AeHostAdapter` contract + mock implementation |
| `packages/providers` | Seedream / Seedance adapters (not started) |
| `packages/ui` | Shared panel components (not started) |

## Start here

1. Read `CLAUDE.md`.
2. Read `docs/architecture/OVERVIEW.md`.
3. Read `docs/research/MODEL_API_NOTES.md`.
4. Follow `docs/roadmap/V0_PLAN.md`.
5. Use `SYSTEM_PROMPT.md` to start a coding agent.
