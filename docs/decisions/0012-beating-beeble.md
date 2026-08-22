# 0012 — Where SEED can beat Beeble

**Status:** first stage built 2026-08-22 (lighting solve and transfer)
**Date:** 2026-08-22

## The honest starting position

Beeble's decomposition is better than ours and will stay better. SwitchLight
recovers normals, albedo, roughness and Fresnel reflectivity from a portrait
and re-renders with Cook-Torrance; SEED asks a generative model for an albedo
and derives normals from an estimated depth map. On a single frame, in a fair
fight, they win.

So the answer is not to build a better decomposition. It is to compete
somewhere they structurally cannot follow.

## What Beeble cannot do, by construction

**SwitchLight relights one image, and you supply the new light.** That is the
whole shape of the product: an image goes in, an HDRI or a light rig goes in,
a relit image comes out. It has no second shot, no library, no timeline and no
memory.

Every one of those is something SEED already has.

## 1. Solve the light off a reference shot — built

The first thing an artist actually wants is not "relight this to an HDRI I
authored". It is **"light this shot the way that shot is lit"** — because the
job is nearly always matching a plate, a hero take, or the shot either side of
a cut.

That is a solvable problem rather than a creative one. Shading is a function of
surface direction alone, so given a shot, its normals and its albedo, the
lighting is recoverable by ordinary least squares: nine second-order spherical
harmonic coefficients per channel, a 9×9 solve, no model and no training.

Then those coefficients light a different shot.

**Built and tested**: `estimateLighting`, `applyLighting`. The test that matters
solves the lighting from a synthetic shot and repaints it, and requires the
repaint to land within twelve code values of the original — if recovered
lighting cannot reproduce the frame it came from, nothing built on it means
anything.

`POST /v1/passes/light-transfer` does it end to end.

**What it cannot do, stated plainly:** second-order harmonics carry soft light.
They cannot carry a hard shadow edge, and the route returns the residual so a
reference with lighting this method cannot express says so rather than quietly
producing a wrong answer. Beeble's own paper lists neutralising strong shadows
as one of its stated limitations too — this is a hard problem for everyone.

## 2. A shot, not a frame — built

Per-frame estimation is exact per frame, and consecutive frames disagree
slightly. That reads as the lamp trembling, and it is the characteristic
failure of applying a single-image method to video.

Averaging the solution across a shot fixes it, and only a tool that knows the
frames belong together can do it. `averageLighting` is built and tested.

## 3. Region-scoped relighting — next

Beeble relights the frame. SEED has **regions** — an artist-placed, now
trackable rectangle over part of the plate.

Relighting only the face while the rest of the shot is untouched is a normal
compositing request and an awkward one for a whole-frame tool. SEED's regions
already produce a sub-comp, a matte and a feathered composite; pointing the
lighting solve at one is mostly plumbing.

## 4. Camera transfer — designed, not built

The other half of "make these two match", and the half nobody offers.

Lighting is not the only thing that separates two shots. Lens distortion,
chromatic aberration, vignette, halation and grain are the *camera*, and SEED
already has an engine with exactly those parameters — the film look.

Today those parameters are authored. They could be **measured from a reference
shot** and applied:

| what | measured from |
|---|---|
| vignette | radial falloff of mean luminance |
| chromatic aberration | radial divergence between channel edges |
| grain | high-frequency residual after a matched blur, by luminance band |
| halation | red-channel bloom around clipped highlights |
| distortion | straight-line curvature, where the frame has any |

Every one is a measurement on an image, none needs a model, and the engine to
apply them exists. This is the same trick as the lighting solve — turning a
matching-by-eye job into a measurement — applied to the optics instead of the
light.

**This is the piece that would make SEED's shot matching genuinely better than
anyone's**, because Beeble does not touch the camera at all and a colourist
matching grain and halation by hand is doing it by eye.

## 5. Identity that survives relighting — the long game

SEED has Items: a subject known across shots, with plates and revisions.
Beeble has a frame.

Once albedo passes are routine, an Item's identity plates can be **albedo
plates** — the subject with the lighting removed. That is a strictly better
identity carrier, because a lit plate teaches the model the lamp along with the
face. Then relighting is not a per-shot fix at all: the identity is stored
unlit and lit to match wherever it lands.

## The order

1. **Lighting solve and transfer** — built.
2. **Shot-level averaging** — built.
3. **Camera transfer** — the largest win still available, and entirely
   measurement rather than research.
4. **Region-scoped relighting** — mostly plumbing over what regions already do.
5. **Albedo identity plates** — needs the albedo experiment to come back
   positive first.

## What this does not claim

None of this makes SEED's *decomposition* competitive with Beeble's, and it
should not be sold as though it does. The bet is that decomposition is a
component and matching is the job — and that a tool holding the library, the
timeline and the comp can do the job better than one holding an image, even
with a worse component.
