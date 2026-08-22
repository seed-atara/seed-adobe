> **Amended by ADR 0016 (2026-08-23).** The decision to register
> `SwitchXProvider` alongside our own switch has been reversed: it has been
> measured, and the adapter is removed. Everything below about *how* the two
> differ still holds and is why ours can replace it for the common case —
> though not for genuinely generative work, which is Seedance's job.

# 0015 — Switching the scene by measurement

**Status:** built 2026-08-23 — `POST /v1/switch`, and SwitchX registered beside
it for comparison
**Date:** 2026-08-23
**Corrects:** ADR 0012 and the Beeble research note, both of which assumed
Beeble had no generative product

## What changed

Beeble shipped **SwitchX**, a generative video-to-video model, in February 2026.
The earlier position — "they do inverse rendering, we do production; they are
consecutive stages, not competitors" — was written about **SwitchLight** and
does not survive contact with SwitchX, which competes directly with the thing
SEED does: put a subject in a different scene and keep the performance.

SwitchX's shape, verified against the live API (see the research note):

- source video or image, plus a prompt **or** a reference image
- an **alpha mask** decides what survives: white retained and relit, black
  generated. `auto`, `fill`, `custom`, and `select` — the last propagating one
  keyframe's matte across the shot
- returns a render **and an alpha matte**, which is a compositor's output
- 720 or 1080, ≤240 frames, 5–60 seconds by tier, ~5 minutes for 2K

It is good, and the alpha-mask-as-central-control is the right idea.

## The decision

Build `POST /v1/switch` doing the same job by **measurement**, and register
`SwitchXProvider` beside it so the two can be run on the same frame.

Not "instead of". Registering the competitor is the same call this project made
with IC-Light in ADR 0012: where someone else's component is better, run it.
What is worth owning is the part that needs the library, the timeline and the
comp.

### How ours differs, concretely

| | SwitchX | SEED `/v1/switch` |
|---|---|---|
| the new light | inferred from the reference by a model | **solved**: the reference is projected onto nine spherical harmonics, and those coefficients shade the subject's own measured normals |
| the matte | inferred, or supplied | **measured** from depth (Otsu on the depth histogram), or supplied |
| the subject | resynthesised, held in place by source pixels | never resynthesised — there is no identity to drift because none is being guessed |
| cost | paid, per second | free, local, instant |
| can it invent? | yes | **no** |
| optics | untouched | measurable and transferable separately (ADR 0012) |

The last two rows are the honest summary. Ours cannot invent a wardrobe, add a
contact shadow the geometry does not imply, or repair a badly cut matte. Where
the job is genuinely "imagine a new scene", SwitchX is the right tool and this
is not it.

## What was built

- `packages/media/src/matte.ts` — `otsuThreshold`, `matteFromDepth`,
  `featherMatte`, `compositeOver`, `invertMatte`, `matteCoverage`.
- `POST /v1/switch` — matte (`auto` from measured depth, `custom` supplied,
  `fill` whole frame) → lighting solved from the reference → subject shaded on
  its own normals → composited → **render and matte both registered**.
- `SwitchXProvider` in `packages/providers/src/beeble/`.

Verified end to end against a running service: render and matte registered,
32% of the frame kept, lighting residual reported.

## Two things the route reports rather than hides

**The lighting residual.** Second-order harmonics carry soft light and no hard
shadow edge. A reference whose lighting cannot be expressed this way comes back
with a high residual and `expressible: false`, rather than quietly producing a
soft answer to a sharp question. Beeble's own paper lists neutralising strong
shadows among *its* limitations too — this is hard for everyone.

**Matte coverage.** How much of the frame survived, as a number. A matte that
kept 3% or 97% of the frame is usually a threshold that went wrong, and the
artist should see that before the render rather than after.

## A known approximation, stated

The source frame stands in for albedo. It is not one — a lit plate carries its
original light, so a full-strength transfer double-lights it. That is what
`lightAmount` is for and why it defaults to 0.85 rather than 1. Doing this
properly needs an albedo pass, which `POST /v1/passes` can already generate;
wiring `/v1/switch` to prefer a real albedo when one exists is the next
improvement and does not change the shape of anything.

## What SwitchX has that we should take seriously

**`select` mode.** One matte, propagated across a shot. SEED has regions that
track, so the machinery is adjacent — but propagating a *matte* is not the same
as propagating a rectangle, and claiming otherwise would be the mistake this
ADR exists to correct.
