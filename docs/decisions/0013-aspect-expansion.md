> **Superseded in part by ADR 0016 (2026-08-23).** `ReframeProvider` was built,
> measured, and has since been removed: SEED's own `/v1/expand/*` does the job,
> recovering the edges the footage already contains and handing only the
> remainder to Seedance. The analysis of the market below still stands; the
> "Reframe as it stands" step in the order no longer does.

# 0013 — Expanding a shot into another aspect

**Status:** superseded in part by [0014](0014-expansion-by-recovery.md), which
built the recovery half. The panel route uses **Seedance**, not Luma — see below.
**Date:** 2026-08-22

Portrait to landscape and back, on footage that moves — filling in what was
never shot.

## What the market does

| tool | what it is |
|---|---|
| **Luma Reframe** (Ray 3.2) | the dedicated one. Seven aspects, outpaints beyond the original frame, keeps the source frames unchanged. Available as an API on fal and Replicate |
| **Runway Expand Video** | the same idea, shipped late 2024. Reported as convincing but not perfect |
| Kling, Pika, Sora | strong generators; reframing is not their published feature |

Luma is the one with an API worth building against, and **`ReframeProvider` is
built** — `luma/agent/ray/v3.2/reframe`, behind the same fal queue as IC-Light.

Two limits from the endpoint, both real:

- the source must be **ten seconds or less**
- the aspect comes from a fixed list: `3:4 4:3 1:1 9:16 16:9 21:9`

The control worth having is **`source_rect`**, which places the original inside
the new canvas. A talking head that has to make room for a title should sit off
to one side, not be expanded symmetrically, and that is a normalised rectangle
rather than a re-render.

## What everyone gets wrong, and where SEED can be better

Every one of these tools **invents** the new edges. On a locked-off shot that
is the only option. On a shot that *moves*, it is throwing away the answer.

**When a camera pans, the edges you need were photographed — just in a
different frame.** A shot that drifts left for four seconds has already seen
what belongs to the right of frame one. A compositor knows this: you track the
plate, accumulate the frames into a wider canvas, and fill the new area with
*real pixels* before hallucinating anything.

So the plan is a two-stage fill:

1. **Recover.** Track the shot, project every frame into a common canvas, and
   composite them. The expanded region is filled with photographed pixels
   wherever any frame saw them — correct by construction, temporally stable by
   construction, and free.
2. **Invent only the remainder.** Whatever no frame ever saw goes to Reframe,
   with the recovered mosaic as the source so the model is completing a picture
   rather than guessing at one.

That ordering is the whole idea. It is also only possible for something holding
the sequence and a tracker, which is why a web tool cannot do it and After
Effects can.

**The honest limits.** It needs parallax-free or near-parallax-free motion to
be exact — a pan or a tilt recovers cleanly, a dolly does not, because a
translating camera sees genuinely different geometry. Moving subjects leave
smears in the accumulation and have to be excluded by a matte. Both are normal
compositing constraints rather than surprises, and the recovered coverage can
be *reported*: "78% of the new area came from your own footage" is a number an
artist can act on.

## What it needs

| piece | state |
|---|---|
| `ReframeProvider` | **built** |
| tracking the plate | After Effects has it. Reading it back through the host is the work |
| projecting and accumulating frames | new, deterministic, testable outside Adobe |
| coverage reporting | falls out of the accumulation |
| handing the remainder to Reframe | the provider is there |

## Order

1. **Reframe as it stands** — pick an aspect, pick where the source sits, go.
   Available now, and for a locked-off shot it is the whole feature.
2. **Coverage measurement** — for a moving shot, say how much of the new area
   the footage itself could supply. Cheap, and it tells the artist whether
   stage 3 is worth it.
3. **The mosaic fill** — recover those pixels and hand the rest over.

All three stages are shipped. Stage 1 as `ReframeProvider`, stages 2 and 3 as
`/v1/expand/coverage` and `/v1/expand/recover` with the Expand tab over them.

## What changed once it was built: Seedance, not Luma

The panel route generates with **Seedance**, and the reason is a constraint
that reads like an obstacle and is really the mechanism.

Ark decides the output shape from the input rather than from a field — "for
first-frame or first-last-frame generation, the output ratio follows the
first-frame image" — and refuses a stated ratio beside a frame. A reference
clip is the same: "the output ratio and duration follow the input video".

The mosaic is already the target shape. Handing it over as the first frame
*is* the aspect instruction, so there is nothing to argue about, and Seedance
is finishing a picture rather than being asked to make one wider. Luma Reframe
stays registered as the alternative — it takes a clip where this takes a
plate, and it is the better answer for a locked-off shot where recovery has
nothing to offer.

## And the step neither of them can do

After Effects nests the **original composition** over the generated clip at the
rectangle the mosaic was planned around. Only the invented margins survive, so
the performance is untouched by construction rather than preserved by a model
that was asked to preserve it. No browser tool can do this, because none of
them has the plate as a layer.

## Sources

- [Luma Ray 3.2 Reframe — API](https://fal.ai/models/luma/agent/ray/v3.2/reframe/api)
- [Reframe by Luma — overview](https://lumalabs.ai/changelog/reframe-is-here)
- [Luma Video Reframe, seven aspect ratios](https://www.scenario.com/models/luma-video-reframe)
- [Runway Expand Video, portrait to landscape in practice](https://dantaylorwatt.substack.com/p/turning-portrait-videos-into-landscape)
