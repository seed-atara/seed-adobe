# Restoring archive footage

What SEED does to make old footage usable, why it is built on Seedance rather
than on a dedicated upscaler, and what was surveyed before that choice.

Read this before changing `packages/domain/src/restore.ts` or
`apps/service/src/routes/restore.ts`.

## The problem, stated properly

A documentary cutting archive needs a shot that is *the same shot*. Not a
better-looking shot, not a more cinematic one — the same one, at a resolution
that survives a 4K delivery. A generative video model asked to "restore" a clip
will helpfully improve the composition, tidy the background, make a face more
attractive and re-time the action, and every one of those makes the footage
unusable as evidence.

There are two separable jobs hiding in the word "restore":

1. **Recovering what is there.** Resolution, detail, noise, compression
   artefacts. Nothing needs inventing.
2. **Reconstructing what is not there.** Colour on monochrome stock, and
   whatever a scratch was covering. Nothing recovers these — they have to be
   invented, and the only honest question is whether the invention is
   plausible and whether the audience is told.

SEED does both through one engine, and is explicit about which is which.

## The engine: Seedance with a reference video

The mechanism is a behaviour measured earlier and documented in
`seedanceProvider.ts`:

> Ark classifies a request carrying a reference video by what the prompt asks
> for. When it decides the task is video *editing* it refuses any duration but
> `-1`: "the output ratio and duration follow the input video selected by the
> model for editing."

That is what holds the *shot* — the framing, the content and the camera. A
restoration prompt reads as an edit, so the adapter sends `duration: -1` and the
model works from the clip rather than inventing a new one. SEED gets that by
*omission* — the restore route sends no duration and no aspect ratio, and pins
the clip's role to `reference` so it can never be read as a first frame to
animate away from.

**It does not hold the timing.** "Follow the input video" turns out to mean
follow it loosely; see the measurements below. Read that section before relying
on a restored clip lining up with its source.

Those three omissions are the feature, and each is one careless line away from
being undone. `apps/service/test/restore.test.ts` asserts all three.

The upscale is the fourth thing the route does: it asks for the **top of the
provider's resolution ladder** rather than the provider's own default, which on
Seedance is the bottom — a "restoration" that came back smaller than it went
in.

## Dedicated upscalers: surveyed, not adopted

Both were read from vendor documentation on **2026-09-01** and deliberately
left out. Recorded here so the trade-off is not re-litigated from scratch.

**Topaz Video Upscale** — `fal-ai/topaz/upscale/video`,
<https://fal.ai/models/fal-ai/topaz/upscale/video/api>. Takes `video_url`, a
`model` enum (Proteus, Artemis, Gaia, Nyx, Starlight families),
`upscale_factor`, `target_fps`, and 0–1 sliders for `compression`, `noise`,
`halo` and `recover_detail`, plus `grain` on an odd 0–0.1 range. Output is
H.265 unless `H264_output` is set.

**SeedVR2** — `fal-ai/seedvr/upscale/video`,
<https://fal.ai/models/fal-ai/seedvr/upscale/video/api>. Takes `video_url`,
`upscale_mode`, `target_resolution` up to 2160p, `seed`, `noise_scale`, and an
`output_format` that notably includes **`PRORES4444 (.mov)`** — the only
endpoint seen so far that hands back something an After Effects timeline wants
natively.

Neither has a prompt field, which is a real advantage: they cannot drift,
because there is nothing to drift with. The reasons they are not here anyway:

- **They cannot invent, so they cover only half the job.** Neither will ever
  colourise, and neither can paint out a scratch. Shipping them would mean two
  engines with different vocabularies, different failure modes and two sets of
  wiring, for a subset of the treatments.
- **On badly degraded material they sharpen the damage along with the
  picture**, because an interpolator does not know which is which. A model that
  recognises what it is looking at often wins on exactly the footage a
  documentary is dealing with.
- **One engine keeps the promise honest.** Two lanes invite a UI that implies a
  guarantee for some treatments and not others, and the guarantee was never as
  clean as it sounded — an upscaler that turns skin to wax has changed the shot
  too.

If this is revisited, SeedVR2's ProRes 4444 output is the strongest reason: it
would remove a transcode from the round trip.

## Why colourising is a guess, and is labelled as one

No arithmetic recovers the colour of a 1937 omnibus. The information was never
recorded; something has to decide it was red. Every "AI colourisation" is a
plausible guess, and the honest thing is to say so rather than dress the guess
as a recovery — which is why the `colourise` preset's fidelity line says the
colours "should be described as such on screen".

Broadcasters increasingly require exactly that disclosure for colourised
archive. SEED records the treatment and the source asset on every generation
(`seedRestore`, `seedRestoreSource`), so a finished programme can answer "was
this shot colourised?" from the library rather than from someone's memory.

## The prompts

The prompt is the product, and it is almost entirely prohibition. The shared
opening (`PIN` in `restore.ts`) names every way a video model helpfully ruins
archive: reframing, recropping, zooming, stabilising, re-timing, restaging,
recomposing, beautifying, modernising. Each is listed because a model left to
infer what "restore" means will make a *better* shot, which is the wrong shot.

Each treatment then excludes the others explicitly — colourise says "do not add
detail", detail says "add no colour whatsoever" — so two passes over the same
clip can actually be compared.

The artist's note is wrapped rather than appended. A note appended bare would
sit at the end of the prompt as the most recent and most specific instruction,
which is the position that wins; wrapped, it reads as information constraining
the restoration, and "make it cinematic" does nothing.

## Measured on real footage, 2026-09-01

First run against an actual AE capture — a 2560x1440 25fps, 7.48s range from a
graded WWII airfield comp, restored on `seedance-2-0` at 4K.

**Content adherence is good.** The source held three shots cut together —
aircraft lineup, Spitfire close-up, airmen walking. All three came back, in
order, with the cuts intact and the `DU(o)U` squadron code still legible and
correct. Detail is a real improvement: the roundel resolves into rings, exhaust
stubs and panel lines appear, faces are properly defined.

**Timing is not preserved, and the earlier claim that it was is wrong.** The
first test round-tripped 6.042s to 6.042s exactly and was written up as proof
that `duration: -1` matches the input. It was a false positive: that source was
itself a Seedance output, already sitting on Seedance's own grid. On genuine
25fps footage:

| | source | detail | clean | repair |
| --- | --- | --- | --- | --- |
| size | 2560x1440 | 3840x2160 | 3840x2160 | 3840x2160 |
| rate | 25 fps | 24 fps | 24 fps | 24 fps |
| length | 7.48s | 8.04s | 8.04s | 7.04s |

So `duration: -1` means *the model decides, loosely following the input* — not
*match the input*. Output is always 24fps and lands on whole seconds plus one
frame (24n+1 frames). The same source gave three different lengths across three
passes, and the internal cut points moved: it is not a linear stretch, the
model redistributed time across the three shots.

**Consequences.**

- A restored clip does not drop onto the timeline over its original. Conforming
  needs a frame-rate interpretation and a time-stretch, and even then internal
  cuts will not align.
- **Restore one shot per pass.** Given a span containing cuts, the model treats
  it as one generation and re-apportions time across it. A single continuous
  shot has far less room to drift.
- Colour shifts warm — grass yellower, sky less cyan. Not damage, but it needs
  grading back before intercutting with untreated archive.
- `seedance-2-0` ignores `output_format`, so 4K arrives as **HEVC Main 10**,
  which neither the browser preview nor a plain AE import handles unaided.

**Which treatment did work.** Only `detail`, and by a wide margin — 14.0MB
against 10.4 and 9.5, and visibly sharper at 100%. `clean` and `repair` had
nothing to do on a graded digital comp with no tape noise and no physical
damage. They earn their place on real scanned film, not here.

## The prompt was the wrong shape, 2026-09-01

Johannes's verdict on the first real run: *"none of the clips is better than the
input. It's even worse because some animation is wrong."* He proposed
re-rendering with the look described and the input as guidance. That is right,
and `PROMPT_CRAFT.md` says why the original failed.

The first prompt was ~200 words of pure prohibition — reframe, recrop, re-time,
stabilise, restage, recompose, beautify, modernise, all forbidden — and nothing
about what to produce. Three problems with that, all from BytePlus's own
guidance:

1. **Seedance reads a spatial layer and a temporal one, as ordered beats.** A
   prompt made only of "do not" gives the temporal layer nothing to follow, so
   the model invents motion. That is exactly the reported defect.
2. **A model given only prohibitions has no positive objective.** "Reproduce
   exactly, change nothing" is close to a null instruction; the whole prompt
   was spent suppressing the machinery that produces quality.
3. **Constraints are published as a short closing tail**, not an opening wall.
   The shape was inverted.

### What replaced it

    ANCHOR   Re-render this exact footage at far higher quality. The reference
             video is the shot: keep its framing, camera, lens, cuts, and the
             identity, position and action of everything in it.
    LOOK     <the artist's own words — stock, optics, grain, palette>
    NOTE     <what the footage is, framed as background>
    TAIL     Stable faces and geometry, fluid motion, no flicker, no warping.

`ANCHOR` is load-bearing beyond style: Ark classifies the task from the prompt,
and only an *edit* may send `duration: -1`. Reword it into "a beautiful shot
of..." and every restoration silently becomes a fresh generation.

The look is now an **editable field in the panel**, not a hidden prompt behind a
checkbox. Presets fill it; the artist rewrites it; what is on screen is what is
sent. `seedRestoreLook` records it verbatim on the generation.

**Not yet measured.** This is a redesign grounded in the model-maker's guidance
and in one bad result, not in an A/B. The claim is "the prompt now has the
shape the model is documented to read", not "the output is better".

## Open questions

- No measurement yet of whether Seedance's reference-video mode holds a face
  steady across a 30-second archive clip. That is the likeliest limiting
  factor, and the thing to check first on real footage.
- Unknown how it behaves on heavy tramlining and gate weave, which is what
  scanned 8mm and 16mm actually arrive with.
- Nothing here handles interlacing, which is what most broadcast archive is. A
  de-interlace before the restoration is currently the artist's problem.
- Seedance caps at 30 seconds, so a long archive shot has to be restored in
  pieces — and nothing checks that two pieces match at the join.
