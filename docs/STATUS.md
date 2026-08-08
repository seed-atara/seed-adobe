# Status

Last updated: 2026-08-08

## Current milestone

Milestone 0 — host-bridge proof. **Service side complete; panel side not started.**

## What exists

### Working code

- npm workspaces monorepo, TypeScript strict, Vitest. `npm test` (48 tests) and
  `npm run typecheck` are green.
- `@seed-ae/domain` — Zod schemas for Asset, AeContext, Generation, the HTTP
  wire contracts, normalized `SeedError` codes, prefixed ids, ISO timestamps.
- `@seed-ae/storage` — `node:sqlite` database, versioned migrations,
  `AssetRepository`, `.seed-ae/` workspace layout, storage-URI validation.
- `@seed-ae/ae-host` — `AeHostAdapter` contract and `MockAeHostAdapter` that
  renders a genuine PNG (minimal encoder, no dependencies).
- `@seed-ae/service` — loopback HTTP service with bearer-token auth,
  correlation ids, redacting logger, and the routes listed in
  `apps/service/README.md`.

### Verified end-to-end

`GET /v1/ae/context` → `POST /v1/ae/capture-frame` → asset registered with full
AE provenance → `GET /v1/assets` → `GET /v1/assets/:id/file` returns the PNG
bytes. Exercised both in tests and against a running process using a workspace
path containing spaces (`.../Client Work/Project 01/`).

### Specs

- architecture/spec scaffold
- provider abstraction direction
- Seedream API research notes
- Seedance 2.5 integration intentionally unimplemented pending verified official contract
- ByteDance demo narrative

## Known gaps in what was built

- No thumbnail generation yet — `thumbnailUri` is stored but never populated.
- `GenerationRepository` does not exist; the `generations` table and schema do.
  Assets can reference a generation, nothing writes one yet.
- Media dimensions come from the host adapter, not from probing the file.
- No panel. Nothing renders any of this to a human.

## Next engineering actions

1. Verify the current official Adobe AE extension path (CEP vs UXP) and record
   the finding in `docs/research/ADOBE_INTEGRATION_NOTES.md`. **Blocking for a
   real host adapter — do not scaffold a panel before this is answered.**
2. Panel bootstrap: `/health` call, AE context display, Capture button, asset
   grid backed by `GET /v1/assets`.
3. Thumbnail generation on registration (Milestone 1).
4. `GenerationRepository` + lineage reads (prerequisite for Milestone 2).
5. Seedream adapter behind the provider interface, with `InputMaterializer` for
   getting local frames into a provider-accepted representation.
