# Handover — aspect expansion, and everything this session established

Written 2026-08-24 to close a long working session. Read this before touching
`packages/media/src/{mosaic,align,letterbox}.ts`, `apps/service/src/routes/expand.ts`,
or `apps/panel/src/components/ExpandView.tsx`.

Related, and still current: ADR 0013–0017, `docs/research/PLATE_EXTENSION_PRIOR_ART.md`,
`docs/research/BEEBLE_AND_WHERE_WE_SIT.md`, `docs/research/MODEL_API_NOTES.md`.

---

## 1. Where the feature stands

**Working, verified against real footage and the live API:**

- Sampling a shot to `.seed-ae/samples` as scratch (never library assets).
- Reading what After Effects actually writes — **16-bit PNG**.
- Detecting and cropping a baked-in pillarbox/letterbox.
- Planar (homography) tracking with RANSAC, ~2.7s a frame pair at 1080².
- Building a plate, and reporting honestly when the shot cannot be stitched.
- **Filling the margins with Seedream** — verified end to end on the real clip:
  a 1920×1080 plate went out, a filled 1920×1080 frame came back in 13.7s,
  shelves and aisle continued past both edges, nothing invented in the middle.
- Panel flow: **Expand to 16:9 → Fill the margins → Build comp**, in one tab.

**Not verified:** the assembled comp inside After Effects. `seedAssemblePlateExpansion`
typechecks, has a Premiere stub, and is wired — but nobody has yet scrubbed a
finished comp and confirmed the background sits right. **This is the next thing
to check.**

**Not built, on purpose:** the colour pass. The fill is derived from the plate
it completes, so margins come back close, and the original composites over the
middle regardless. `/v1/assets/grade-proposal` exists if a real join shows up.
Do not add it speculatively.

---

## 2. The physics, which no amount of engineering changes

**A homography cannot express parallax.** A pan or tilt across a distant scene
is nearly a plane and stitches cleanly. A dolly — the test clip is a dolly down
a supermarket aisle — has the near shelf and the far end travelling at different
rates. No single transform fits both. The tracker will still return *a*
transform, and it will be a compromise that drifts.

`CoverageReport.planarity` is the detector: the share of patches that agreed
with the fitted plane, reported as the **weakest link, not the mean**. The test
clip scores **0.33**. Below 0.7 the route says the shot has depth and to
generate the margins instead.

This is why the test clip cannot be recovered, and it is not a bug.

---

## 3. Bugs found this session, and what each one teaches

Every one of these passed the test suite before it was caught. The pattern is
the lesson.

| bug | symptom | root cause |
| --- | --- | --- |
| Coverage strided over frames | 0% recoverable when 42% was | sampling stride also decided what counted as *seen* |
| Offsets quantised to 6px | visible staircase through the plate | search bottomed out at a 180px proxy and scaled the answer back up |
| Warp bounds inverted | plate held one frame in a huge empty canvas | fed frame corners through the plate→frame transform to ask where the frame lands *in the plate* |
| 16-bit PNG rejected | "could not be decoded" on every real frame | decoder took 8-bit only; AE writes 16-bit from any project above 8 bpc |
| Extent from the corner | 1080-tall shot padded to 1864, prompt asking to invent 785px below | corner flies outward when the transform carries scale |
| Planarity averaged | 0.75 reported for a chain containing 0.33 | transforms compose; a chain is only as good as its weakest link |
| Patch grid fixed at 6×4 | silent total failure under ~150px wide | patches fell below the minimum and the function returned `[]` with no signal |
| Samples registered as assets | 12 library entries per attempt | intermediates treated as deliverables |
| Zero new area read as 0% coverage | verdict blamed the camera | `0 of 0 pixels` is not a coverage figure |

**Three process lessons, stated plainly:**

1. **Synthetic tests at toy resolutions hid resolution bugs.** Every mosaic test
   used frames shorter than the 180px working height, so no scaling happened and
   the staircase could not appear. A resolution bug needs a test at a resolution.
2. **The planar path had no end-to-end test at all** until the warp-bounds bug
   forced one. Passing `planes` was untested.
3. **Real footage found what synthetic data could not** — 16-bit, parallax,
   baked-in pillarbox, and the speed problem. Run new work against
   `.seed-ae/samples` from a real project early.

---

## 4. Performance, measured

At 1080×1080, per frame pair:

| | before | after |
| --- | --- | --- |
| translation match | 786ms | 766ms |
| planar match | 19,551ms | **2,730ms** |
| 12 samples | ~3.5 min | ~30s |

Three changes got it there: one global match per pair seeds every patch; a
seeded search refines one candidate rather than five; patches sample a quarter
as densely. Accuracy unchanged — still 24/24 patches at full confidence.

The track also **yields to the event loop between pairs**. Node is single
threaded, so a synchronous pass makes the whole service unresponsive — `/health`
timed out and the panel could not poll. Yielding does not finish sooner; it
keeps the service answering.

---

## 5. Verified external facts

**Ark has two credential systems and needs both.**

- `ARK_API_KEY` — Bearer, for inference. From the Ark console.
- `SEED_ARK_AK`/`_SK` — HMAC-signed, for the asset library OpenAPI.

They are not interchangeable. Verified by exhausting 45 combinations of region,
service name and secret encoding against `images/generations`: all rejected.
**`ListApiKeys` returns key values masked**, so an existing key cannot be
recovered through the API — Ark reveals a key once, at creation.

Signing is a SigV4 *variant*: `X-Date`, `X-Content-Sha256`, and the literal
`request` scope terminator. The secret is used **exactly as issued** despite
looking base64-shaped.

**Model ids** are `<Name>-<PrimaryVersion>` from `ListFoundationModels`
(`PageSize` caps at 100). `scripts/ark-models.ts` does the lookup. Per-model
minimum output areas are real and enforced locally.

**Seedance cannot widen a shot.** Both measured: a first frame and a reference
video are mutually exclusive (*"first/last frame content cannot be mixed with
reference media content"*), and a reference video makes the output follow the
input's ratio. There is no arrangement of its inputs that expands while
following the source. This is why `ReframeProvider` was restored (ADR 0017)
after being removed (ADR 0016).

**Beeble SwitchX is generative**, and is *not* SwitchLight. Contract verified
live; the adapter was built, then removed with the rest of ADR 0016 and has not
been restored. Recorded in the research note if it is ever wanted back.

**Prior art:** Mocha Pro's **Mega Plate** is this feature, professionally —
planar track plus temporal frame analysis into a larger-than-raster plate,
exported *with tracking data* for re-projection. Same architecture, which is
reassuring. Their tracker is planar; ours now is too.

---

## 6. Open items, in the order worth doing

1. **Scrub an assembled comp in After Effects.** The one unverified link.
2. **Exposure-match frames before accumulating.** The median currently averages
   across a brightness step between frames; `measureColour` already exists.
3. **`Build comp` for the static case.** It works (world == delivery, windows all
   zero) but has never been run; for an unstitchable shot it is a two-layer comp.
4. **Cylindrical reprojection**, only if wide pans start stretching at the edges.
5. **The panel preview shows the uncropped sample size** — it says
   `1920×1080 → 1920×1080` for a pillarboxed clip because it does not know the
   service crops. Cosmetic, misleading, small fix.

---

## 7. How to run it

```bash
npm run install:extension     # panel or host changed
npm run dev                   # service
```

Restart After Effects if the host script changed (`apps/extension/jsx`). Then:

1. Open the comp, set the **work area** over one continuous move.
2. Panel → **expand**. Aspect **16:9**, Original sits **Centred**.
3. **Expand to 16:9** — ~30s.
4. **Fill the margins** — ~15s.
5. **Build comp**.

*Recover real pixels first (advanced)* is for shots that genuinely pan or tilt
far enough for the edges to have been photographed. It is not the common case.

**Which restart is needed:** service-only changes (`apps/service`, `packages/*`)
need `npm run dev`. Panel changes need `install:extension`. Host script changes
need `install:extension` **and** an AE restart — ExtendScript is read at launch.

`scripts/clean-samples.ts` sweeps up frames registered as assets by the old
sampler. Dry by default.
