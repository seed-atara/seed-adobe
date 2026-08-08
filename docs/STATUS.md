# Status

Last updated: 2026-08-09

## Current milestone

Milestones 0–3 complete, **Seedream verified against the live Ark API**, and
the panel ships as a **CEP extension that docks inside After Effects**.
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

### Panel (`apps/panel`) and extension (`apps/extension`)

React + Vite, styled as Windows 95 (see ADR 0006). Generate / Library /
Lineage views, asset detail with recipe, provenance, raw payload, and Import /
Insert at playhead / Variation / Use as reference actions. Controls are driven
by declared provider capabilities.

Ships as a CEP extension that docks in After Effects:
`pwsh -File scripts/install-extension.ps1`, then Window → Extensions → SEED / AE.
In CEP the panel drives AE itself through `jsx/seed-host.jsx` (capture via
`saveFrameToPng`, import into a SEED folder, insert at playhead inside an undo
group) and registers results with the service. In a browser it falls back to
the service's mock host, so everything stays testable without Adobe.

## Known gaps

- **The panel has not been driven inside After Effects.** It was verified in
  a browser against the live service — capture, generate, library, recipe,
  lineage and detail all confirmed working — but no one has yet loaded the
  extension in AE and pressed Capture on a real comp. The ExtendScript host is
  written and reviewed, not executed. The adapter is
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
- Video is fixture-replay only; no real video provider.
- Thumbnails cover PNG and JPEG. WebP and video have no decoder and degrade
  to no thumbnail (the panel then shows a placeholder).
- Interrupted jobs are closed out as failed on startup rather than resumed.
  True resume would need to re-poll the provider by `providerJobId`.

## Next engineering actions

1. Load the extension in After Effects and run the loop on a real comp.
2. Implement a `PublicUrlPublisher` (presigned S3/R2/GCS) to enable the
   `asset://` reference route, then switch `ARK_REFERENCE_POLICY` to `asset`.
3. Seedance 2.5 once official docs and access exist — adapter only.
