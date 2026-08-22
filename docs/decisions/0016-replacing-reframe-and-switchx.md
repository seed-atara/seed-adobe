# 0016 — SEED's own expansion and switch replace the bought ones

**Status:** done 2026-08-23 — `ReframeProvider` and `SwitchXProvider` removed
**Date:** 2026-08-23
**Supersedes:** ADR 0013's "Reframe as it stands" step, and ADR 0015's decision
to register SwitchX alongside our own switch

## The decision

Luma Reframe and Beeble SwitchX are no longer registered, and their adapters are
deleted. `POST /v1/expand/*` and `POST /v1/switch` are the product.

They were built to be measured against, and now they have been. Keeping a paid
provider in the list once ours does the job means offering an artist a worse and
more expensive answer beside a better free one, and asking them to know the
difference.

## Why ours replaces Reframe

Reframe invents every new edge. Ours recovers first:

| | Luma Reframe | SEED expand |
|---|---|---|
| the new edges | invented, every shot | recovered from the footage wherever the camera saw them |
| cost | ~$0.06–0.36 per source second | free to recover; the remainder goes to Seedance, already paid for |
| aspects | six, fixed | any |
| length | ≤30s | whatever the host can render |
| the original | re-encoded through the model | composited back on top, bit-exact |
| what it tells you | nothing until you have paid | coverage per edge, before you commit |

The last two rows are the ones that matter in a comp. Reframe hands back a new
clip; ours hands back the *original* over a filled canvas, so the performance
that shipped is the performance that was shot.

And the placement control falls out of it: because coverage is measured per
edge, an artist can see that pinning the source left makes a rightward pan 100%
recoverable where centring it makes it 50%. Nothing that treats reframing as a
black box can offer that.

## Why ours replaces SwitchX

Not on every axis, and this is the honest part.

**SwitchX can invent and ours cannot.** A new wardrobe, a scene that was never
photographed, a changed camera perspective — those are generative, and if that
is the job then a generator is the tool. SEED has Seedance for exactly that.

What ours replaces is the job SwitchX is *usually* used for: put this subject
against that background with the light matched. There, measuring beats
generating:

| | Beeble SwitchX | SEED switch |
|---|---|---|
| the new light | inferred by a model | solved — nine harmonics off the reference, onto the subject's own normals |
| the subject | resynthesised, held by source pixels | never resynthesised; there is no identity to drift |
| the matte | inferred, or supplied | measured from depth, or supplied |
| cost | paid, per tier, ~5 min for 2K | free, local, instant |
| resolution | 720 or 1080 | whatever the plate is |
| limits | ≤240 frames, 5–60s by tier | none of its own |

So the split is: **measure when the answer is in the footage, generate when it
genuinely is not** — which is the same rule the expansion follows, and the thing
this whole layer is for.

## What is lost, and how to get it back

The A/B comparison. ADR 0015 registered SwitchX partly so the two could be run
on the same frame, and that is gone.

It is one `git revert` away — both adapters were complete, tested against their
published contracts, and are in the history at `394d298` and `ff4dc18`. If a
shot arrives where ours is visibly worse, that is worth knowing and worth
restoring the comparison for. The reason not to keep it registered is that a
provider list is a menu, not an archive.

`FAL_KEY` still matters: IC-Light stays (ADR 0012 — do not compete with it, run
it). `BEEBLE_API_KEY` and `FAL_REFRAME_MODEL` are no longer read.

## A bug this review caught

Worth recording because it was silent and it was in the number the whole feature
rests on.

`measureCoverage` strode over frames to spread its sampling. On a shot that is
static apart from a single handheld jolt, the one frame that saw new pixels was
the frame stepped over, and coverage reported **0% recoverable when 42% was**.
An artist reading that would have paid Luma for pixels they already owned.

Coverage now visits every frame; spreading is handled per pixel by reservoir
sampling, deterministic so the same shot always yields the same plate. There is
a regression test with the jolt in it.
