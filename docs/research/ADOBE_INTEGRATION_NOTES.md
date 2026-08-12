# Adobe Integration Notes

Last checked: 2026-08-09

## Question

Which extension technology should the SEED panel ship on for After Effects:
CEP, UXP, or the C++ SDK?

## Finding: CEP, for now

**UXP is not available for After Effects.** Adobe's extensibility update lists
UXP as shipping for Photoshop, InDesign and XD, with Premiere Pro and Media
Encoder entering the ecosystem afterwards. UXP subsequently graduated from beta
in Premiere 25.6. After Effects is not among the applications with UXP support.

**CEP still ships with After Effects, but is frozen.** Per the same Adobe post:
CEP 12 shipped with After Effects 25.0 and "will be the last major update to
CEP, although critical security issues will continue to be addressed."

So for an After Effects panel today, CEP is the only route that provides a
dockable UI plus scripting access to the project, comp, render/export, import
and timeline operations. The C++ SDK is heavier than V0 needs and does not give
us a dockable HTML panel.

### Consequences accepted

- CEP is a maintenance-only platform. Expect a UXP migration for After Effects
  eventually, on Adobe's timeline, not ours.
- This is exactly why `AeHostAdapter` exists. The panel UI and the entire
  service are host-agnostic; a UXP port should replace one adapter plus the
  manifest, not the product.
- The panel is built as a plain web app. It runs in a browser during
  development and is loaded from `file://` by a CEP host, which is why the
  service sends CORS headers for local origins and the Vite build uses a
  relative base.

### Caveats on this finding

- Sourced from Adobe's developer blog post on Creative Cloud desktop
  extensibility and corroborating Adobe community threads, not from a
  version-stamped support matrix. Community discussion speculates about a 2026
  date for UXP-only, which is **not** confirmed Adobe guidance — do not plan
  against it.
- Re-check before building the actual CEP extension: confirm the CEP version
  bundled with the target After Effects release, and whether an AE UXP beta has
  since opened.

## Not yet done

Building the CEP extension itself: `CSXS/manifest.xml`, the ExtendScript host
bridge (`app.project`, `comp.saveFrameToPng` / Render Queue export, `importFile`,
timeline insertion), signing, and installation. The `MockAeHostAdapter` stands
in until then, and every product feature is already testable against it.

## Sources

- Adobe Tech Blog — Updates for Creative Cloud Desktop Extensibility:
  https://blog.developer.adobe.com/updates-for-creative-cloud-desktop-extensibility-0dd5c663563e
- Adobe Developer Blog — UXP Arrives in Premiere:
  https://blog.developer.adobe.com/en/publish/2025/12/uxp-arrives-in-premiere-a-new-era-for-plugin-development
- Adobe Community — CEP / UXP roadmap discussions:
  https://community.adobe.com/t5/after-effects-discussions/uxp-for-after-effects/td-p/13360660

## Premiere frame capture: `sequence.exportFrameAsPNG` (verified working)

```js
var sequence = app.project.activeSequence;
var written  = sequence.exportFrameAsPNG(sequence.getPlayerPosition(), path);
```

A method on the **sequence object itself** — no QE DOM, no Media Encoder, an
explicit `Time` and a boolean back. It respects the time it is given, which
nothing else here does. It is not in the scripting guide, which is why six
earlier attempts never tried it; SEED now probes for it by name and reports
what the build offers.

**It appends the format's extension to whatever path it is given**, so asking
for `frame.png` produces `frame.png.png` — the documented 25.3+ behaviour. The
file is correct; only the name is wrong, and SEED renames it after the fact.
Code that checks for the exact path it requested will conclude the call failed
silently, which is very likely what some earlier attempts actually hit.

### Why the other routes fail

| route | result |
|---|---|
| `app.encoder.encodeSequence(..., ENCODE_IN_TO_OUT, 1, true)` | **Given the right range and ignores it.** Verified: `in=10.000s out=10.040s`, mode `1` read from `app.encoder.ENCODE_IN_TO_OUT`, real job id, first frame of the sequence written. Its still exporter disregards the range. |
| `sequence.exportAsMediaDirect(path, preset, n)` | "Unable to initialize export!" for every work-area constant and both path forms |
| `qe…exportFramePNG(timecode, path)` | "Unknown error exception" |

Adobe's own PProPanel sample uses `encodeSequence`, so the sanctioned route is
the one that returns the wrong frame here. Worth knowing before trusting a
reference implementation over a measurement.

`app.encoder.ENCODE_WORK_AREA` is `undefined` on this build, while
`ENCODE_ENTIRE` is 0 and `ENCODE_IN_TO_OUT` is 1.

### The lesson worth keeping

Every failed attempt reported success. AME always writes *a* file, so it counted
as a working route and prevented the fallbacks from ever running — the QE matrix
built to find a working combination had never once executed by the time the real
answer turned up. When a route can fail silently, ordering it first hides
everything behind it.

## Superseded: the PProPanel approach

Adobe's own CEP sample has a working single-frame export,
`exportCurrentFrameAsPNG` in `PProPanel/jsx/PPRO/Premiere.jsx`, and it is the
implementation the Adobe forums point people at. It uses Media Encoder rather
than the QE DOM.

```js
var currentTime = seq.getPlayerPosition();
var oldInPoint  = seq.getInPointAsTime();
var oldOutPoint = seq.getOutPointAsTime();

seq.setInPoint(currentTime.seconds);          // seconds, not ticks
seq.setOutPoint(currentTime.seconds + 0.033); // one frame

var jobID = app.encoder.encodeSequence(
    seq, outputFileName, presetPath,
    app.encoder.ENCODE_IN_TO_OUT,
    removeUponCompletion,      // 1
    startQueueImmediately);    // the sixth argument

seq.setInPoint(oldInPoint.seconds);
seq.setOutPoint(oldOutPoint.seconds);
```

SEED differed from this in three ways, each enough on its own to produce a
first-frame export that reported success:

1. **In/out were set in ticks.** A guess, and wrong — the sample passes
   seconds. (The guess was made *because* seconds appeared not to work, which
   it did not, for reason 2.)
2. **`encodeSequence` was called with five arguments.** It takes six. The
   missing one says whether to start the queue.
3. **The range was restored in a `finally`**, which on the direct route ran
   before the encoder had read the sequence. The sample restores immediately
   after the call, which is safe.

Also worth knowing, from the same research: on Premiere 25.3+ the QE
`exportFramePNG` appends a **second `.png`** to the filename, so code that looks
for the path it asked for finds nothing and concludes the call silently failed.
Watching the folder rather than one exact path avoids this.

### The routes that do not work

Kept because knowing what fails is worth as much as knowing what works:

| route | result |
|---|---|
| `qe…exportFramePNG(timecode, path)` | "Unknown error exception" |
| `qe…exportFramePNG(path)` | no error, no file at the path asked for (see the double-extension bug) |
| `sequence.exportAsMediaDirect(path, preset, n)` | "Unable to initialize export!" for every work-area constant and both path forms |

After Effects capture is unaffected: `CompItem.saveFrameToPng` is documented,
synchronous, and correct.

## Superseded: four routes, all wrong, none complaining

Frame capture is disabled in Premiere. Every route returns the **first frame of
the sequence** regardless of the playhead, and every one reports success.

What was tried, and what each did:

| route | result |
|---|---|
| `qe…exportFramePNG(timecode, path)` | "Unknown error exception" |
| `qe…exportFramePNG(path)` and `(path, w, h)` | no error, first frame |
| `sequence.exportAsMediaDirect(path, preset, n)` | "Unable to initialize export!" for every work-area constant and both path forms |
| `app.encoder.encodeSequence(..., ENCODE_IN_TO_OUT, 0)` | writes a real PNG — of frame zero |

Things ruled out along the way:

- **The playhead is read correctly.** The panel shows the right frame number in
  its context strip, so `getPlayerPosition()` is fine.
- **In/out was set in seconds, which the API takes as ticks** — ten seconds
  became ten ticks, i.e. frame zero. Fixed by writing and reading back, and it
  did not change the result.
- **`setPlayerPosition` before a path-only export** did not change it either.

So the remaining explanation is that the still exporter ignores the range and
always renders from the sequence start. Every one of these calls is
undocumented, and each attempt to guess its shape produced a *successful* wrong
answer — which is the worst failure mode available and the reason this is now
disabled rather than left to look like it works.

After Effects capture is unaffected: `CompItem.saveFrameToPng` is documented,
synchronous, and correct.

Worth trying if this is picked up again: exporting from a *duplicate* sequence
trimmed to the single frame, so no range parameter is involved at all.

## Replacing a Premiere clip's media without losing the work on it — RESOLVED (2026-08-12)

Premiere has no `replaceSource`. The question is how to swap the media under a
timeline clip while keeping the effects, masks, keyframes and transitions the
artist built on it.

What the scripting API **cannot** do, confirmed against the scripting guide and
Adobe's own community answers:

- There is no way to clone a trackItem with its effects. Placing a clip through
  `insertClip`/`overwriteClip` takes the raw project item, and every effect and
  keyframe on the original is lost.
- Adding an effect to a clip is not in the documented API at all. It is only
  reachable through the undocumented QE DOM.
- Masks are not exposed to scripting in any form, so "copy the attributes and
  paste them afterwards" cannot be completed even in principle.

What it **can** do: `ComponentParam` is fully featured — `getValue`,
`setValue`, `getKeys`, `getValueAtKey`, `setValueAtKey`, `addKey`,
`removeKeyRange`, `isTimeVarying`, `setTimeVarying`,
`setInterpolationTypeAtKey`. So the values and keyframes of parameters on
components that *already exist* can be copied. Note the asymmetry:
interpolation type can be set but not read, so round-tripping curve shapes is
not possible either.

### The route that does work

`projectItem.changeMediaPath(path, true)` is Replace Footage. It swaps the
media under a project item, and every sequence using it keeps its attributes
intact — because the clips are never replaced. This is the same call the fill
step already used, and it preserves everything.

Its one hazard is that it acts on the **item**, not the clip: an item used by
several clips changes all of them at once, which would silently alter a shot
elsewhere in the edit.

So SEED counts the clips referencing that item across every sequence
(`app.project.sequences` → video and audio tracks) before choosing:

| Uses | Route | Cost |
| --- | --- | --- |
| 1 | `changeMediaPath` | nothing — effects, masks, keyframes, transitions all survive |
| >1, or the item is unreadable | overwrite the clip's span | effects and masks lost; scale carried across by hand |

One use is the normal case for a SEED clip, because the reserve/fill flow
imports a private project item per reservation.

Sources:
- Premiere Pro Scripting Guide, ComponentParam — https://ppro-scripting.docsforadobe.dev/sequence/componentparam/
- "How to add effects to clips in Premiere with CEP/ExtendScript?" — https://community.adobe.com/t5/premiere-pro-discussions/how-to-add-effects-to-clips-in-premiere-with-cep-extendscript/td-p/10431363
- "ExtendScript: How to retain Effects when copying TrackItems between Sequences?" — https://community.adobe.com/questions-729/extendscript-how-to-retain-effects-when-copying-trackitems-between-sequences-1550341
