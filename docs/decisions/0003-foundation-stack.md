# ADR 0003 — Foundation stack for the local service

Status: Accepted (2026-08-08)

## Decisions

### 1. SQLite via Node's built-in `node:sqlite`

The metadata store uses `node:sqlite` (`DatabaseSync`) rather than `better-sqlite3`
or `node-sqlite3`.

Why: no native compilation. An artist installing this alongside After Effects on
Windows should not need Visual Studio Build Tools, and CI should not need a
per-platform prebuild matrix. The API is synchronous and prepared-statement
based, which is what the repositories want anyway.

Cost: `node:sqlite` is still flagged experimental (it prints an
`ExperimentalWarning` and its API may change), and it requires Node >= 22.13.
Both are acceptable for a local-first V0. All database access already sits
behind `AssetRepository` / `openMigratedDatabase`, so swapping the driver later
is a contained change.

### 2. No HTTP framework

The service uses `node:http` with a ~100-line router. It exposes a handful of
JSON endpoints on loopback; Express/Fastify would add a dependency surface (and
a supply-chain surface, since this process holds provider credentials) without
removing much work. Revisit if multipart uploads or middleware ecosystems become
load-bearing.

### 3. TypeScript sources are the package entry points

Workspace packages point `main`/`types` at `src/index.ts` and everything runs
through `tsx` (service) or Vitest (tests); `tsc` is used for typechecking only.

Why: no build step means no stale `dist/` and no cross-package build ordering
during V0. A real emit step will be needed when the panel bundles this code —
at that point the `exports` maps gain `import` conditions pointing at `dist/`.

### 4. Storage URIs are workspace-relative POSIX paths

An asset's `storageUri` is `assets/originals/frame.png`, resolved against
`<project>/.seed-ae/`. Absolute Windows paths would break project portability
and make path-traversal checks harder; a single relative form is validated in
one place (`resolveStorageUri`).

### 5. Immutability is enforced in the database, not only in code

SQLite triggers reject updates to asset identity/provenance columns and reject
deletes on `generations`. A repository bug, a future migration script, or a
manual `sqlite3` session cannot quietly rewrite lineage.

### 6. The session token is always required

There is no "auth off" development mode. If `SEED_AE_SESSION_TOKEN` is unset or
still the placeholder, the service mints a random token per process and prints
it once. `GET /health` is the only unauthenticated route (liveness only).
