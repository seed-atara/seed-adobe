# 0014 — Expanding a shot by recovering it first

**Status:** built 2026-08-23 — coverage and mosaic shipped; handover to a
generator is wiring that already exists
**Date:** 2026-08-23
**Extends:** ADR 0013, which built `ReframeProvider` and planned this half

## The claim

Every reframing tool invents the new edges. On a shot that moves, most of those
edges were **photographed** — just in a different frame. Recovering them is
free, correct by construction, and temporally stable by construction.

Luma Reframe bills per started source second (roughly $0.06/s at 540p, $0.12/s
at 720p, $0.36/s at 1080p) whether or not the answer was already sitting in the
footage. So the first thing SEED does is measure how much of it was.

## What was built

`packages/media/src/mosaic.ts`, pure and testable outside Adobe:

- `estimateTranslation` — the offset between two frames, coarse to fine.
- `trackShot` — consecutive matches accumulated into positions.
- `expandFromShot` — projects the shot into the expanded canvas, returns the
  recovered plate, a **residual mask** of what nobody ever photographed, and a
  coverage report.
- `measureCoverage` — the cheap question, answered before the expensive one.

Routes: `POST /v1/expand/coverage` and `POST /v1/expand/recover`.

Verified end to end on a synthetic pan: 12 frames, 176px of travel, expanded to
21:9. Centred, coverage is **50%** — left edge 0%, right edge 100%. With the
source pinned to the left of the new canvas, coverage is **100%**.

That asymmetry is the feature. A camera travelling right reveals what lies to
the right and never sees what is off the left edge, so *where the original sits
in the new frame decides whether the footage can pay for the expansion*. No
tool that treats reframing as a black box can tell an artist that.

## Three decisions worth recording

### 1. Median, not mean

The per-pixel value is the median of every frame that saw it. A mean ghosts
anything that moved through; a median outvotes it. Tested with a block crossing
frame: under 8% of the recovered plate carries its colour.

### 2. Refuse to answer rather than answer wrongly

The first implementation returned a wildly wrong offset **at full confidence**
on repeating texture. Coarse pyramid levels alias — brick, fencing and foliage
all match themselves at several offsets — and following the coarse winner down
produced a confident wrong answer, which is worse than no answer.

Fixed by carrying several *separated* coarse candidates down and letting full
resolution decide, and by making confidence the lesser of two measures:

- **strength** — how far the winner sits below the median of the field, which
  catches a featureless frame;
- **uniqueness** — how far the winner sits below its nearest distinct rival,
  which catches a periodic one.

A regression test now asserts that vertical stripes report confidence `0`.
This is the same discipline as the camera measurements in ADR 0012: a wrong
number applied confidently is worse than no number.

### 3. Translation only, and said out loud

A pan or a tilt recovers exactly. A dolly does not — a translating camera sees
genuinely different geometry and no 2D offset expresses parallax. Rotation and
zoom are not modelled. None of these produce a wrong answer; they produce a low
confidence and are excluded, and the report says how many frames were rejected.

## Corrected 2026-08-23 — the staircase

The mosaic came back with a diagonal staircase through it on real footage, and
the tests were green throughout.

The tracker searched a 180px-tall proxy and multiplied the winning offset back
up, so on a 1080-tall plate **every answer was a multiple of six**. A 7px pan
measured as 6, a 13px pan as 12, and the leftover error accumulated frame over
frame — including vertically, which is why a purely horizontal move came out
sheared.

The finest pyramid level is now the picture itself, so offsets are exact. On a
1080-square plate panning 17px a frame the track is now `0, 17, 34, 51, 68…`
with zero drift, and the residual is two clean rectangles rather than a
staircase.

**Why the suite missed it.** Every test used frames shorter than 180px, so the
proxy *was* the picture and no scaling happened. A resolution bug needs a test
run at a resolution; there are now three, at 480x360.

Cost: tracking a 1080-square shot is roughly 0.7s a frame pair. Worth it — the
alternative was a plate nobody would use.

## Corrected 2026-08-23

`measureCoverage` strode over frames, and on a shot static apart from one jolt
it reported **0% recoverable when 42% was** — the advisory number, wrong in the
direction that costs money. Every frame is now visited; the reservoir spreads
per pixel instead, deterministically. Regression test included.

Luma Reframe has since been removed entirely — see ADR 0016.

## What this does not do yet

- **It takes frames, not a clip.** Nothing here decodes video, so the routes
  take an ordered list of stills. After Effects renders sequences and
  `POST /v1/ae/register-capture` registers them, which is the path that exists.
  A decoder is the obvious next step.
- **The handover is one button, not zero.** The Expand tab sends the recovered
  plate to Generate as Seedance's *first frame* — which is also what locks the
  output aspect, since Ark takes the shape from the frame and refuses a stated
  one. The artist still presses Generate.
- **Full-resolution memory.** The reservoir is `canvas × samples × 3` bytes.
  Fine at preview scale; a 4K canvas at five samples wants a tiled pass.

## Order from here

1. Frames from a clip, so this runs on footage rather than a rendered sequence.
2. Rotation and zoom, which turn "a pan recovers" into "a shot recovers".
3. Passing the residual as an explicit mask, so the model is told where the hole
   is rather than inferring it from the plate.
