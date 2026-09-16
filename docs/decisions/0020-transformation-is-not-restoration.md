# 0020 — A transformation is not a restoration

**Status:** built 2026-09-16 — `POST /v1/transform`, `/transform/keyframe`,
`/transform/presets`, `/transform/agreement`, and a Transform tab
**Date:** 2026-09-16

## The report

Summer-to-winter, run through the restore path, came back as a different shot
that happened to be wintry: the camera had moved, the buildings had changed
shape, the people were other people. A director checking it against the plate
sees that immediately, and it is the difference between a usable comp and a
pitch image.

## Why it happened

Two causes, both structural rather than a matter of wording.

**The licence was unbounded.** The only control that would make a restore
change anything was the freedom slider, whose top band reads *"reinterpret the
surfaces, materials, textures and light freely ... as though the same scene had
been shot again"*. That is permission to change everything, granted in order to
obtain one change. Correct for a restoration — where nothing is supposed to
become a different thing and the licence is only over rendering — and exactly
wrong here.

**The key-frame prompt contradicted the request.** It insists every object
stays *"exactly what it is"* with *"the direction of the light unchanged"*,
which cannot hold at the same time as "make it winter". A contradicted model
resolves the contradiction arbitrarily and differently each run, which is
precisely the inconsistency that looked like randomness.

## The decision

Separate the axis that may change from the invariants that may not, in a module
of its own rather than as another restore preset.

- **No freedom slider.** A `depth` instead — how far into the scene the named
  change reaches — and the plate lock holds at every setting of it. Surface,
  Seasonal, Full: on top of the world, through the world, or into what the
  people are wearing. The last is where identity risk lives, so it is opt-in.
- **`KEEP`, enumerated.** Camera, geometry, sun position, identity, staging,
  cuts. Long and specific on purpose — the one place in this codebase where a
  wall of constraint is right, because here the model has a genuine licence and
  the constraint is what bounds it.
- **Presets describe what the season does to a place**, not what a picture of
  that season looks like. "Snow lies on every upward-facing surface" renders
  snow onto the surfaces already in frame; "a beautiful winter scene" renders
  somewhere else. Every preset opens `The same place...` and a test holds it.
- **Sun direction is an invariant; light quality is part of the change.**
  Restoration never had to draw that line. Collapse it and you either freeze the
  season or unpin every shadow in the comp.

## The part that is new

Restoration is judged by eye, because "is it sharper" is a taste question. A
transformation is judged by wiping it against the plate, and **"did anything
move" is not a taste question**. So it gets a number: `POST
/v1/transform/agreement`, before the expensive half of the job is paid for.

It is deliberately **not** a similarity score. A correct summer-to-winter is
*supposed* to be dissimilar — bare branches carry far more edge detail than
foliage, snow erases ground texture entirely — so scoring similarity would
punish the model for doing the job and argue for the timid result over the
right one. It measures displacement instead: tile the frame, find the offset
that best aligns each tile with the plate. Surfaces repainted completely report
zero. Content that slid reports how far, and where.

## Three things the measurement got wrong first, all found by running it

**Ties went to the corner of the search window.** Comparing a frame against
*itself* flagged 26% of tiles as drifted. Plates are full of periodic structure
— brick, railings, repeated windows — which correlates exactly as well one
period away as at zero, and a plain `>` keeps whichever offset the loop reached
first. Ties now resolve toward "it did not move". An alarm that fires on
masonry is one an artist learns to ignore.

**The aspect was assumed to match.** Both frames were reduced to a common width
and the comparison refused if the heights disagreed, on the reasoning that no
aspect is ever sent so a render comes back shaped like its source. False: a
2560x1440 plate came back from Seedream at 5504x3040 — 1.81:1, not 16:9 — and
the comparison refused to run at all. The result is now forced onto the plate's
exact working dimensions, because these frames are being compared *as framed*.

**The search window was too small to be honest.** The default searched 4% of
frame width, and the first real pair reported a median of 96.6px against a
2560px plate. That looked like a number and was the ceiling. Widening the
window moved it to 143.6px, where it stayed. Tiles that hit the edge are now
counted as `saturated` and the verdict carries `truncated`, because
under-reporting drift is the one direction this must not fail in.

## What it says about the work already done

Run against the last key frame from the restoration work — the one whose
framing lock was reported here as fixed — it reports **143.6px median drift,
5.6% of frame width, 0% of regions held**. A 50/50 blend confirms it: the
squadron code `DU◉U` appears twice.

The framing lock reduced the recomposition and did not stop it, and the
eyeball verdict that called it fixed was too generous. That is the argument for
the measurement existing.
