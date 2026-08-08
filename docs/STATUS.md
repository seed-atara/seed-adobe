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

`npm test` — 116 tests. `npm run typecheck` — clean.

**Verified live against the BytePlus Ark API (2026-08-09):** the AK/SK request
signer authenticates (`ListAssetGroups` on `open.byteplusapi.com`, secret used
as issued), and content-hash dedupe finds existing registrations by fuzzy name
search. The account's `SEED_KEYFRAMES` group already follows the same
`<name>_<sha16>` convention.

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
  `SeedanceProvider` (inert), and the Ark layer: request signer, OpenAPI client,
  asset library with content-hash dedupe, per-model size constraints.
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

- **Seedream inference is blocked on an `ARK_API_KEY`.** The adapter is
  implemented against the verified contract (synchronous, `seed` supported,
  per-model minimum output area enforced locally, up to 14 references), but no
  generation has been run: inference needs a Bearer API key from the Ark
  console, which we do not have. The account AK/SK pair is a *different*
  credential and cannot authenticate it.
- **No public URL publisher.** `CreateAsset` fetches references over https and
  rejects `data:` URLs, so registering a local AE frame needs a presigned-link
  implementation of `PublicUrlPublisher`. Until then the reference policy falls
  back to inline data URLs — which is the wrong route for recognisable real
  people, hence the explicit `asset` policy that refuses to fall back.
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

1. Get an Ark API key (Ark console -> API Keys) and a Seedream model id, then
   run the loop against the real provider. Everything else for Seedream is in
   place and unit-tested.
2. Implement a `PublicUrlPublisher` (presigned S3/R2/GCS) to enable the
   `asset://` reference route, then switch `ARK_REFERENCE_POLICY` to `asset`.
3. Build the CEP extension: manifest, ExtendScript host bridge (comp export,
   import, timeline insert), and swap `MockAeHostAdapter` for it.
4. Drive the panel in a browser and fix what that finds.
5. Resume unfinished jobs on startup.
6. Seedance 2.5 once official docs and access exist — adapter only.
