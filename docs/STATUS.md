# Status

Last updated: 2026-10-12

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

## Restoration — built 2026-09-01, not yet run on real footage

A **Restore** tab for archive: a clip in, the same clip out at better quality,
with nothing about the shot changed. Aimed at documentary work — a newsreel
that has to cut against modern footage and cannot have a sign move or a face
drift.

One engine: **Seedance with the clip as a reference video**, under a locked
restoration prompt. Four treatments — detail, clean up, repair damage,
colourise — each with its own prompt, any combination running at once so the
results can be compared side by side.

The fidelity comes from what the request *omits*: no duration and no aspect
ratio, so Ark reads it as an edit and the output follows the input clip's
length and framing exactly; and `inputRoles` pinned to `reference`, so the clip
is never read as a first frame to animate away from. All three are asserted in
`apps/service/test/restore.test.ts`. The upscale is the route asking for the
top of the provider's resolution ladder rather than its default, which on
Seedance is the bottom.

A two-lane version with a Topaz upscaler was built and removed the same day —
it covered only half the treatments, and its guarantee was less clean than it
sounded. The survey of both upscalers is kept in
`docs/research/VIDEO_RESTORATION.md`; see ADR 0019.

Found and fixed on the way: **`assertSupported` counted every input against
`maxImageReferences`**, which is an image budget. A provider taking one clip
and no images declares zero, so its only input was refused before the adapter
ran — true of `ReframeProvider` since the day it was registered, and never
noticed because nothing drove it.

**Nothing here has been run on real archive.** Whether Seedance holds a face
steady across a long clip is unmeasured, and so is its behaviour on tramlining
and gate weave. Per ADR 0018 this is not "working" until a real clip has been
restored and looked at.

`npm test` — 658 tests. `npm run typecheck` — clean.

## Expansion, rebuilt 2026-08-25 — `scripts/expand-shot.ts`

Started again from Johannes's design and nothing else: the artist sets the rect
saying where the original picture sits inside the full frame, Seedance widens
the shot, and the original is composited back over its rect. No tracking, no
mosaic, no coverage report, no bar detection.

**What made it work is layering the reference stack.** Send the widened plate,
the real first frame, the real last frame *and* the clip together, every still
cropped to the rect so no delivery bars reach the model. Framing fidelity to
the source, fitted as a scale and shift:

| reference stack | correlation |
| --- | --- |
| plate only, 21:9 | 0.37 |
| plate only, 16:9 | 0.69 |
| **plate + both end frames + clip** | **0.77** |

At 0.77 the render composites straight — no alignment step, no visible join.

Verified on `Puffs_1x1_to_16.9_f00482_range.mp4`: a **604x1080 portrait inside
1920x1080**, so **69% of the delivered frame is generated**. Out at 1920x1080
with no black anywhere — the darkest edge band across the whole clip measures
59.7, where a bar reads 2-5.

**The limit that cost the most to find: Seedream re-renders the whole frame,
centre included.** It is not an outpainting tool. There is no mask parameter,
and `seededit-3-0-i2i` — the actual editing model — is WITHDRAWN on this
account. Mean difference over the picture rect, where 0 would mean untouched:

| model | centre delta |
| --- | --- |
| `seedream-4-0-250828` | 31 |
| `dola-seedream-5-0-pro-260628` | 46 |

Three phrasings all re-rendered; one returned a mirrored composition, another
drew a black-bordered photo floating on a blurred background. No prompt
substitutes for a mask, so the original rect is pasted back mechanically.

**Aligning the render afterwards is a trap.** The fit is a scale below one —
the render shows a wider view, so matching it means shrinking it — and a 1920
frame scaled to 1690 cannot fill 1920. It puts black at the edges to fix a join
that no longer shows. Kept behind `SEED_EXPAND_ALIGN=1` for the day a render
has genuine headroom to shrink into.

Measured Ark rules now encoded in the script: `ratio` must be a named ratio
(`16:9`, not `1920:1080`); a reference video carries its letterboxing into the
render, so it is cropped first; a prompt that reads as *editing* is refused
with "`ratio` must be `adaptive`"; `first_frame` cannot mix with reference
media and forces the output ratio, which is why frames mode pins framing but
interpolates motion (`SEED_EXPAND_MODE=frames`).

**Not yet in the panel or After Effects.** It is a script, deliberately: the
agreement is to get the look right offline first. Two things remain unmeasured
— margin motion is Seedance's reading of the move rather than a tracked match,
and drift has not been checked frame by frame.

## Added 2026-08-27 — Premiere presets, settable from the panel

Premiere's export presets are per-install `.epr` files: Premiere makes them on
your machine and none can be shipped. `SEED_PPRO_VIDEO_PRESET` gates clip
capture entirely — without it the button is hidden — and on an installed copy
there is no `.env` to put one in, so the feature was unreachable.

All three (`STILL`, `VIDEO`, `QUALITY`) are now in the panel under a **Premiere**
group, as file settings rather than text: the row offers **Choose a file…**,
which opens the host's own dialog through `pickFile` — a function both host
scripts already had. Transcribing a path by hand is how a working preset
becomes a typo.

**Correcting an earlier claim in this file's history:** "Premiere works" was
asserted from reading the manifest. Measured properly, 16 of the 22 host
operations the panel calls exist in `seed-host-ppro.jsx`, including the whole
core loop — context, capture frame, capture range, pick-up, import, insert at
playhead, and the placeholder flow. The 6 missing are regions and look rigs,
which are nested-comp concepts Premiere does not have, and the panel already
hides that section outside After Effects.

**Nobody has run the panel in Premiere.** Same status macOS had this morning.

## Added 2026-08-27 — keep the 4:4:4 master, preview a proxy

`mov` stays the default and stays the deliverable. At ingest the service now
writes a small 4:2:0 H.264 companion beside it in `proxiesDir` — a folder that
had been declared in the workspace layout since the beginning and never used —
and the panel asks for `?variant=preview`, which the service answers with the
proxy for a 4:4:4 master and the original for anything already browser-safe.
The panel needs no knowledge of codecs.

The proxy is disposable by design: derived, never an asset, absent from
lineage, and deleting the folder costs one re-encode.

**ffmpeg ships with the companion** (~79 MB, so the installer is now ~170 MB).
An artist has no ffmpeg on PATH and should not have to acquire one. Resolution
order is `SEED_FFMPEG` (what the companion sets) then PATH, and every failure —
no binary, an unreadable codec, a timeout — returns nothing rather than
throwing. A missing preview must never fail an ingest for a clip that is
already generated and paid for; the card falls back to the poster.

Tested against a real master rather than a stand-in: a generated H.264 High
4:4:4 Predictive `yuv444p10le` file, with `ffprobe` asserting the proxy comes
out `yuv420p`. An ordinary mp4 would have proved nothing, because an ordinary
mp4 already plays.

## Confirmed 2026-08-27 — the panel runs on macOS

Reported from a Mac: the panel loads, the service runs, **Capture, Import and
Insert at playhead all work**. That is the host bridge confirmed on the platform
nobody had ever run it on, and it retires the largest unknown in the project.

Three defects came with it, all of them Windows-blind:

- **The settings gear was invisible.** `&#9881;` at 9px in a font stack of MS
  Sans Serif / Tahoma / Segoe UI — none of which exist on macOS. It was the only
  way to enter an API key. Now a **Keys** button, in words.
- **Nothing said why Generate did nothing.** The obvious guess, an empty
  provider list, was wrong: the film look needs no credential, so a keyless
  install reports one provider that can only *treat* a frame. The tab now says
  so, with the button that fixes it.
- **The settings dialog had two layout bugs** — group headings that never
  rendered (`SectionLabel` is absolutely positioned and had no positioned
  parent) and a Save button off the bottom edge (`min-height: auto` on a flex
  item, and `place-items: center` sizing the grid row to its content so
  `max-height: 100%` constrained nothing).

Also from that session:

- **Video previews no longer show an empty box.** Seedance's default `mov` is
  4:4:4 and no browser opens it; the card now falls back to the clip's own
  poster and says "Plays in After Effects, not here". `SEEDANCE_OUTPUT_FORMAT`
  is settable from the panel for anyone who wants an mp4 that previews.
- **Generated media has a home you choose.** The companion's workspace was
  hardcoded inside its own data folder. It now has a folder picker, remembers
  the choice, falls back if the drive is gone, and is verified against a path
  with spaces in it.
- **Premiere needed no work.** The manifest already declares `AEFT` and `PPRO`,
  and the CEP folder is shared, so one install serves both.

## Added 2026-08-27 — an installer, so an artist never opens a terminal

`apps/installer` is an Electron companion called **SEED**. It installs the CEP
panel, asks once for permission to load an unsigned extension, runs the service,
and shows whether it is up. Everything an artist does still happens in the panel.

**Verified on Windows, end to end, including from the packaged build:** a real
NSIS installer (94 MB) builds; the packaged app installs the panel into Adobe's
folder, writes a token into it, starts the bundled service, and the token
authenticates (200 with it, 401 without). **Nothing has been verified on macOS.**

What made it simple, and it is worth writing down: **Electron 42 carries Node
24.18.1, and `node:sqlite` with it** — measured on this machine, not assumed. So
the service runs on the binary already present. No vendored runtime, no native
module, no ABI to keep in step, and none of the `asarUnpack` or `extraResources`
machinery harness-workbench needed. The bundled service is 1.4 MB.

Two traps avoided by reading harness-workbench first:

- **The app name is pinned** (`app.setName("SEED")`). Electron derives its data
  directory from the name and resolves it differently packaged versus from
  source, which presents as every asset having vanished. Confirmed here: it read
  `@seed-ae/installer` before the pin and `SEED` after.
- **The macOS build is ad-hoc signed** (`identity: '-'`), not unsigned. Apple
  Silicon refuses to run arm64 code with no signature at all, and the failure
  reads as "the application is damaged".

Also new: `.github/workflows/ci.yml` — the first CI this repo has ever had. It
typechecks, tests and builds the companion on **both** Windows and macOS, and
boots the bundled service to prove it answers `/health` on each.

## Added 2026-08-27 — credentials from the panel

`GET/POST /v1/settings`, and a gear in the title bar. Twelve settings — the
ones a fresh install needs, not the whole of `.env.example` — are settable
without a text editor.

Three properties worth keeping:

- **No route returns a key.** `GET` answers with whether a setting is set,
  where it came from, and the last four characters of a secret. A test asserts
  the stored value appears nowhere in the response body.
- **A save takes effect immediately.** The provider registry is refilled in
  place (`ProviderRegistry.replaceAll`) rather than swapped, because
  `GenerationService` captured that object at construction — a new registry
  would leave generations resolving against the old set. The test proves
  Seedream comes online after a save with no restart.
- **Panel beats `.env`, and says so.** The alternative makes a key typed into
  the UI silently do nothing.

Stored in `~/.seed-ae/credentials.json`, mode 0600, deliberately outside the
workspace: a workspace gets zipped and handed to other people.

## Unmounted 2026-08-27 — the ROO tab

**ROO is no longer a tab in the panel.** Nothing behind it was deleted:
`RooView.tsx` is whole, `/v1/switch` and the passes routes still answer, and
their tests still run. Only the four lines in `App.tsx` that mounted it are
gone, so the panel now shows *generate, items, library, lineage*.

The reason is scope, not failure — the feature is parked while the panel stays
narrow. Restoring it is putting `"roo"` back in the `Tab` union, in the default
`visibleTabs`, and re-adding the render block. `docs/product/ROO_TEST.md`
describes the tab as it will be again, not as it is today.

Expansion needed no removal: it left the panel on 2026-08-24 and now exists
only as `scripts/expand-shot.ts`.

## Withdrawn 2026-08-24 — aspect expansion

**Everything SEED built for aspect expansion is deleted** — `/v1/expand/*`, the
Expand tab, the mosaic, alignment and letterbox modules, and the host functions
that sampled a comp and assembled a plate. It is preserved at the tag
`expand-attempt-1` and nowhere else. ADR 0018 records why; the short version is
that it failed on the footage it was built for, and was written up as working
before anyone had run it end to end in After Effects.

`ReframeProvider` is again the only expansion route. Nothing replaces the rest
yet, deliberately.

**Switching the scene by measurement** (`POST /v1/switch`) is unaffected and now
lives in its own file, `apps/service/src/routes/switch.ts`. Beeble's SwitchX —
generative, shipped February 2026 — does this job by inference. SEED solves the
reference's lighting onto the subject's own normals and composites through a
matte derived from measured depth, so nothing about the subject is
resynthesised. Returns render *and* matte, and reports a lighting residual when
the reference needs light nine harmonics cannot express. See ADR 0015.

**Beeble SwitchX has been removed** as a provider (ADR 0016), on the grounds
that keeping a paid provider beside a better free one only asks the artist to
know the difference. `FAL_KEY` still matters — IC-Light stays.

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

## Video references — reskinning a shot (2026-08-13)

Video-to-video works end to end, verified through the service on a real
generation: a clip in the library, a prompt, and a result 640x640 and 6.042s —
exactly the reference clip's shape and length — registered with lineage back to
it. See `docs/product/VIDEO_REFERENCES.md` for the artist-facing version and
ADR 0009 for the hosting decision.

Three pieces were missing and are now built:

- **`R2Publisher`** (`packages/providers/src/publish/`). Private bucket, SigV4
  header auth for the PUT and query auth for a presigned GET, content-hash
  keys. `scripts/probe-r2.ts` verifies a bucket: signed PUT, anonymous
  presigned GET returning identical bytes, unsigned GET refused, delete.
- **A clip out of the timeline.** `Capture work area as clip` renders the work
  area to H.264 through the render queue — leaving anything already queued
  alone — writes a poster frame beside it, and registers both as one asset.
  `POST /v1/assets/adopt` is the manual half: any file on disk, from any
  application, copied into the library and registered by what its bytes
  actually are.
- **The rules a clip brings with it.** Ark reads a request carrying a
  `reference_video` as *video editing* when the prompt describes a change to
  the clip, and then refuses to be told the length or the shape: `duration`
  must be `-1` and `ratio` must be `adaptive` (or both simply absent, which is
  what SEED sends). When the prompt describes a new shot, an ordinary duration
  and ratio are accepted — measured both ways, six live runs. So the panel
  defaults rather than dictates: silence follows the clip, asking is allowed
  and may be refused. The clip itself must be 4–30s, which the panel checks
  before offering Generate.

A clip can never be a first frame, at either layer: the service will not give a
video a frame role and the adapter will not put one in an `image_url` part.

**Verified inside After Effects (2026-08-13).** A work area rendered through
the render queue, registered with a real poster, and generated from. Two faults
were found by running it that no test would have caught:

- The host wrote the poster and checked for it once, immediately —
  ExtendScript's `File` caches what it knew at construction, so the check
  answered a stale "no" and the path was dropped. It retries now, and hands the
  path over regardless, because the service waits better than a blocked host
  can. The poster is also recorded as `source.posterUri`, so a thumbnail that
  fails to be written is recovered on the next start.
- The panel asked for a thumbnail that did not exist, which falls back to the
  media — downloading a whole mp4 to put in an `<img>` and render the browser's
  broken-image glyph. A clip with no poster now says "video" and fetches
  nothing.

And one rule, from a real failed generation: a duration or ratio that merely
restates the clip is now dropped rather than sent. Typing "4" next to a
four-second clip is the obvious thing to do and Ark refuses it, twenty seconds
into a running task, to produce what saying nothing would have produced.

## Known gaps

- **Video posters are extracted by the panel.** The service has no decoder;
  Chromium does, so a clip with no poster is drawn from its own first frame in
  the panel and posted back to `/v1/assets/:id/poster`. Borrowing the source
  frame survives only as the fallback, which matters because a reskin's
  borrowed poster showed the very thing that was reskinned. Best-effort: a
  codec the browser will not open leaves the card saying "video".
- **Image references now travel as links, not base64.** `ARK_REFERENCE_POLICY`
  is `hosted` / `hosted-or-inline` / `inline`, verified live with the strict
  option: the stored request carries a bucket URL and no data URL anywhere.
  The `asset://` route ADR 0005 was built on does not exist for images — see
  ADR 0010 — but it *is* the accepted form for video references, and the asset
  library is kept for that.
- **Region of Interest silently halves a capture.** Detected and warned about
  now, but not prevented: AE has no scripting API to read or clear it.
- Thumbnails cover PNG and JPEG. WebP has no decoder and degrades to none.
- Video dimensions and duration are read from the MP4 sample description at
  ingest, so a generated clip knows its own size. A poster frame still is not
  extracted — image-to-video results borrow the thumbnail of the frame they came
  from, which is honest but not a real extract.
- Interrupted jobs are resumed on startup rather than closed out: a task that
  reached the provider is still running there, and the process that died was
  only the one listening. A job with no provider task, or whose provider is no
  longer registered, is still failed as interrupted.
- Audio references are declared and unusable in practice: the part shape is
  right and Ark accepts it, then refuses the finished render as possibly
  copyrighted — measured with a synthetic tone, so it is not recognising a
  song. The panel says so before Generate rather than after.

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
   plate, and later the animated clip on top of it. Created on first capture and
   reused after, so anything the artist builds inside it survives.
3. **A composite layer** in the plate comp holding that sub-comp, feathered.
   Because the sub-comp's background is the captured plate, the feathered edge
   fades into pixels identical to the plate underneath, which is what makes the
   join invisible.

The sub-comp holds the *capture*, never the plate comp itself — a comp cannot
contain a comp that contains it.

Feather, start time, and a stretch-to duration are all panel parameters. The
plate is never modified: the composite can be retimed, replaced, or deleted
without rebuilding anything.

### A region that follows a moving guide

A guide is an ordinary layer, so it can be keyframed, parented to a tracker or
driven by an expression. Until now the region was a rectangle read once at the
playhead, which is why the plate underneath had to hold still.

Now, when the guide moves, two things follow it — both by expression rather
than baked keyframes, so a re-track or a nudged keyframe is picked up without
capturing again:

- **The capture window.** The plate sits inside the temporary comp offset so
  the region lands in the middle; that offset now travels the opposite way to
  the guide, because sliding the window right is the same as sliding the
  picture left. It references the plate comp by name, since from inside the
  temporary comp the plate is a *layer* and not `thisComp`.
- **The finished insert.** The composite goes back where the region is, frame
  by frame, instead of sitting where the guide happened to be at capture time.

Position is read with `toComp` rather than off the Position property, because
a guide parented to a tracker has a static position and a moving parent —
which is the most useful way to animate one, and exactly the case reading
Position gets wrong.

Every expression is wrapped in a try/catch that falls back to `value`. An
expression error in After Effects disables the property and drops the layer to
the origin, which is a spectacular failure for a renamed guide.

**Only the position follows.** A sub-comp cannot change size over time, so a
guide that *scales* during a shot still captures at the size it holds at
capture. That is a real limit, stated rather than half-implemented.

A locked-off guide gets no expression at all and behaves exactly as before.

### Capturing a region that moves

**Capture region** takes the playhead as a still. **Capture region as clip**
takes the *work area* as video, and is the one to use over moving footage: a
still frozen out of a shot that pans stops matching one frame later, and every
generation made from it inherits the mismatch.

Both routes frame the region with the same temporary comp — After Effects can
only write a whole composition, so the plate comp goes inside one sized to the
region and offset so the region centres. The temp comp's timeline maps one to
one onto the plate's, which is what lets the clip render `[start, duration]`
there and get exactly the frames that span covers below.

The clip renders through the render queue, so it shares one implementation with
the work-area capture (`seedRenderRange`) rather than a second copy that
drifts: other queued items unqueued and put back, render settings applied
before the time span, the span set in three steps, and every written file
re-stated through a fresh `File` because ExtendScript caches `exists` from
construction. A poster is written beside it — there is no video decoder on the
SEED side, and a reference clip nobody can recognise in a grid is a reference
nobody picks.

In the sub-comp the clip is offset to the work area's start, so the region
plays in step with the plate underneath instead of drifting by exactly that
start. A still stays at zero and holds across the whole comp, which is what
keeps the feathered edge fading into identical pixels everywhere.

The result registers as a **video** asset and attaches as a reference, which
means Ark reads the request as video editing: length and shape come from the
input clip and the panel replaces those controls with what will happen. The
clip itself has to be 4–30s for Seedance to accept it — a work area outside
that range is a capture that generates nothing, so check it before rendering.

**Not yet exercised in After Effects.** This is ExtendScript: it cannot be
typechecked or run by the suite, so nothing above is proven until it has been
run in the application.

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
correct range and ignores it for a *single frame*, so it is a last fallback
there.

For a **range** the picture reverses, verified in the application on
2026-08-15: `exportAsMediaDirect` answers "Unable to initialize export!" to
every combination of preset, path and work-area constant, while Media Encoder
honours in/out exactly — a marked span came back 6.006s at 1920x1080. So
`Capture in-to-out as clip` encodes through AME and keeps the direct exporter
as its fallback.

Two traps cost a round each, both worth remembering. Adobe's factory `.epr`
presets are a *different format* from exported ones and `exportAsMediaDirect`
refuses them; discovery now requires the shape Premiere's own Export Settings
dialog writes, prefers H.264, and falls back to HEVC only while saying so. And
an ExtendScript `Folder` caches its directory listing the way a `File` caches
`exists` — the clip rendered correctly into the watched folder and the poll
loop, re-reading one stale listing, never saw it.

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

Both hosts preserve the artist's work on the clip. After Effects uses
`replaceSource`. Premiere uses `changeMediaPath`, which is Replace Footage: the
media under the project item changes and every sequence keeps its effects,
masks, keyframes, transitions and speed, because the clip itself is never
touched.

The catch in Premiere is that `changeMediaPath` acts on the *item*, so it is
only correct when that item belongs to a single clip. SEED counts the uses
across every sequence first. One use is the normal case for a SEED clip — the
reserve/fill flow gives each reservation its own item — and takes the swap.
More than one falls back to overwriting the clip's span, which loses effects,
and the panel says so at the moment it happens rather than leaving it to be
discovered when the render lands.

The fallback cannot be made lossless: Premiere's scripting API has no way to
clone a clip with its effects, adding an effect at all requires the
undocumented QE DOM, and masks are not exposed to scripting in any form. Only
the scale is carried across by hand.

Recipes were lossy until now: `durationSeconds`, `aspectRatio`, `generateAudio`
and `inputRoles` were never returned, and the last two were never stored at
all, so a reopened video recipe quietly changed length and forgot which
reference was the end frame. Both halves are fixed and covered by tests.

## Film look

P1 of ADR 0008 is built. The engine is `packages/filmlook` — 66 parameters,
five stocks, four presets, both phases in the specified order — and it runs as
`LookProvider`, an ordinary provider that needs no credential and reaches no
network. A look is therefore a generation: it has a job, a recipe, a lineage,
and it can be reopened, branched and iterated on with the flows that already
exist.

It runs as `image.edit` rather than an operation of its own. An edit is exactly
what it is, and inventing a fourth operation would have meant touching the
domain enum, the router and every switch over operations to say something the
existing one already says.

Verified against the live service on a real 1774x1774 library frame: about ten
seconds, registered as a child of its source, source untouched. The numbers
read the way the preset says they should — red mean pulled down and green and
blue lifted, which is the show stock's 0.85 global desaturation acting on a
red-dominant image; highlights compressed; a black centre pixel lifted to 7 by
grain; corners darker than centre from the vignette.

**Not yet compared against the reference renderer.** That needs a frame from
the original pipeline, which we do not have. `FILM_LOOK_FIDELITY.md` records
which stages are transcribed exactly from the specification and which are
interpreted from a description, so that comparison starts from what is known.

**236ms for a 1080p frame** (measured 2026-08-18 by `test/bench.cpp`), down
from 932ms, with the parity vectors unchanged — worst pixel difference
0.00000064, far inside half a code value.

Two things were wrong and neither was the arithmetic. The vertical box blur
walked column-major, so every step moved a 30KB stride through memory and
essentially every access was a cache miss; rewritten to run in row order with
running sums held for a band of columns, it reads and writes sequentially. And
nothing was threaded at all: blurs and every per-pixel pass now split across
workers, capped at 16 because the host may already be rendering other frames.

Ten seconds of 24fps is now about 57 seconds rather than fourteen minutes. Good
enough to grade a shot; still not real time, so ADR 0008's GPU path remains the
answer for playback.

## Known-good demo path

Verified end to end at the time of writing:

1. Capture a frame — After Effects natively, Premiere through
   `sequence.exportFrameAsPNG`.
2. Direct the shot — about 15 seconds, references stay as chosen.
3. Generate — space is held in the timeline at the right shape for the
   duration asked for.
4. The render swaps in underneath, scaled from its real dimensions.
5. Pick a variant, composite into a region, or insert at the playhead.

## Items — the consistency layer (2026-08-17)

Built end to end. An **Item** is a named identity that must look the same across
shots: a character, a location, a prop, or a **look**. Write `@sara` in a prompt
and the service expands it into that character's reference plates plus a compact
materials manifest, records the exact revision it used, and shows the artist
what it did before anything is generated.

```
Item        @sara               identity — handle, kind, real-person state
 └─ Variant @sara/red-coat      a deliberate alternate state
     └─ Revision  rev 3         immutable; what a generation records
```

An item is mutable and a revision is not, enforced by trigger. A shot generated
against revision 2 reopens as revision 2 whatever the character has become
since — the failure that video recipes already hit once, when they dropped
duration and roles and quietly changed length on reopen.

**What an item contributes to a prompt is binding, not description.** The plate
carries appearance better than a sentence, and Runway states the principle
outright — references define who the character is, prompts define what happens
to them. But Ark requires the mapping to be written in
(素材映射关系必须写进提示词), including what must *not* be taken from each
reference, and nothing else can carry that. So an item emits a materials
manifest derived from its plate roles, and grows it with drift-prone traits only
as plates are lost to the budget. It scales with the number of materials, not
with how much personality anyone wrote down.

- **`packages/items`** — the resolver. Pure: no network, no database, no Adobe,
  and no provider ids. Per-model behaviour arrives as declared
  `ReferenceCapabilities`, so the package stays liftable into a studio service.
- **Round-robin allocation, never depth-first.** Three characters and a budget
  of three gets one plate each; the alternative leaves two characters named in
  the prompt with no reference at all.
- **Budgets build against the stable range, not the maximum.** Seedance
  validates 30 and 64; the published working range is 1–8.
- **A first or last frame drops every plate** and raises every item to full
  text, because Ark will not mix frames with references.
- **Items map onto Ark's own concepts.** An Asset Group is documented as the
  several references of one character — which is an item — and `asset://` ids
  are permanent and free to register. A plate holds both that id and a hosted
  URL, because `asset://` is video-only.
- **Real people are a state, not a flag.** A real likeness needs the subject's
  own liveness authorisation; a generated character needs none.
- **Item Packs** — `item.json` plus content-addressed media, committable to a
  show's repo and readable without SEED. They never carry `asset://` ids:
  exporting a character must not export the ability to impersonate someone.
- **The standalone tool** is the same bundle behind a second Vite entry
  (`items.html`), with the generation tabs left out.
- `npx tsx scripts/item.ts resolve "wide of @sara in @bar"` prints exactly what
  a prompt would send, and spends nothing.

Research behind it: `docs/research/CONSISTENCY_PLATFORMS.md`. Decision: ADR
0011. Product spec: `docs/product/ITEMS.md`.

**Not yet measured:** whether these models actually hold an identity given N
plates. The system guarantees identical inputs; retention is the model's
behaviour. The probe list is in `CONSISTENCY_PLATFORMS.md` §15 and no UI copy
claims consistency before it has numbers.

## Video output quality — measured, and mostly a correction (2026-08-17)

`scripts/probe-output-format.ts`, against the live API, free (every request
carries a duration the model refuses so validation always fails):

| Parameter | Verdict |
|---|---|
| `bitrate_mode` | **real** — `standard` / `high`; now defaults to `high` |
| `return_last_frame` | **real** — a genuine PNG from the provider |
| `output_format` | **does not exist**, in t2v or i2v |

So there is no 4:4:4 MOV output and the chroma finding stands: 4:2:0 is what
Seedance delivers. The adapter had been sending `output_format: "mp4"` for
months — a no-op that looked like a decision — and it is gone.

Render profiles now choose by what a clip is **for**. `delivery` stays in a
codec Ark accepts (H.264/H.265) and is the default; `quality` prefers ProRes
4444 for a clip that stays local. A ProRes reference is not a better reference,
it is a rejected one.

## Bit depth, end to end (2026-08-20)

Raising a project above 8 bpc — which the quality work asks for — changed what
comes out of `saveFrameToPng`, and two things downstream were not ready for it.

**After Effects writes 16-bit PNGs from any project above 8 bpc.** `decodePng`
accepted 8 only and returned `undefined`, so every capture from a 16 or 32 bpc
project produced no thumbnail: a black card in the library, indistinguishable
from a genuinely black frame. It also silently disabled the partial-render/ROI
warning, which shares that decoder. Both read again; the decoder unfilters on
the byte stride and narrows by keeping the high byte of each big-endian sample.

**A deep capture is narrowed before it is sent to a provider.** A 5750x2818
frame is 14.21MB as 16-bit and 3.97MB as 8-bit. Narrowing happens at
materialisation and is a *format* decision only — nothing resizes or crops,
because what a provider accepts at the top end has not been measured here and
guessing a ceiling would silently change what the artist framed.

The rest of the chain was already correct, and is recorded here so it is not
re-audited:

| stage | depth | correct? |
|---|---|---|
| `encodePng` | 8-bit | yes — thumbnails only |
| plugin input, AE 8-bit | `/255` | yes |
| plugin input, AE 16-bit | `/PF_MAX_CHAN16` | yes — AE's 16-bit is 0..32768, not 0..65535 |
| plugin input, AE 32-bit | raw float | yes — no clamp, superwhite survives |
| plugin output | matches input depth | yes — clamps only where the format demands it |
| core look engine | float throughout | yes — `Clamp01` is used on a mix amount, never on a pixel |

### Settled: a 32 bpc project captures at a tenth of scale

Measured 2026-08-22 across two unrelated comps, one of them a firework against
black with near-white sparks in it. `saveFrameToPng` from a **32 bpc** project
writes the frame at almost exactly a tenth of full scale — the brightest
sample lands at 25 of 255, twice, on completely different material. The same
frame at **16 and at 8 bpc is correct**.

So it is float specifically, not depth in general, and not the comp. The
bright-content case is what ruled out the "it is just a dark shot" reading
that this section carried for three days.

**The fix is not to guess at the factor and multiply it back.** Two data
points is not a contract, and a capture silently scaled by a number we
reverse-engineered would be worse than one that is honestly wrong. Instead
`seedCaptureDepthGuard` drops the project to 16 for the duration of a still
capture and restores it in a `finally` — every still route does this: the
frame capture, the region still, and the clip's poster.

16 rather than 8 costs nothing: PNG carries it, the library reads it since the
16-bit decode landed, and a reference is narrowed to 8 on its way to a
provider anyway.

The capture result reports `capturedBitsPerChannel` alongside
`projectBitsPerChannel`, because those are now allowed to differ and a
provenance record that hid the difference would be a lie.

**Still unknown:** *why* After Effects does this. A tenth is suspiciously
round, and nothing in the colour management recorded alongside the captures
(`workingSpace: "None"`, `workingGamma: 2.4`, `linearBlending: false`)
explains it. Worth asking Adobe rather than reverse-engineering.

## Next engineering actions

1. Wire `scripts/expand-shot.ts` into the panel and After Effects, once the look
   is signed off. The rule from ADR 0018 still stands: do not report it as
   working until a shot is finished, in the application, and looked at.
2. Exercise iterate-in-place in Premiere. It is built and has never replaced a
   real clip there; After Effects has.
3. Decide whether video references should register as Ark assets rather than
   travel as links. Both work; the asset id is permanent and costs 10-30s of
   registration before the job starts, the link costs half a second and expires.
   Currently links, which is what a demo wants.
4. Film look on video needs the GPU path — ADR 0008's open half. 3.4s a frame
   on the CPU is fourteen minutes for ten seconds of footage.
5. Milestone 5 continued: the direction agent plans but does not act. Tool use
   and an execution loop stay gated behind the rule in ADR 0007 — the agent
   proposes, the user approves anything destructive.

## SEED can drive After Effects now, and the GYG build is the first real test

The panel bridge gained a direction it never had: a service-side queue the
panel long-polls, so something that is not a mouse can run a named operation
in the host. A command is a name and typed arguments, never a script, refused
at both ends. See ADR 0021 and `host/commands.ts`.

Eighteen operations are on the allowlist. Reading a build apart — `compTree`
with `pixelRatio` per part, `projectComps`, `layerBounds` — and changing one:
`setActiveComp` (which everything else depends on, since twenty-two host
functions resolve `activeItem` and nothing could set it), `precompose`,
`addSolid`, `applyEffects`, `setLayerEnabled`, `insertIntoComp`,
`repeatToFill`, `regionFromLayer`, `setLayerSolo`, `replaceFootage`,
`saveVersion`, plus `captureRegion` and `insertRegion` which existed and were
unreachable.

**Six are smoke-tested in After Effects 26.0** — ping, setActiveComp,
layerBounds, setLayerEnabled, addSolid, applyEffects. The rest are written and
unrun, which per ADR 0018 means written. That is the next thing to fix, and it
needs a scratch comp rather than the artist's project, because there is no
delete-layer command to clean up after a test.

### What the GYG projection taught us

`ANUAL_SUMMIT.aep` is a 6688x1912 arcade assembled from six entity sub-comps,
each one the same shape: a Seedance clip repeated to fill thirty seconds over
a disabled PSD still and a disabled green solid. Nothing in it is
under-resolved — every clip runs 2.0-4.2 source pixels per screen pixel, which
is where `tierFor` gets its 2x target from. One real defect found by reading
it: `Cafe01` is scaled 23.72/21.45, a non-uniform squash from forcing a 3:4
clip into a 0.81 hole, which is why `insertIntoComp` defaults to `cover` and
makes `stretch` something you have to name.

`docs/research/SEEDANCE_2_0_COST_AND_STYLE.md` records what 150 jobs on this
account actually cost — the meter is ~1017 pixels per token — and the house
prompt recipe, now in `packages/domain/src/animate.ts` with a test per clause.

### Alpha without a keyer

`media/floodMatte.ts` reads the backing as a connected region rather than a
colour, so artwork that happens to be green survives and backing trapped
behind the subject does not. ProRes 4444 out, no keying effects on the AE
layer. Verified on a real clip.

Its one honest cost is in the suite as a test: artwork painted in *exactly*
the backing colour is removed. Picking the backing per element — the colour
furthest from that element's own palette — is the open follow-up, and it
matters on a street full of foliage.

## Four entities built end to end (2026-10-12)

`GYG_Sides-Right_v001` — the cleaned re-layout, 6688x1912, 28 flat PSD layers,
all at native size. Four elements taken from still to looping thirty-second
precomp without leaving this session:

| comp | element | clip | on screen | oversample |
|---|---|---|---|---|
| `Mariachi01` | 564x421 | 1664x1248 | 564x421 | 2.95x |
| `PartyCrew01` | 952x513 | 1920x1080 | 952x513 | 2.02x |
| `CafeFriends01` | 758x423 | 1920x1080 | 758x423 | 2.53x |
| `TacoDate01` | 354x379 | 1440x1440 | 354x379 | 4.07x |

The shape of each, which is now the house pattern:

1. `precompose` the single PSD layer with **`moveAllAttributes: false`**. That
   is the "leave all attributes" option, and it is what sizes the new comp to
   the element instead of to the 6688-wide parent; placement stays outside.
2. `captureFrame` with no backing, to read the element's palette.
3. Pick the backing colour by measuring (below), `addSolid`, capture the plate.
4. `animate` — Seedance 2.0, 1080p, 10s, `aspectRatio: "adaptive"` so the
   clip follows the element rather than a forced tier shape.
5. `matte` to ProRes 4444 with real alpha. No keying effects on the layer.
6. Three `insertIntoComp` calls at 0s, 10s and 20s.

### Why three inserts and not `repeatToFill`

A ten-second clip at 24fps is **241** frames, and with `flf2v` the last frame
is the first frame again — measured seam 1.59 to 2.49 mean levels against a
median adjacent-frame step of 0.93 to 13.9. Laid end to end that duplicate
holds a frame at every join. Started at 0/10/20s instead, each copy's first
frame lands on top of the previous copy's duplicate last frame and covers it:
720 unique frames, no hold. `repeatToFill` is still right for a clip whose
ends differ.

### Choosing the backing by measuring, not by habit

Chebyshev distance from a candidate backing to the nearest artwork pixel:

| element | green | blue | verdict |
|---|---|---|---|
| mariachi | **127** | — | green |
| party crew | 70 | **100** | blue |
| cafe tables | 82 | **127** | blue |
| taco date | **54** | **82** | blue |

The taco date settles it: 54 is inside the matte's default tolerance of 60
before a single frame exists, because the man wears green shorts. This is the
"backing per element" follow-up, closed — see `BACKDROPS` in
`packages/domain/src/animate.ts` for why blue and not violet.

### What the clips measured

All four hold the design, keep the camera locked off and show no scale or
position drift. Loop seams are 5x to 9x *smaller* than one frame of ordinary
motion. Backdrop corner spread 7 to 13 levels across every frame.

One soft spot, not yet acted on: `CafeFriends01` has **59 of 240** frames
where under 0.2% of pixels move, against 13 for mariachi. Eight characters at
two tables is the most crowded of the four and the model held more than it
animated. Worth a re-roll if it reads as stuttery on the wall.

## Eight cycles, and the margin every element was missing (2026-10-12)

Second pass on `GYG_Sides-Right_v001`. The party crew redone, plus seven new
elements, all but one of them a **cycle on the spot** so the artist drives the
movement himself with a Position keyframe.

| comp | element | tier | backing | note |
|---|---|---|---|---|
| `PartyCrew01` | 952x513 | 1080p | blue | redo: dancing, out of step |
| `Car01` | 875x441 | 1080p | green | wheels spinning, body still |
| `DeliveryCyclist01` | 378x451 | 720p | **magenta** | green bike AND green backpack |
| `WomanWalking01` | 244x433 | 720p | blue | walk cycle on the spot |
| `Waiter01` | 335x380 | 720p | blue | two cycles, with and without tray |
| `WindowWorker01` | 166x170 | 480p | green | idle cycle + give-bag cycle |

### The tray-less waiter

He swaps behind a column, so the two cycles must match in scale or he jumps.
Seedream removed the tray but reframed him — smaller, feet together, stride
gone. A sharper prompt kept the stride; the scale was then fixed by
measurement rather than by eye: both figures' bounding boxes were measured,
the edit scaled by the ratio of their heights and translated so the feet
coincide, then cropped back to the plate's exact size
(`scratchpad/align.mjs`, pattern worth keeping).

### Every element was touching its own frame

Eleven clips checked along all four edges across all 241 frames. **Eleven
hits.** Five badly: the car's bumpers cut flat across 60% of the left edge and
43% of the right; the cyclist losing both wheels at 21% and 24%; three heads
flattened at 19-26% of the top edge.

It is structural, not a model failure: a plate captured from a PSD layer IS
that layer's bounding box, so the artwork is tangent before anything is
generated. Invisible while the element sits where the artwork was; a straight
line across it the moment the layer is translated.

Fixed by padding the plate 12% per side with backing colour and asking the
model to keep the margin (`KEEP_MARGIN`). Re-measured after: **0% on all four
edges, all five clips.** The prompt clause is load-bearing — without it the
model composes to fill the frame and the padding is wasted.

The model keeps less margin than it is given (12% in, ~5% out), so the element
comes back smaller than the artwork and the precomp layer needs scaling in the
parent to restore it: Car01 110%, DeliveryCyclist01 112%, WomanWalking01 144%,
Waiter01 121%. A `setCompSize` host command that resized the comp and
compensated the parent anchor would remove that step.

### Negative instructions backfire

The first party-crew redo said *"no raising glasses together, no group cheer"*
and the model read it as *lower the glasses*: everyone dropped their arms and
stood around. Re-rolled with the same intent phrased positively — *"arms and
drinks stay up above head height"*, *"each keeps their own tempo, so they are
always out of step"* — and it held. Say what should happen, not what should
not.

## Next engineering actions, continued

6. Smoke-test the remaining host operations against a scratch comp, and add a
   `deleteLayer` so a test can clean up after itself.
7. ~~Choose the matte backing per element from the artwork's own palette.~~
   Done — measured per element, `blue` added to `BACKDROPS`.
8. `replaceFootage` cannot address one layer of a layered PSD — Adobe document
   no call that does. A PSD re-version is a manual relink until measured
   otherwise.
9. The remaining elements of this side: the delivery cyclist, the walking
   woman, the takeaway worker, the drive-thru window, the clouds and the car.
10. `saveVersion` writes a new file and After Effects then works in it. After
    the first call the open project is no longer `ANUAL_SUMMIT.aep`.

## The left-hand side of the arcade, given wind

`GYG_Sides-Left_v002`, comp 1081, 6688x1912 at 24fps, 30s. Forty layers,
seven arches. Nineteen of them now carry a Wave Warp; nothing was generated
and nothing cost anything.

Three shapes of wind, all from `packages/domain/src/buntingWeave.ts`:

| group | layers | direction | pinning | what it does |
|---|---|---|---|---|
| bunting, papel picado | 7 | 90 (lift) | none | strand lifts as one piece |
| clouds | 2 | 0 (drift) | none | whole bank slides together |
| flag | 1 | 90 (lift) | left edge | hoist held, fly ripples |
| trees, shrubs, crops | 9 | 0 (sway) | bottom edge | roots held, canopy sways |

Measured on what shipped: the flag's hoist travels **0.19 px** against the
fly's **3.99 px** — it stays on its pole. The eucalyptus canopy travels
**7.31 px** against **2.69 px** at the trunk. The lettuce bed, **2.00 px**
against **1.36 px**. Bunting peaks at 2.5 px with **0.99 px** of shear
across one 60 px pennant, which is calmer than the 2 px that was approved on
the right-hand side.

Speeds are co-prime cycle counts over the 30 s loop — three for the trees,
five for the bushes, seven for the ground crops, fifteen for the flag — so
the garden only ever re-synchronises at 0 s and 30 s, which is exactly where
it must. Every speed is a whole number of cycles over the duration or the
loop would not close.

### The pinning table was wrong, and so was the probe

See `docs/research/WAVE_WARP_PINNING.md`. Short version: `layerBounds` asks
for `sourceRectAtTime` with extents, and that rectangle does not move when a
Wave Warp is applied at any amplitude — a 300 px warp on a 1316x1647 layer
returns byte-identical bounds. So the two earlier "measured" tables cannot
have been measured. Re-done from rendered pixels, all eleven values, all four
edges. `6` holds the **top** edge; left is `5`; **`8` holds the bottom**,
which is the one a tree needs and the one no previous version of the table
had.

Nothing had shipped against the wrong value — every strand on the right-hand
side is `none`.

### Left alone, deliberately

The truck and the aeroplane, because Johannes is animating those. The arcade,
the coastal panorama, the city block and the market street scene, because
they are the large areas. The signpost, the fences, the chicken coop, the
road, the murals and the logos, because rigid things that sway read as
rubber.

### Still generative, if wanted

Three elements on this side would need a model rather than a warp, because
the motion is articulated rather than a displacement: the farmer
(646x518), the chickens (257x163), and the crowd inside the market street
scene. The two cows are 41x32 and 68x51 — too small on the wall to repay it.


## The project shelf

The GYG project had 28 compositions and every piece of footage loose in the
root. Tidying it by hand would have lasted until the next import, so the shelf
is a function instead: `planProjectShelf` in `packages/domain` turns an
inventory into a set of moves, and `npx tsx scripts/tidy-project.ts` prints
the plan and does nothing until it is given `--apply`.

```
00_DELIVERY/      the comps that get rendered, newest version of each surface
10_ELEMENTS/
    Car01/
        Car01             the live comp
        01_source/        the PSD grouping it was precomposed from
        02_stills/        captured plates
        03_clips/         generated footage
20_GENERIC/       bunting, clouds, plates, solids, loose footage
90_ARCHIVE/       superseded versions, kept rather than deleted
SEED/             the host's import inbox, left at the root on purpose
```

Three host commands carry it out and decide nothing: **`projectItems`**
reports every item and where it sits, **`createFolders`** makes folders by
path idempotently, **`moveItems`** moves items into them and refuses one item
rather than failing a batch. `projectComps` could only ever see
compositions, which is half a project — the flatness an artist complains
about is mostly footage.

Re-running the plan on a sorted project asks for nothing, which is the
difference between a convention and an afternoon. Two bugs were caught by the
tests before it was pointed at a project: a placeholder called `Car01 pending`
was being filed as a still of `Car01`, hiding that a render was still owed,
and an element whose only item was its PSD grouping never got the folder above
it created. See `docs/decisions/0022-the-project-shelf.md` for what it
deliberately does not do — it never deletes, never guesses at a rename, and
never sweeps an item it cannot place.


## The chickens, the market street, and two things a scene does that an entity does not (2026-10-13)

Two elements on `GYG_Sides-Left_v002` taken from still to looping precomp:
`Chickens01` (257x163, green backing, 720p, 16:9) and `MarketStreet01`
(1494x1152, blue backing, 4K, 4:3). Both by the house recipe. The chickens
went through it unchanged. The street found two holes in it.

### Registering the clip by measurement instead of by hand

The right-hand side left four precomp layers needing a scale typed in by eye —
Car01 110%, DeliveryCyclist01 112%, WomanWalking01 144%, Waiter01 121% —
because the model keeps less margin than the padded plate gives it and nobody
measured how much.

It does not need a judgement. With `flf2v`, frame 0 *is* the plate, so the
alpha bounding box of frame 0 is the artwork's own rectangle however the model
chose to compose the frame. Crop to that box, scale to the element's exact
pixel size, insert with `fit: "none"`: both elements went in at 100% with
nothing to nudge. Measured on the chickens — the model placed the artwork at
866x547 inside a 1280x720 frame, which is a 1.7% margin where 12% was given.

### A model draws outside the silhouette, and the matte keeps it

`floodMatte` asks whether a pixel is the backing colour *and* connected to the
frame edge. That is the right question for a cut-out entity and the wrong one
for a scene with a sky.

The market street is 27% transparent — the sky above its rooftops. The model
filled that with a papel picado garland strung across the frame and a long
ribbon of griddle steam. Neither is the backing colour, so both survived the
matte as opaque artwork sitting in the region that has to stay empty, and both
would have composited over the arcade behind the arch.

The fix is free and exact: **the plate's alpha is authoritative.** Intersect
the clip's alpha with the still's (`blend=all_mode=darken` on the two extracted
alphas, then `alphamerge`) and everything the model invented outside the
artwork's own silhouette is gone. Measured after: edge alpha 0.0% top, 0.0%
left, 0.0% right, 91.8% bottom — and the bottom is the cobblestone ground,
which runs to the element's edge in the artwork too.

Worth folding into `/v1/matte` as an optional `clampToAssetId`, with the plate
as the reference. It is the difference between a keyer that is nearly right and
one that cannot be wrong about the shape.

### Asking a flat illustration to move something with nothing behind it

The first street roll was faithful at both ends and wrong in the middle. The
TAQUERIA CALIFORNIA sign, measured as mean absolute level difference from the
plate over the band it occupies:

| t | 0-1.5s | 2.0s | 2.5-7.5s | 8.0-10s |
|---|---|---|---|---|
| difference | ~30 (baseline) | 59 | **72-101** | ~30 |

Sustained through nearly six of the ten seconds, peaking at 5s, where the sign
became a dark band. The cause was in the prompt, not the model: the beat asked
the red and white striped awning to ripple, the awning overlaps that sign, and
in a flat illustration there is nothing drawn behind either of them. Asked to
move it, the model had to invent the gap.

Re-rolled with the awning and its sign declared still and rigid, the steam
dropped, and the backdrop above the rooftops stated as empty — motion left to
the greenery, the musicians, the cook, the fruit seller and the figures.

**The rule this gives, which is narrower than "not a scene":** an element may
only be asked to move where the artwork has something drawn behind it. A
pennant against sky can fly; an awning over its own signboard cannot.

---

## STATE2 — the golden-hour proscenium (2026-10-13/14)

`gyg_gh_pros_pano_3`, comp **1398**, 5750x2818, 24fps, 30s. Two flat PSD layers
do all the work: `FG_Object`, the stone proscenium with its planters and two
lit lanterns, and `BG_waves_Sunset`, one connected sunset over the sea. The
other four layers in the PSD are empty — `Layer 1` and `Layer 4` measure 0%
alpha, so the sky/water split that their bounding boxes suggest does not exist.

### Four regions carry the foreground, one clip carries the background

Johannes framed the regions: two squares on the bottom corners where a lantern
sits over a planter, two 9:16 portraits on the inner columns where a monstera
vine climbs. They are the four foliage clusters, framed the shape each cluster
actually is.

The background cannot be split. The sky band alone is 5.55:1 and the water band
3.23:1, both past the 21:9 ceiling, and the palms cannot be held out of it
either: they share the sea's own luminance range (at luma < 110, 21% of the sky
band is palm-dark and so is 56% of the sea band) and overlap it spatially. The
whole visible window is 2.04:1, which fits, so it goes in one piece.

### What the plates cost to get right

| | tokens | ~$ |
|---|---|---|
| 4 regions x 10s 1080p, first pass (opaque crops, clamped) | 1.96M | 12 |
| background 10s 4K, `adaptive` — **cropped, discarded** | 1.96M | 12 |
| R3 re-roll as an idle | 489k | 3 |
| background 10s 4K on a padded 16:9 plate | 1.96M | 12 |
| 4 regions on chroma blue, 10s 1080p | 1.96M | 12 |
| 4 regions again, on **correctly** composited plates | 1.96M | 12 |
| | **10.3M** | **~63** |

Two of those six rows were avoidable and are now impossible: see
`SEEDANCE_2_0_COST_AND_STYLE.md` on `adaptive` snapping to the nearest listed
aspect, and `packages/media/src/overBacking.ts` on premultiplied alpha.

### The recipe that worked

1. **Capture with the background switched off**, so the plate is `FG_Object`
   alone with its alpha, and stand it on flat chroma blue — 167-175 levels from
   the artwork against 129-137 for green, and the artwork is foliage. Key the
   result rather than clamping it, so a leaf may sway past the silhouette it
   was traced from.
2. **Composite the plate premultiplied** (`rgb + backing x (1 - a)`). The
   straight-alpha form squares it and bakes a dark violet rim into every soft
   edge, which is 8% of these plates.
3. **Tell the matte the backing colour.** A region cut from a larger plate has
   artwork running to the frame edge, so the auto-sample reads the artwork:
   measured [47,29,207] against a real [0,4,245], which is inside the flood
   tolerance and far outside the pocket tolerance, so every enclosed arch
   opening survived as a sheet of blue.
4. **`pocketMinArea: 0` and a pocket tolerance to match.** Safe by measurement:
   the nearest artwork pixel is 138 levels from blue.
5. **Ask for an idle, not a gust.** `IDLE` in `animate.ts`; one slow cycle
   across the ten seconds with the amplitude written in as a bound the model can
   picture ("a few degrees", "no more than a leaf's width"), not an adverb.
6. **Exempt the sea.** `IDLE` forbids anything unfurling or changing shape,
   which is what a breaking wave does.

### What the measurements say about a clip before it is placed

Amplitude inside the matte, loop closure, and the leaf-area swing — the last
catches a plant being re-drawn rather than moved, which is what the monstera did
on a gust beat sheet (106.7% of its opening area at 3.8s, against 100-102% for
the three fine-leaved regions on the same sheet). Big recognisable shapes are
regenerated; textures are displaced.

### Verified in After Effects, not just offline

Everything above was measured on rebuilt composites. On 2026-10-14 the comp
itself was rendered — `captureFrame` on 1398, a real 5750x2818 AE frame — and
measured:

| | |
|---|---|
| blue-dominant pixels (b > r+25 and b > g+25) | **0** |
| near-pure chroma survivors (b > 200, r < 60, g < 60) | **0** |
| transparent pixels below the roof cut | **0** |
| detail retained vs each region's own source plate | 94.7–106.9% |

The frame is 9.70% transparent and all of it is above y=1036 — the roof cut the
PSD always had, which is the proscenium's actual pentagon. Nothing below it is
uncovered, so the original `BG_waves_Sunset` still underneath the three animated
passes contributes nothing and can stay switched off.

The detail figure is the one worth keeping: a region is a generated 1080x1920
clip standing in for a window of a 5750-wide painting, and the obvious fear is
that it arrives soft. Measured as gradient energy against the plate each region
was generated from, R1 and R2 come back slightly *sharper* than their plates and
R3/R4 within 5%. Comparing a region against neighbouring untouched artwork
instead says nothing — the centre arch scores 4.04 against R3's 9.16 purely
because it is sky and R3 is foliage.

### Addressing a comp without opening it

`renameLayers`, `moveLayer`, `setLayerEnabled` and `deleteLayer` now take an
optional `compId` and fall back to the active comp when it is absent. This is
not a convenience. Opening a composition is a render, and two comps here cannot
afford one — the 6688x1912 arcade with forty 4K layers, and this proscenium — so
a rename that needed one of them in front was a rename that did not happen. The
work itself touches no pixels; only `openInViewer` did. Host helper:
`seedTargetComp`, which returns a reason rather than throwing.

### The agreement test was never flaky

`agreement.test.ts` was written off as a load flake for a week. It was not: the
tests shell out to ffmpeg twice on a 1600x900 frame, the slowest takes 5289ms,
and Vitest's default limit is 5000ms. Declared 60s on the describe, with the
reason in the file. `render.test.tsx` had the same shape — whichever test
imports `App` first pays to transform the panel's whole module graph. Both
declared; 885/885 across 70 files.
