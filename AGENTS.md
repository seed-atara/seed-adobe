# SEED / AE — Development Agent Operating Manual

## Mission

Build a professional generative-production layer inside Adobe After Effects.

The product is not "an AI prompt panel." After Effects remains the deterministic creative operating system; generative image/video models act as renderers; a central Asset Library preserves media, recipes, lineage, and provenance.

The initial showpiece is **Seedance 2.5** for a ByteDance-facing demo. **Do not invent or hard-code Seedance 2.5 API contracts that have not been verified from official documentation.** Implement Seedance through a capability/provider abstraction so the concrete adapter can be completed as soon as official API access/schema is available.

Seedream is the first verified image-generation backend. Volcengine Ark examples use:
`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`
with Bearer `ARK_API_KEY`, and support text-to-image, image-to-image, and multiple reference images.

## Product thesis

> After Effects is the operating system.
> Models are generative renderers.
> The Asset Library is memory.

Every generated image or clip is an **Asset + Generation Recipe + Lineage**.

The user must be able to:
1. Capture the currently visible After Effects composition frame.
2. Register that frame as an immutable source asset.
3. Generate/edit images from that asset via Seedream.
4. Generate videos from one or more assets via Seedance when API access is available.
5. Browse generation results without leaving After Effects.
6. Import a result into the AE project and optionally insert it at the playhead.
7. Select a previously generated result and recover its exact recipe.
8. Regenerate, branch, change prompt, change seed, or replace references.
9. Preserve ancestry/lineage rather than overwrite history.
10. Keep provider credentials out of the panel/client bundle.

## V0 success criterion

A polished end-to-end loop:

`AE current frame -> Capture -> Asset Library -> Seedream -> result -> Asset Library -> AE import -> reopen recipe -> variation`

V0 must work before expanding into an LLM agent, multi-user cloud collaboration, or multiple providers.

## ByteDance demo target

The product should evolve toward this 90-second demo:

1. Open a normal VFX/creative comp in AE.
2. Move playhead to a hero frame.
3. Press **Capture Frame**.
4. Add references from AE / Asset Library.
5. Enter a direction prompt.
6. Generate with **Seedance 2.5**.
7. Job status is visible in-panel.
8. Completed video automatically registers in Asset Library.
9. Click **Insert at Playhead**.
10. Select the resulting generated asset.
11. Click **Variations**.
12. Show complete recipe + provenance tree.
13. End line: **"Seedance isn't outside the production pipeline anymore. It's inside the timeline."**

Until Seedance 2.5's production API is verified, use a `MockVideoProvider` and fixture payloads to prove this UX.

## Architecture rules

### Client vs service

Never call model providers directly from the After Effects panel in production.

Preferred shape:

```
After Effects panel
    |
    | local authenticated HTTP
    v
SEED service
    |-- Asset service
    |-- Job service
    |-- Generation router
    |-- Provider adapters
    |-- Credential service
    |-- SQLite metadata
    |
    +--> Volcengine Ark / ByteDance / future providers
```

Reasons:
- keep API secrets out of extension code
- unified retries/cancellation/status
- normalize provider-specific schemas
- centralize media ingestion/download
- preserve provenance
- future cloud/team deployment
- cost and usage accounting

### Start local-first

Use:
- TypeScript
- Node.js
- SQLite
- regular filesystem media
- localhost HTTP API
- React for panel UI if compatible with selected AE panel technology

Cloud sync comes later.

### Adobe integration

Before committing to CEP, UXP, C++ SDK, or another extension route:
1. Verify current After Effects support in Adobe's official documentation.
2. Prefer the simplest route that can provide a dockable UI plus scripting access to the project, comp, render/export, imports, and timeline operations.
3. Isolate all Adobe-host-specific logic behind `AeHostAdapter`.
4. Do not let the rest of the app depend on ExtendScript/CEP-specific globals.

If needed for V0, use a thin host bridge:
`Panel UI <-> AE host bridge <-> local SEED service`.

## Repository principles

- Monorepo.
- Strong TypeScript schemas at boundaries.
- No provider-specific types outside `providers/*`.
- No destructive mutation of generation history.
- Assets are immutable; edits create descendants.
- All API responses persisted enough to reproduce/debug a generation.
- Store raw provider payloads alongside normalized records when safe.
- Do not store secrets in SQLite, logs, `.aep` projects, generation metadata, or git.
- Long-running generations are jobs, never blocking synchronous HTTP requests.
- Prefer deterministic IDs (UUID/ULID) and explicit timestamps.
- Paths are project-relative where practical.
- Every important feature should be testable outside After Effects.

## Domain model

### Asset

An asset represents a piece of media known to SEED.

Required fields:
- `id`
- `kind`: image | video | audio | other
- `status`
- `filename`
- `mimeType`
- `width`, `height` where known
- `duration`, `fps` for video where known
- `storageUri`
- `thumbnailUri`
- `createdAt`
- `source`
- optional `generationId`

### Generation

A generation is the normalized recipe and result relationship.

Required:
- `id`
- `provider`
- `model`
- `operation`
- `prompt`
- `seed` if provider supports it
- provider-normalized parameters
- input asset IDs
- output asset IDs
- parent generation/asset lineage
- createdAt
- raw provider request/response where safe
- job ID

### Source provenance

Record AE provenance when captured:
- AE project identifier/path fingerprint
- comp name + stable identifier when feasible
- comp dimensions
- frame rate
- time / frame number
- layer IDs/names if relevant
- work area if relevant
- color-space metadata if obtainable
- capture/render settings

Do not assume AE object IDs remain globally stable across project edits; design for graceful fallback.

## Provider abstraction

The normalized interface should resemble:

```ts
export interface GenerationProvider {
  id: string;
  capabilities(): Promise<ProviderCapabilities>;
  generateImage?(request: ImageGenerationRequest): Promise<ProviderJob>;
  editImage?(request: ImageEditRequest): Promise<ProviderJob>;
  generateVideo?(request: VideoGenerationRequest): Promise<ProviderJob>;
  getJob(jobId: string): Promise<ProviderJobState>;
  cancelJob?(jobId: string): Promise<void>;
}
```

Capabilities must describe, rather than assume:
- text-to-image
- image-to-image
- multiple image references
- text-to-video
- image-to-video
- video references
- start/end frames
- audio references
- seed support
- duration range
- resolution/aspect options
- async/sync behavior

UI controls are enabled from capabilities.

## Seedream adapter

Verified starting point from Volcengine developer documentation:

```http
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
Authorization: Bearer $ARK_API_KEY
Content-Type: application/json
```

Documented payload examples include:
- `model`
- `prompt`
- `image` as URL or array of URLs
- `size`
- `sequential_image_generation`
- `stream`
- `response_format`
- `watermark`

Do not blindly assume a specific model ID. Put model IDs in runtime configuration.

Important: local AE-exported frames may need upload/object storage or another provider-accepted representation before they can be referenced by URL. Encapsulate this via `InputMaterializer`.

## Seedance 2.5 adapter

Goal: hero video provider.

Current rule:
**Do not infer endpoint names or request fields from consumer UI, older Seedance APIs, third-party sites, or model marketing.**

Implement:
- `SeedanceProvider` skeleton
- configuration object
- capability mapping
- test fixtures
- mock mode
- TODO markers requiring official docs
- raw request/response preservation
- polling abstraction

When official access arrives, only the adapter should need major changes.

## Asset Library UX

Primary views:
1. **Generate**
2. **Assets**
3. **History / Lineage**

Minimum asset card:
- thumbnail
- media type
- creation timestamp
- provider/model badge
- prompt snippet
- source/derived badge

Asset detail:
- full prompt
- provider/model
- generation parameters
- references
- source AE provenance
- parent asset
- child variations
- actions: Import, Insert, Regenerate, Variation, Branch

## AE host operations

Expose these through `AeHostAdapter`:

```ts
interface AeHostAdapter {
  getActiveContext(): Promise<AeContext>;
  captureCurrentFrame(options?: CaptureOptions): Promise<CapturedMedia>;
  captureSelectedLayer?(options?: CaptureOptions): Promise<CapturedMedia>;
  importMedia(path: string, options?: ImportOptions): Promise<AeImportResult>;
  insertAtPlayhead?(projectItemId: string, options?: InsertOptions): Promise<void>;
}
```

V0 must implement:
- active comp information
- current-time/current-frame capture
- import file into project

Stretch:
- capture selected layer with alpha
- insert into active comp at playhead
- folder organization
- preserve timing/transforms when replacing a selected layer

## Security

- `.env` for local dev only; `.env` ignored by git.
- Provide `.env.example`.
- Service reads `ARK_API_KEY`.
- Never print keys.
- Redact Authorization headers.
- Validate file paths.
- Restrict localhost service binding by default.
- Use a local session token between panel and service.
- Validate content types and file sizes.
- Sanitize provider-returned filenames.
- Do not execute text returned by an LLM/model.

## Observability

Every generation gets:
- correlation ID
- provider
- model
- operation
- duration
- status transition timestamps
- input count
- output count
- normalized error class

Never log secrets or full sensitive user prompts by default in telemetry.

## Implementation order

### Milestone 0 — prove host bridge
- panel loads
- service starts separately
- panel can call `/health`
- panel can query current AE context
- panel captures current frame to known file
- service registers frame in DB

### Milestone 1 — asset library
- migrations
- asset CRUD/read APIs
- thumbnail generation
- asset grid in panel
- asset detail view
- source provenance

### Milestone 2 — Seedream
- Ark client
- input materialization
- image generation
- download result
- register output
- generation recipe + lineage
- retry/error states
- import result into AE

### Milestone 3 — reproducibility
- reopen recipe
- branch
- vary seed where supported
- replace references
- lineage UI

### Milestone 4 — Seedance 2.5 showpiece
- official API contract integrated once verified
- video generation jobs
- progress/polling
- download + registration
- insertion at playhead
- start/end/reference semantics according to actual capabilities
- polished demo fixtures/fallback

### Milestone 5 — LLM/agent
Only after the deterministic workflow is excellent.
Agent produces a proposed execution plan; user controls destructive/timeline changes.

## Out of scope for V0

- multi-user cloud sync
- billing
- distributed render farm
- full DAM replacement
- model marketplace
- autonomous timeline editing
- dozens of providers
- prompt-chat as main UX
- C++ effects/render plugin unless proven necessary

## Definition of done for any feature

A feature is not done until:
- it has a type-safe contract
- error and loading states exist
- failures do not lose provenance
- no secret is exposed
- tests cover non-Adobe logic
- README/docs updated
- it works with a project path containing spaces
- Windows path handling is tested
- generated media is not overwritten on retry
- cancellation/retry semantics are explicit

## Agent behavior

You are expected to make implementation progress, not endlessly redesign.

For each work session:
1. Inspect repo and current milestone.
2. State the smallest valuable vertical slice.
3. Implement it end-to-end.
4. Run tests/typecheck/lint.
5. Update `docs/STATUS.md`.
6. Record architectural decisions in `docs/decisions/` when nontrivial.
7. Leave explicit blockers only where external documentation/credentials are genuinely required.

When uncertain about an external API, research official docs and cite the source in `docs/research/`. Never invent the contract.

## Naming

Working product name: **SEED / AE**

This is a working name and may conflict with internal/company naming. Keep package names generic enough to rename later.
