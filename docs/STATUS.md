# Status

Last updated: 2026-08-09

## Current milestone

**Milestones 0–4 complete.** Seedream and Seedance 2.5 are both verified
against the live BytePlus Ark API, and the panel docks inside After Effects.

## The V1 loop works

```
AE frame → Capture → Asset Library → Seedream (image) or Seedance 2.5 (video)
        → result registered → lineage → reopen recipe → variation
        → import / insert at playhead
```

Verified end to end on real generations, driven through the panel's own client:

- **Seedream** `seedream-4-0-250828` — image-to-image from a captured frame.
  Results visibly retain the frame's structure and diverge by seed, so the
  recorded lineage reflects a real derivation.
- **Seedance 2.5** `dreamina-seedance-2-5-260628` — image-to-video from a
  captured frame. 4s at 480p, about 4 minutes, a complete 2.3MB mp4 whose box
  chain ends exactly at EOF, registered with lineage back to the source frame
  and a recoverable recipe.

Also verified in a workspace path containing spaces, and with the AK/SK signer
against the asset library.

`npm test` — 148 tests. `npm run typecheck` — clean.

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
  `SeedanceProvider` (working), and the Ark layer: request signer, OpenAPI
  client, asset library with content-hash dedupe, per-model constraints.
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

Ships as a CEP extension that docks in After Effects **and Premiere Pro**:
`npm run install:extension`, then Window → Extensions → SEED / AE.
In CEP the panel drives AE itself through `jsx/seed-host.jsx` (capture via
`saveFrameToPng`, import into a SEED folder, insert at playhead inside an undo
group) and registers results with the service. In a browser it falls back to
the service's mock host, so everything stays testable without Adobe.

## Known gaps

- **Video posters are borrowed, not extracted.** There is no video decoder
  here, so a generated clip shows the thumbnail of the frame it was generated
  from. For image-to-video that frame *is* the first frame, so it is honest —
  but it is not a real extract, and a text-to-video result gets no poster.
- **No public URL publisher**, so Ark asset registration (`asset://`) cannot be
  used for local frames; references go inline as data URLs. That is the wrong
  route for recognisable real people — see ADR 0005.
- **Region of Interest silently halves a capture.** Detected and warned about
  now, but not prevented: AE has no scripting API to read or clear it.
- Thumbnails cover PNG and JPEG. WebP has no decoder and degrades to none.
- Video dimensions and duration are read from the MP4 sample description at
  ingest, so a generated clip knows its own size. A poster frame still is not
  extracted — image-to-video results borrow the thumbnail of the frame they came
  from, which is honest but not a real extract.
- Interrupted jobs are closed out as failed on startup rather than resumed.
- Seedance text-to-video is implemented but only image-to-video has been run
  live; accepted parameter values may differ between the two modes.

## Direction agent (Milestone 5, first slice)

`POST /v1/agent/compose` turns a described shot into a proposed generation:
Claude reads the description and the actual reference thumbnails, writes the
prompt, chooses and orders the references, and picks parameters. The panel's
**Direct this shot** button fills the form from the plan and shows the
rationale — nothing is queued until the artist presses Generate. See ADR 0007.

- `@name` mentions in the prompt resolve to library assets and come back as
  positional references ("Image 1"), which is what the providers understand.
- The model returns a provider-agnostic draft; code maps it onto a real
  provider from declared capabilities, so a plan can never name a model id that
  does not exist.
- Anything clamped or dropped to fit the provider is reported to the artist
  rather than silently applied.
- Optional: with no `ANTHROPIC_API_KEY` the service reports `director: false`
  and the panel does not offer the button.
- Try it without the panel: `npx tsx scripts/direct.ts "describe the shot"`.

## Regions — animating part of a larger plate (After Effects)

A tall or wide plate can be animated a square at a time. Three objects make one
region, each with a job:

1. **A guide layer** in the plate comp — the control. An ordinary shape layer,
   adjusted with Position and Scale, so it can be keyframed or parented like
   anything else. SEED only reads its transform back.
2. **A sub-comp**, sized to the region — the workspace. Holds the captured
   still, and later the animated clip on top of it. Created on first capture and
   reused after, so anything the artist builds inside it survives.
3. **A composite layer** in the plate comp holding that sub-comp, feathered.
   Because the sub-comp's background is the captured still, the feathered edge
   fades into pixels identical to the plate underneath, which is what makes the
   join invisible.

The sub-comp holds the captured *still*, never the plate comp itself — a comp
cannot contain a comp that contains it, and the animation is built from that
frozen frame anyway.

Feather, start time, and a stretch-to duration are all panel parameters. The
plate is never modified: the composite can be retimed, replaced, or deleted
without rebuilding anything.

### Holding a region to a shape

A region can be held to an aspect the provider actually offers — the **Shape**
dropdown, or **Free**. The constraint is an expression on the layer's Scale
(`[value[0], value[0]]`), so it holds *while* a corner handle is dragged rather
than correcting the region afterwards. The rectangle itself carries the aspect,
so the shape survives saving and reopening the project.

Only ratios that describe a shape appear: `adaptive` is a policy, not a shape,
and offering it would promise a constraint with nothing to enforce.

Reshaping an existing region keeps its width and centre and moves the height —
width is usually what the artist has just finished framing.

Premiere frame capture works, via `sequence.exportFrameAsPNG(time, path)` — see
the Adobe notes. Media Encoder, the route Adobe's own sample uses, is given the
correct range and ignores it, so it is kept only as a last fallback.

Not yet exercised in After Effects — the host functions parse and the panel
builds, but the round trip has not been run against a real project.

## Reserving the cut while a render runs

Generating a video holds its space in the host immediately, at the playhead,
for the duration asked for — then swaps the result in when it lands. Both hosts
keep whatever the artist did to the placeholder while waiting, which is the
point: trimming or moving it is a reasonable thing to do with reserved space.

- **After Effects** uses `AVLayer.replaceSource`. Effects, transforms and
  keyframes live on the layer rather than the source, so they survive.
- **Premiere** uses `projectItem.changeMediaPath(path, true)`, which keeps the
  timeline clip and therefore its effects. Each reservation imports the
  placeholder card again so it has its own project item — sharing one would
  mean filling one placeholder filled them all. It is a still becoming a video,
  a media change the API may refuse; a refusal falls back to replacing the clip,
  which is certain but forgets any trimming, and the panel says so when it
  happens.

A failed or cancelled job renames the placeholder rather than removing it —
deleting something the artist may have built around is worse than leaving it
there saying what went wrong.

Only reserved for a single video: with variants the artist is choosing between
takes afterwards, and four placeholders would be four things to tidy rather
than one to fill.

## Variants

Generate asks for 1 to 4 results at once, each with its own seed, shown side by
side to pick from. A stated seed anchors the set — the first is exactly what was
asked for and the rest step away from it — so any variant stays reproducible and
can be branched from. With no seed given, each gets a random one, recorded in
its recipe.

Picking a variant sets the selection, which is what Import, Insert and
"Composite result into region" then act on.

The mock providers are no longer registered unless `SEED_AE_MOCK_PROVIDERS` is
exactly `true`. They exist for running the workflow without credentials, not
for picking from a list beside the real thing.

## Removing an asset, and aspect ratios

**Remove** (the × on a library card) deletes the media and takes the asset out
of the library, but keeps the row. Deleting the row would take the provenance
with it — recipes that used the frame still name it — and would break library
ordering, which uses rowid to break same-millisecond ties. A removed asset
becomes what a missing file already meant: status `missing`, plus a timestamp
saying it was deliberate. The bytes do not come back, so the panel asks first
and says how many generations still reference it.

**Aspect** is now a control rather than a silent default. Providers speak two
vocabularies — a ratio like `16:9`, or a size like `1920x1080` — and **Fit
reference** reads whichever the provider uses and picks the option closest to
the reference frame's own shape. Closeness is measured on the log of the ratio,
so twice-as-wide and half-as-wide are equally far; a raw quotient would quietly
favour wide options.

Where a single reference becomes the first frame, the frame dictates the shape
and the API refuses a ratio alongside it, so the control is replaced by a note
saying so rather than offering a choice that does not exist.

## Iterating on a shot in place

Built, not yet exercised in the applications.

Selecting a generated clip in the timeline and pressing **Iterate on selected
shot** loads the recipe that made it — prompt, references, roles, seed,
duration, aspect and the audio switch. Changing anything and pressing Generate
turns that clip into the pending placeholder rather than reserving new space,
and the render replaces it where it sits, keeping the scale, position and
timing already built around it.

Three details decide whether this is trustworthy:

- **The link is the media path.** Nothing is written into the Adobe project to
  mark a layer as SEED's, because a layer can be renamed, duplicated,
  pre-composed or copied to another project, and a mark would survive all of
  that while meaning something different afterwards.
- **The target is re-confirmed before anything is replaced.** Both hosts locate
  a shot by position — a layer index, a time on a track — and both positions
  shift under ordinary editing. The filename is checked at adopt time, After
  Effects re-finds the layer by file if its index moved, and an ambiguous match
  refuses rather than guesses.
- **A failed render restores the previous take.** Iterating costs the wait and
  nothing else; it never leaves a striped card where the artist's shot was.

In After Effects the swap is `replaceSource`, so effects and keyframes survive.
In Premiere it cannot be: `changeMediaPath` acts on the project item, which is
the library's copy of the render, so adopting overwrites the clip's span
instead and carries the scale across by hand. Clip effects do not survive that
— an honest cost of the only route Premiere leaves open.

Recipes were lossy until now: `durationSeconds`, `aspectRatio`, `generateAudio`
and `inputRoles` were never returned, and the last two were never stored at
all, so a reopened video recipe quietly changed length and forgot which
reference was the end frame. Both halves are fixed and covered by tests.

## Known-good demo path

Verified end to end at the time of writing:

1. Capture a frame — After Effects natively, Premiere through
   `sequence.exportFrameAsPNG`.
2. Direct the shot — about 15 seconds, references stay as chosen.
3. Generate — space is held in the timeline at the right shape for the
   duration asked for.
4. The render swaps in underneath, scaled from its real dimensions.
5. Pick a variant, composite into a region, or insert at the playhead.

## Next engineering actions

1. Run the full demo in After Effects: capture a hero frame, generate with
   Seedance 2.5, insert the clip at the playhead. Every piece is verified
   individually; the sequence as a performance is not.
2. Implement a `PublicUrlPublisher` (presigned S3/R2/GCS) to enable the
   `asset://` reference route, then switch `ARK_REFERENCE_POLICY` to `asset`.
3. Extract a real first frame for video posters, or accept the borrowed one
   and say so in the UI.
4. Confirm Seedance text-to-video parameters, and whether `video_url` /
   `audio_url` content parts are usable.
5. Milestone 5 continued: the direction agent plans but does not act. Tool use
   and an execution loop stay gated behind the rule in ADR 0007 — the agent
   proposes, the user approves anything destructive.
