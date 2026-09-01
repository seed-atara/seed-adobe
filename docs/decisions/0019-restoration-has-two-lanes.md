# 0019 — Restoration has two lanes, and they are never blurred

**Status:** built 2026-09-01 — `/v1/restore`, the Restore tab, `UpscaleProvider`
**Date:** 2026-09-01
**Builds on:** ADR 0002 (provider abstraction), ADR 0010 (references travel as links)

## The decision

A restoration pass runs down one of two lanes, and which lanes a treatment can
use is a property of the treatment rather than a preference:

- **measured** — Topaz Video Upscale on fal. There is **no prompt field on the
  endpoint**, so the shot cannot change. Detail and cleanup run here.
- **generated** — Seedance with the clip as a *reference video*, under a locked
  restoration prompt. Colourising and damage repair run here, because both have
  to invent, and detail and cleanup are offered here too because the model
  often beats the interpolator on badly degraded footage.

Both lanes are offered for the treatments both can do, and the panel can run
them together and put the results side by side.

## Why two, rather than picking the better one

Because they make different promises, and the difference is the product.

"Cannot change the picture" and "usually does not change the picture" are not
the same sentence. An editor cutting archive into a documentary needs the first
one where they can get it — a shot where a sign changed or a face drifted is
not usable as evidence, and no amount of prompt engineering converts a
generative model's tendency into a guarantee.

But the measured lane cannot invent, and colour on monochrome stock has to be
invented. Refusing to offer that would not make the problem go away; it would
send the artist to a different tool with no provenance record.

So the honest design offers both, says which is which in the artist's own
reading order, and records on every generation which lane produced the result.

## Why the guarantee is expressed by omission

The generated lane's fidelity rests on a measured Ark behaviour: a request
carrying a reference video with **no stated duration** is classified as video
editing, and the output then follows the input clip's length and ratio exactly.

So `/v1/restore` sends no `durationSeconds`, no `aspectRatio`, and pins
`inputRoles` to `["reference"]` so the clip can never be read as a first frame
that the model animates away from.

Each of those is one careless line from being undone, and each would look like
a working feature until an editor noticed the shot had moved.
`apps/service/test/restore.test.ts` asserts all three directly.

## Consequences

- **A new provider that is not generative.** `UpscaleProvider` declares no
  seed, no sizes, no aspect ratios and no negative prompt. Those are not
  limitations to apologise for; each one is a way the result could have
  differed from the source, and their absence is the feature.
- **The reference budget had to learn what a clip is.** `maxImageReferences` is
  an *image* count, and `assertSupported` was counting every input against it —
  so a provider that takes one clip and no images (Topaz, and Reframe before
  it) declared zero and had its only input refused before the adapter ran.
  Reframe has been unusable this way since the day it was registered; nobody
  noticed because nothing drove it. Now images, clips and audio are checked
  against `maxImageReferences`, `videoReferences` and `audioReferences`
  respectively.
- **`bestQualitySize` moved into `@seed-ae/domain`**, because the service now
  needs it too — a restoration defaults to the top of the provider's ladder
  rather than the provider's own default, which on Seedance is the bottom and
  would produce an "upscale" that came back smaller.
- **`newId` no longer imports `node:crypto`.** That one line made the whole
  domain package node-only, which went unnoticed while the panel imported
  nothing but types from it and broke the panel build the moment it imported a
  function.
- **A new tab rather than a mode inside Generate.** Everything in Generate is a
  control for changing the shot. A restoration wants none of them, and an
  artist working through archive should not have to remember which nine
  controls to leave alone.

## What is not done

Neither fal adapter has been run against a live account, so Topaz's real
behaviour on scanned film is unknown, and so is whether Seedance holds a face
steady across a long archive clip. The contract is from published schemas, not
from a response this code has seen — see `docs/research/VIDEO_RESTORATION.md`.

Per ADR 0018, this is not written up as working until a real clip has been
restored end to end and looked at.
