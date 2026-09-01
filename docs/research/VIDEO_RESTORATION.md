# Restoring archive footage

What is actually available for making old footage usable, read from vendor
documentation on **2026-09-01**, and what SEED does with it.

Read this before changing anything in `packages/domain/src/restore.ts`,
`packages/providers/src/fal/upscaleProvider.ts` or
`apps/service/src/routes/restore.ts`.

## The problem, stated properly

A documentary cutting archive needs a shot that is *the same shot*. Not a
better-looking shot, not a more cinematic one — the same one, at a resolution
that survives a 4K delivery. A generative video model asked to "restore" a clip
will helpfully improve the composition, tidy the background, make a face more
attractive and re-time the action, and every one of those makes the footage
unusable as evidence.

So there are two separable jobs hiding in the word "restore":

1. **Recovering what is there.** Resolution, detail, noise, compression
   artefacts. Nothing needs inventing; a good enough algorithm is strictly
   better than a model because it cannot drift.
2. **Reconstructing what is not there.** Colour on monochrome stock, and
   whatever a scratch was covering. Nothing recovers these — they have to be
   invented, and the only honest question is whether the invention is
   plausible and whether the audience is told.

SEED calls these the **measured** and **generated** lanes and never blurs
them, because the promise each can make is different and an editor needs to
know which one they were given.

## What each provider actually offers

### Topaz Video Upscale — the measured lane

Endpoint `fal-ai/topaz/upscale/video`, schema from
<https://fal.ai/models/fal-ai/topaz/upscale/video/api>, read 2026-09-01.

| Field | Type | Range | Default |
| --- | --- | --- | --- |
| `video_url` | string | — | required |
| `model` | enum | Proteus, Artemis HQ/MQ/LQ, Gaia HQ/CG/2, Nyx/Fast/XL/HF, Starlight (7 variants) | `Proteus` |
| `upscale_factor` | float | undocumented | `2` |
| `target_fps` | integer | — | unset |
| `compression` | float | 0–1 | model-dependent |
| `noise` | float | 0–1 | model-dependent |
| `halo` | float | 0–1 | model-dependent |
| `grain` | float | **0–0.1** | model-dependent |
| `recover_detail` | float | 0–1 | model-dependent |
| `H264_output` | boolean | — | `false` (H.265) |

Output is `{ video: { url, content_type, file_name, file_size } }`.

**There is no prompt field.** That is the entire reason this provider exists in
SEED: the guarantee is structural, not a promise extracted from a model by
careful wording.

Four things worth knowing before touching the adapter:

- **`grain` is 0–0.1 while every neighbour is 0–1.** Clamping it with the same
  constant would put ten times the documented maximum of synthetic grain on an
  archive clip. `RANGES` in the adapter carries the per-field range for exactly
  this reason.
- **Defaults are model-dependent, so an unsent field beats a guessed one.**
  The adapter sends nothing for a treatment it does not have a table entry for.
- **H.265 is the default output**, and neither the panel's preview nor a plain
  After Effects import handles it. The adapter always sends `H264_output: true`.
- **`target_fps` enables frame interpolation.** Never sent. Changing the frame
  rate of archive is a creative decision, and a restored clip has to cut
  against the original frame for frame.

**Not verified against a live account.** Everything above is Topaz's published
schema on fal, not a response this code has seen. The first real run is the
measurement.

### SeedVR2 — considered, not adopted

`fal-ai/seedvr/upscale/video`, from
<https://fal.ai/models/fal-ai/seedvr/upscale/video/api>, read 2026-09-01.
Takes `video_url`, `upscale_mode` (`factor` | `target`), `target_resolution`
(720p–2160p), `seed`, `noise_scale`, and an `output_format` that notably
includes **`PRORES4444 (.mov)`** — the only endpoint seen so far that will hand
back something an After Effects timeline wants natively.

Also prompt-free, so it belongs on the measured lane too. Not wired up: one
upscaler proves the lane, and a second before the first has been run against
real footage would be two unmeasured adapters instead of one. The ProRes output
is the reason to revisit this.

### Seedance — the generated lane

Already integrated. What makes it usable for restoration is a behaviour
measured earlier and documented in `seedanceProvider.ts`:

> Ark classifies a request carrying a reference video by what the prompt asks
> for. When it decides the task is video *editing* it refuses any duration but
> `-1`: "the output ratio and duration follow the input video selected by the
> model for editing."

That is the whole mechanism. A restoration prompt reads as an edit, so the
adapter sends `duration: -1` and **the output follows the input clip's length
and ratio exactly**. SEED gets that behaviour by *omission* — the restore route
sends no duration and no aspect ratio, and pins the clip's role to `reference`
so it can never be read as a first frame.

Those three omissions are the feature, and each is one careless line away from
being undone. `apps/service/test/restore.test.ts` asserts all three.

## Why colourising cannot be measured

No arithmetic recovers the colour of a 1937 omnibus. The information was never
recorded; something has to decide it was red. Every "AI colourisation" is a
plausible guess, and the honest thing is to say so rather than to dress the
guess as a recovery — which is why `RESTORE_PRESETS.colourise` has only a
generated lane and why its fidelity line says the colours "should be described
as such on screen".

Broadcasters increasingly require exactly that disclosure for colourised
archive. SEED records the treatment, the lane and the source asset on every
generation (`seedRestore`, `seedRestoreLane`, `seedRestoreSource`), so a
finished programme can answer "was this shot colourised?" from the library
rather than from someone's memory.

## The prompts

On the generated lane the prompt is the product, and it is almost entirely
prohibition. The shared opening (`PIN` in `restore.ts`) names every way a video
model helpfully ruins archive: reframing, recropping, zooming, stabilising,
re-timing, restaging, recomposing, beautifying, modernising. Each is listed
because a model left to infer what "restore" means will make a *better* shot,
which is the wrong shot.

Each treatment then excludes the others explicitly — colourise says "do not add
detail", detail says "add no colour whatsoever" — so that two passes over the
same clip can actually be compared.

The artist's note is wrapped rather than appended. A note appended bare would
sit at the end of the prompt as the most recent and most specific instruction,
which is the position that wins; wrapped, it reads as information constraining
the restoration, and "make it cinematic" does nothing.

## Open questions

- Neither fal adapter has been run against a live account. Topaz's real
  behaviour on 8–16mm scans, gate weave and heavy tramlining is unknown.
- No measurement yet of whether Seedance's reference-video mode holds a face
  steady across a 30-second archive clip. It is likely to be the limiting
  factor, and the reason the measured lane exists.
- SeedVR2's ProRes 4444 output is untested and would remove a transcode from
  the round trip.
- Nothing here handles interlacing, which is what most broadcast archive
  actually arrives as. A de-interlace before the restoration is currently the
  artist's problem.
