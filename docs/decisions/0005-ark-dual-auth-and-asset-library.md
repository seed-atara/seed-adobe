# ADR 0005 — Ark dual auth and the asset library

Status: Accepted (2026-08-09)

Supersedes the `seed: false` note in ADR 0004 §4.

## Context

Ark has two auth systems, not one, and earlier work had them conflated. An
account AK/SK pair signs the asset-library OpenAPI; a separate Ark API key
bearer-authenticates inference. Both are needed for the full feature set.

Signing was verified against the live BytePlus API on 2026-08-09 with a
read-only `ListAssetGroups` call.

## Decisions

### 1. The signer is ours, and it is exercised

`signArkRequest` implements the SigV4 *variant* Ark uses: `X-Date`,
`X-Content-Sha256`, and the literal `request` scope terminator. The three
deviations from AWS SigV4 are precisely what break ports, so each is asserted in
a test against a frozen timestamp rather than left to a live call to discover.

The secret is used exactly as issued. It looks base64-shaped and decodes twice
into plausible hex, which invites a wrong guess — the live probe settled it.

### 2. Reference policy is explicit, never a silent fallback

`ReferencePolicy` is one of:

- `asset` — register in the asset library, and **fail** if that is not possible
- `asset-or-inline` — register if possible, otherwise send a data URL (default)
- `inline` — always send a data URL

This is a deliberate choice rather than a convenience default because requests
carrying recognisable real people are intercepted on the inline path. In a
rights-sensitive pipeline, silently posting raw pixels after a registration
failure is the worst possible behaviour. `asset` exists so that failure is loud.

`asset-or-inline` is the default only because the `asset` path additionally
needs a public URL publisher, which is not yet implemented.

### 3. Registration needs a publisher, and we say so rather than guessing

`CreateAsset` fetches bytes from a URL and rejects `data:` URLs, so a local AE
render cannot be registered without being reachable over https first.
`PublicUrlPublisher` is the seam for a presigned S3/R2/GCS link. No
implementation ships yet; `ensureAsset` throws an error naming exactly this
rather than pretending.

### 4. Dedupe by content hash, with no shared database

Assets are named `<name>_<sha16>`. `ListAssets` fuzzy-matches on `Name`, so any
machine can discover an existing registration; a local map caches the result so
a repeat reference costs nothing. Verified live against an account whose
existing assets already follow this convention.

Registration is free and slow (~10s); generation is paid and interactive. That
asymmetry is why `prewarm` exists.

### 5. Model constraints are enforced locally

Per-model minimum output area is a hard API constraint. `assertSizeAllowed`
rejects an undersized request before spending a call, and `sizesFor` narrows the
size list the panel offers, so the constraint shapes the UI instead of surfacing
as a failed generation. The withdrawn `seededit-3-0-i2i-250628` is rejected at
construction.

These constants live in `packages/providers/src/ark/models.ts` and must be kept
in step with `docs/research/MODEL_API_NOTES.md`.

### 6. Prompts reference inputs by position

The model does not resolve asset ids in prose. The panel surfaces this as a hint
next to the prompt whenever references are attached, because it is the kind of
thing that produces a plausible-but-wrong result rather than an error.
