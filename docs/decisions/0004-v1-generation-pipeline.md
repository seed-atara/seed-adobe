# ADR 0004 — V1 generation pipeline and panel

Status: Accepted (2026-08-09)

## Decisions

### 1. Generation runs as a background job, always

`POST /v1/generations` persists a job plus its generation recipe and returns
`202` immediately. The provider call, polling, download and registration all
happen on a background task the panel polls via `GET /v1/jobs/:id`.

This holds even for Seedream, whose image endpoint answers synchronously. A
synchronous-looking provider still means an HTTP request that can take a minute,
and the panel must never be blocked on one. Uniform job semantics also mean
video (slow, genuinely async) needs no separate code path.

### 2. Mock providers are first-class, not test scaffolding

`MockImageProvider` renders a real, deterministic PNG derived from the reference
frame when one is supplied. That makes the demo loop — capture, generate,
lineage, variation, import — genuinely runnable with no credentials, and makes
the lineage in the demo real rather than asserted.

`MockVideoProvider` replays a configured fixture file rather than fabricating
video bytes. Encoding real video without native dependencies is out of scope,
and a file that will not decode is worse than an honest error.

### 3. Seedance stays inert

`SeedanceProvider` exists, reports empty capabilities, and throws
`unsupported_capability` on use. `buildRegistry` never registers it as runnable.
Its API contract is unverified, and a provider the panel can select and then
fail on is worse than one it cannot select.

### 4. Capabilities drive the UI, including what is disabled

The seed field is enabled only when the selected provider declares
`seed: true`.

*(Superseded 2026-08-09: Seedream originally declared `seed: false` because seed
support was unconfirmed. It is now verified supported and declares `true` — see
ADR 0005. The mechanism is the point: one capability flag turned the control on
with no UI change.)*

### 5. Lineage uses a join table, not JSON containment

`generation_inputs` links generations to their input assets. Lineage walks are
the core of the product, so they need an indexable relation rather than a
`json_each` scan over `input_asset_ids_json`.

### 6. Assets and generations are append-only; completion is not mutation

Database triggers reject deletes on both tables and reject updates to asset
identity/provenance. Completing a generation (status, outputs, raw response,
`completedAt`) is a fill-in of the same record, not a rewrite of history. A
variation is always a new generation with `parentGenerationId` set.

### 7. Ingested media is never overwritten

Output files are written with the `wx` flag under a name derived from the
generation id and output index. A retry produces a new generation and therefore
new files; a double-ingest fails loudly instead of silently replacing a result.

### 8. The panel is a plain web app

The panel is React + Vite with no host-specific code. It runs in a browser for
development and is loaded from `file://` by a CEP host later, which is why the
service sends CORS for local origins (`localhost`, `127.0.0.1`, and `null`) and
the Vite build uses a relative base. The session token, not the origin, is the
security boundary.

The panel uses a system font stack deliberately: a CEP panel can be launched
with no network, and a webfont that fails to load is worse than a considered
stack.
