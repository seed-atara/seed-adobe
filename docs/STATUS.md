# Status

Last updated: 2026-08-09

## Current milestone

Milestones 0–3 complete against mock providers. Milestone 2 (Seedream) is coded
but **unverified against the live API** — blocked on an Ark API key.
Milestone 4 (Seedance) is deliberately not implemented.

## The V1 loop works

```
AE frame → Capture → Asset Library → generate → job → result registered
        → lineage → reopen recipe → variation (branches) → import / insert at playhead
```

Verified end to end against a running service, driven through the panel's own
client, in a workspace path containing spaces (`…/V1 Demo/Project One/`). The
generated images visibly retain the captured frame's structure and diverge by
seed, so the recorded lineage reflects a real derivation.

`npm test` — 92 tests. `npm run typecheck` — clean.

## What exists

### Packages

- `@seed-ae/domain` — Zod schemas for Asset, AeContext, Generation, Job, the
  HTTP wire contracts, normalized `SeedError` codes, prefixed ids.
- `@seed-ae/media` — dependency-free PNG encoder **and** decoder, box-average
  resize. Powers mock rendering and thumbnails without native modules.
- `@seed-ae/storage` — `node:sqlite`, migrations (v2), repositories for assets,
  generations and jobs, lineage walk, workspace layout, storage-URI validation.
  Append-only and immutability enforced by triggers.
- `@seed-ae/providers` — `GenerationProvider` + capabilities, `ProviderRegistry`,
  `MockImageProvider`, `MockVideoProvider`, `SeedreamProvider`,
  `SeedanceProvider` (inert).
- `@seed-ae/ae-host` — `AeHostAdapter` contract and `MockAeHostAdapter`.

### Service (`apps/service`)

Loopback HTTP, bearer auth, CORS for local origins, correlation ids, redacting
logger. Routes: health, AE context/capture/import, asset register/list/get/file
(+thumbnail variant)/lineage/recipe, providers, generations, jobs (+cancel).
Generation runs as a background job; the request never blocks on a provider.

### Panel (`apps/panel`)

React + Vite. Generate / Library / Lineage views, asset detail with recipe,
provenance, raw payload, and Import / Insert at playhead / Variation / Use as
reference actions. Capability-driven controls. `npm run dev` in `apps/panel`.

## Known gaps

- **Seedream is untested against the live API.** The adapter posts only
  documented fields and parses responses tolerantly, but no real call has been
  made. Needs `ARK_API_KEY` + `SEEDREAM_MODEL_ID`. An AK/SK pair is a different
  credential type and is not sufficient — see `docs/research/MODEL_API_NOTES.md`.
- **No CEP extension yet.** The panel runs in a browser; `MockAeHostAdapter`
  stands in for After Effects. Route decided (CEP — see
  `docs/research/ADOBE_INTEGRATION_NOTES.md`); the extension itself is unbuilt.
- **The panel UI has not been driven in a real browser.** Its render paths and
  client are covered by server-rendering tests, and the full loop is verified
  through the same client code, but nobody has clicked it. The Chrome extension
  and the headless browser were both unavailable on this machine.
- Video is fixture-replay only; no real video provider.
- Thumbnails cover PNG only (JPEG/WebP decode not implemented) and degrade
  gracefully to none.
- Jobs do not resume after a service restart. `JobRepository.listUnfinished()`
  exists for this but nothing calls it.
- Seed is stored as text, so a numeric seed round-trips as `"42"`.

## Next engineering actions

1. Get an Ark API key and a Seedream model id; run the loop against the real
   provider and record what the response actually looks like.
2. Build the CEP extension: manifest, ExtendScript host bridge (comp export,
   import, timeline insert), and swap `MockAeHostAdapter` for it.
3. Drive the panel in a browser and fix what that finds.
4. Resume unfinished jobs on startup.
5. Seedance 2.5 once official docs and access exist — adapter only.
