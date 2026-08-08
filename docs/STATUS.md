# Status

Last updated: 2026-08-09

## Current milestone

Milestones 0–3 complete, **Seedream verified against the live Ark API**.
Milestone 4 (Seedance) is deliberately not implemented — the model id is now
known (`dreamina-seedance-2-5-260628`) but its request contract is not.

## The V1 loop works

```
AE frame → Capture → Asset Library → generate → job → result registered
        → lineage → reopen recipe → variation (branches) → import / insert at playhead
```

Verified end to end against a running service, driven through the panel's own
client, in a workspace path containing spaces (`…/V1 Demo/Project One/`). The
generated images visibly retain the captured frame's structure and diverge by
seed, so the recorded lineage reflects a real derivation.

`npm test` — 121 tests. `npm run typecheck` — clean.

**Verified live against the BytePlus Ark API (2026-08-09).** The whole loop
runs on real Seedream: capture -> generate -> register -> lineage -> reopen
recipe -> variation -> import at playhead. Also verified: the AK/SK signer
authenticates the asset library, and content-hash dedupe finds existing
registrations by fuzzy name search.

Two bugs only a live run could have surfaced, both fixed and covered by
regression tests:

1. **A synchronous provider marked its job succeeded before the outputs
   existed.** Seedream answers inline, so the job flipped terminal while the
   result was still downloading — anything polling for completion saw a
   finished job with zero outputs. Terminal status now belongs solely to the
   step that registers the media.
2. **Ark returns JPEG and says nothing about it.** The adapter claimed
   `image/png`, so files were written as `.png` containing JPEG, with wrong
   mime metadata and silently skipped thumbnails. The ingestor now sniffs the
   bytes and treats any provider-declared type as a hint.

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

- **Thumbnails are PNG-only, so no Seedream result has one.** Ark returns
  JPEG and there is no JPEG decoder here. The panel falls back to serving the
  full image, so the grid still works — but it ships ~700KB per card instead
  of ~30KB. Needs a JPEG decoder or a different resize path. The adapter is
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

1. Thumbnail JPEG results, so the library grid stops serving full-size images.
2. Implement a `PublicUrlPublisher` (presigned S3/R2/GCS) to enable the
   `asset://` reference route, then switch `ARK_REFERENCE_POLICY` to `asset`.
3. Build the CEP extension: manifest, ExtendScript host bridge (comp export,
   import, timeline insert), and swap `MockAeHostAdapter` for it.
4. Drive the panel in a browser and fix what that finds.
5. Resume unfinished jobs on startup.
6. Seedance 2.5 once official docs and access exist — adapter only.
