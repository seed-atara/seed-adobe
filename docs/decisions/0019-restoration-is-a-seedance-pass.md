# 0019 — Restoration is a Seedance reference-video pass, and nothing else

**Status:** built 2026-09-01 — `/v1/restore`, the Restore tab
**Date:** 2026-09-01
**Builds on:** ADR 0002 (provider abstraction), ADR 0010 (references travel as links)

## The decision

A restoration pass is an ordinary Seedance generation with the clip attached as
a **reference video**, a locked prompt, and three fields deliberately left out.
There is one engine. A dedicated upscaler was built first and removed the same
day — see "What was tried" below.

Four treatments, each with its own prompt: detail, clean up, repair damage,
colourise. Any combination runs at once, side by side.

## Why the shot survives

Not because the prompt asks nicely. Because of a measured Ark behaviour: a
request carrying a reference video with **no stated duration** is classified as
video editing, and the output then follows the input clip's length and ratio
exactly.

So `/v1/restore` sends no `durationSeconds`, no `aspectRatio`, and pins
`inputRoles` to `["reference"]` so the clip can never be read as a first frame
that the model animates away from.

The prompt argues; the omission binds. Each of those three is one careless line
from being undone, and each would look like a working feature until an editor
noticed the shot had moved, so `apps/service/test/restore.test.ts` asserts all
three directly.

The upscale is the fourth thing: the route asks for the top of the provider's
resolution ladder rather than the provider's own default, which on Seedance is
the bottom.

## What was tried, and removed

The first build had two lanes: a **measured** one on Topaz Video Upscale
(`fal-ai/topaz/upscale/video`) and a **generated** one on Seedance. Topaz has
no prompt field at all, so the argument was that its fidelity is structural
rather than a promise extracted from a model by careful wording.

That is true, and it was still the wrong shape:

- **It covers half the job.** An upscaler cannot invent, so it can never
  colourise and can never paint out a scratch. Two treatments would have had a
  lane the other two did not — two engines, two vocabularies, two sets of
  wiring, for a subset.
- **The guarantee was less clean than it sounded.** An upscaler that turns skin
  to wax has changed the shot too, and on badly degraded material it sharpens
  the damage along with the picture because it cannot tell them apart. A model
  that recognises what it is looking at often wins on exactly the footage a
  documentary has.
- **Two lanes invite a UI that implies a guarantee.** Presenting one path as
  "cannot change the picture" makes the other read as second-rate, when in
  practice the choice depends on the footage and nobody had run either.

Johannes's call, and the right one: one tool, one engine. The survey of both
upscalers is kept in `docs/research/VIDEO_RESTORATION.md` so the trade-off is
not re-litigated from scratch — SeedVR2's ProRes 4444 output is the strongest
reason to revisit.

## Consequences

- **The reference budget had to learn what a clip is.** `maxImageReferences` is
  an *image* count, and `assertSupported` was counting every input against it —
  so a provider that takes one clip and no images (Reframe) declared zero and
  had its only input refused before the adapter ran. Unusable that way since
  the day it was registered; nobody noticed because nothing drove it. Now
  images, clips and audio are checked against `maxImageReferences`,
  `videoReferences` and `audioReferences` respectively. **This survives the
  removal of the upscaler** — it was always a real bug.
- **`bestQualitySize` moved into `@seed-ae/domain`**, because the service needs
  it too.
- **`newId` no longer imports `node:crypto`.** That one line made the whole
  domain package node-only, which went unnoticed while the panel imported
  nothing but types from it and broke the panel build the moment it imported a
  function.
- **A new tab rather than a mode inside Generate.** Everything in Generate is a
  control for changing the shot. A restoration wants none of them, and an
  artist working through archive should not have to remember which nine
  controls to leave alone.
- **The route refuses a provider with no `videoReferences` up front**, rather
  than letting the generation service fail each job separately and leave a
  history full of failed renders for a request that was never going to work.

## What is not done

Nothing here has been run on real archive. Whether Seedance holds a face steady
across a long clip is the likeliest limiting factor and is unmeasured; so is
its behaviour on tramlining and gate weave. Interlacing is not handled at all,
and Seedance's 30-second cap means a long shot restores in pieces with nothing
checking the joins.

Per ADR 0018, this is not written up as working until a real clip has been
restored end to end and looked at.
