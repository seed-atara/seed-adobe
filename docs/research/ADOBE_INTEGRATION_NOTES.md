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

## Premiere frame capture: the answer is PProPanel

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
