# How the industry actually widens a shot

Researched 2026-08-24. Written after building a version without looking, which
was a mistake — the prior art names the technique, and it names the part we got
wrong.

## The professional equivalent has a name: Mega Plate

Boris FX **Mocha Pro** ships exactly this feature. From their own material, it
"extracts a seamless larger-than-raster image from moving camera footage for set
extensions and clean-ups", built on "planar track and temporal frame analysis".

That is the same two ideas SEED's expansion uses:

| Mocha Mega Plate | SEED |
| --- | --- |
| stitch frames into a larger-than-raster plate | `expandFromShot` |
| temporal frame analysis to drop movers | per-pixel median |
| export the plate **with tracking data** for re-projection in Nuke | `windows` — where the delivery frame looks, per sample |

The workflow is the confirmation that matters: professionals do **not** hand a
plate to a comp as a static background. They export it *with the track*, and the
comp re-projects it so the background moves with the camera. That is what the
`padToTravel` / `windows` work implements, and it is why a delivery-sized plate
was wrong — slide it to follow a pan and its own edge walks into shot.

## Where ours is naive: planar, not translational

Mocha tracks a **plane** — a homography, eight degrees of freedom: translation,
rotation, scale, shear and perspective. SEED estimates a **translation**, two.

That single difference explains the symptoms on real footage:

- a handheld shot that rolls slightly cannot be expressed as an offset, so the
  match degrades and frames get rejected ("1 too weak to match");
- a shot that drifts or breathes on the lens reads as vertical wander, which
  accumulates;
- a dolly cannot be expressed at all, because parallax is not a 2D warp of any
  kind — and no tracker fixes that. Mocha's answer there is the same as ours:
  it is out of scope for stitching.

Upgrading to a homography is the single highest-value improvement available to
this feature, and it is well-trodden: estimate per-frame with RANSAC over
matched points or a direct (ECC-style) alignment, then warp each frame into the
plate rather than offsetting it. It subsumes the current translation solve — a
homography with only the translation terms non-zero *is* the current behaviour —
so it is an upgrade rather than a rewrite.

## Adjacent techniques worth knowing

- **Cylindrical / spherical projection.** Panorama stitchers reproject into a
  curved space before blending, because a wide pan on a rectilinear plane
  stretches badly at the edges. Relevant once pans get wide; irrelevant for the
  20-40% expansions this feature targets.
- **Content-Aware Fill (After Effects)** fills a masked region using *other
  frames* of the same shot — the same "the answer is elsewhere in the footage"
  insight, applied to removal rather than extension. It is already in the
  artist's panel and is the right tool for a locked-off shot with something to
  paint out.
- **BCC Reframe** solves the vertical-to-horizontal problem cosmetically:
  blurred, stretched or mirrored side panels. Cheap, instant, no invention, and
  honestly the right answer for a lot of social deliverables.
- **Seam blending.** Stitchers feather or graph-cut across the join. Ours takes a
  per-pixel median with no blend, so a plate assembled from frames with a slight
  exposure difference can show a step. Colour matching each frame to the
  reference before accumulating is the cheap fix; SEED already measures colour
  (`measureColour`, `proposeLevels`) and does not yet use it here.

## What this changes

Nothing about the architecture — which the prior art endorses — and two things
about the roadmap:

1. **Planar (homography) tracking** replaces the translation solve. Highest
   value, and it is what separates "works on a tripod pan" from "works on a
   shot".
2. **Exposure matching before accumulation**, so the median does not average
   across a brightness step.

## Sources

- [Mocha Pro — planar tracking and VFX](https://borisfx.com/products/mocha-pro/)
- [Mocha Pro 2020 adds new tools, incl. Mega Plate](https://blog.borisfx.com/mocha-pro-2020-adds-new-tools-for-advanced-visual-effects-and-clean-up-tasks)
- [Mocha Pro 2020 review](https://www.premiumbeat.com/blog/review-mocha-pro-2020/)
- [Professional compositing techniques](https://aitorecheveste.com/02-professional-compositing-techniques/)
