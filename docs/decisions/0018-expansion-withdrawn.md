# 0018 — Aspect expansion is withdrawn, not iterated on

**Status:** done 2026-08-24 — `/v1/expand/*`, the Expand tab, and the mosaic,
alignment and letterbox modules are deleted
**Date:** 2026-08-24
**Withdraws:** ADR 0013, ADR 0014, ADR 0017, and the expand half of ADR 0016

## The decision

Everything SEED built for aspect expansion is removed from the tree. It is
preserved at the tag `expand-attempt-1` (`31390dc`) and nowhere else.

`ReframeProvider` is again the only expansion route. `/v1/switch` is untouched
and moved to `apps/service/src/routes/switch.ts`, which it should have had from
the start.

## Why

It did not work on the footage it was built for, and it was reported as
working before anyone had run it end to end inside After Effects. The parts
had been measured in isolation — frames decoded, a plate was built, a margin
fill came back correct in 13.7s — and that was written up as a closed loop.
The one link nobody had exercised, assembling the comp, was the link the
artist actually needs.

Two errors, and they compound:

1. **The feature was validated on synthetic frames at toy resolutions.** Three
   separate bugs lived in code paths those fixtures never reached — a tracker
   that quantised offsets to multiples of six on any real plate, a decoder that
   rejected the 16-bit PNGs After Effects actually writes, and a planar track
   that took 19.5 seconds a frame pair. A green suite reported none of it.
2. **Progress was reported from component measurements rather than from the
   product working.** Coverage percentages and per-stage timings are not
   evidence that an artist can expand a shot; only an expanded shot is.

## What replaces it

Nothing yet, deliberately. Whatever is built next starts from a shot in After
Effects and is not written up until that shot is finished, in the application,
and looked at.

## What is worth keeping from the attempt, if anything is

Only two findings, and both are constraints rather than code:

- **Seedance cannot widen a shot while following it.** Measured, twice: a first
  frame and a reference video are mutually exclusive, and a reference video
  makes the output follow the input's ratio. Any design that assumes otherwise
  is dead before it starts.
- **A homography cannot express parallax.** A dolly cannot be stitched from a
  2D track by any method. If a future approach depends on recovering real
  pixels from camera motion, it works for pans and tilts and for nothing else.
