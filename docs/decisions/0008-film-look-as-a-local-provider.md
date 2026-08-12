# 0008 — The film look is a provider, and the AE experience is staged

Status: accepted
Date: 2026-08-12

## Context

A standalone handoff package (`reference/filmlook`, kept out of the repository)
specifies a film-look and lens-distortion pipeline: a 66-parameter tonal engine
with five film stocks, eleven real lens solves in 3DE4-compatible models, and
the shipped look of a delivered feature trailer matched against the show's Nuke
master comp. It is specification and data only — the implementation is ours,
and the package explicitly recommends the AE Effect SDK.

Two things make this worth building into SEED rather than beside it.

**The chain was already authored against AI-generated frames.** `dehalo` before
sharpen for upscaler rims, `chroma_denoise` for "AI colour speckle", negative
`clarity` because over-detailed frames need softening rather than sharpening.
These are remedies for exactly what a generative renderer produces, written by
someone who had already been fighting it.

**It closes a hole that is open in the generation loop today.** The spec's rule
is that camera artefacts do not stack. SEED currently captures a frame carrying
the plate's own distortion, vignetting and grain, hands it to a model that bakes
those artefacts into its output, and would then apply a look on top — a third
helping of each. The correct shape is the plate workflow every VFX facility
already uses, and it maps onto our loop directly:

```
capture -> undistort + degrain -> generate (the model sees clean optics)
        -> redistort + regrain + look -> insert
```

That is a quality argument, not a feature: it is the difference between a
generated shot that sits in the comp and one that reads as pasted on.

## Decision

### The look is a provider, not a new subsystem

A look is a deterministic generation: inputs, parameters, one output,
reproducible from a seed, with no network call. Putting it behind the existing
provider abstraction means it inherits jobs, lineage, recipes, the library,
reopen/branch/variation, insert at playhead, placeholders and the
iterate-in-place flow without any of them being written again. Regrading a shot
becomes the same gesture as re-rendering it, and a look is as reproducible as a
generation because it is one.

The alternative — a separate "treatment" pathway — would duplicate all of that
and would put looks outside the provenance model, which is the one thing this
product is actually for.

### The engine is a pure package with no host in it

`packages/filmlook` takes float buffers and a config and returns float buffers.
No Adobe, no service, no filesystem. Everything the spec asks to be tested —
resolution invariance, lens round-trip, grain RMS against a grey patch — is
then testable in CI, and the same core can later be compiled to a GPU shader or
ported to a plugin without being rewritten from a description of itself.

### The three tools stay separate

Look, Lens and Grain, for the handoff's reasons — order is correctness, lens
geometry belongs at a different point in the comp than the look — plus one that
is specific to us. If SEED bakes grain into a result and the artist then grades
it in After Effects, grain is no longer last, which is the single mistake the
spec warns about most. Grain has to remain a terminal step that can be applied
after any grading the artist does downstream.

### The lens ships as ST maps

The service bakes 32-bit EXR ST maps from a solve and registers them as assets
with the solve's provenance. Runtime cost is one bilinear gather, the maps
survive across frames of a shot, and a comp artist can inspect and reuse them.
The spec recommends this as the one route to support if only one is supported;
it is doubly right here, because it keeps the lens mathematics out of the AE
render entirely and inside the service that already owns media and provenance.

### The After Effects experience is staged, and filters are the destination

Artists want effects they drag onto a layer: live in the viewer, keyframeable,
rendering with the comp. That is the correct end state and it needs the C++
Effect SDK, which `CLAUDE.md` puts out of V0 scope. So the experience arrives in
three steps, each usable on its own:

1. **Bake.** The panel applies a look to an asset; the service renders it; the
   result registers as a child asset and can replace the shot in the timeline
   through the flow built for iteration. Exact from day one, not live.
2. **LUT.** The chain divides cleanly into per-pixel colour and spatial work.
   Exposure, both tonemaps, stock colour, grade, temp/tint, CDL, split tone,
   bleach and fade are all per-pixel, which is precisely what a 3D LUT
   represents. SEED generates a `.cube` from the same config and the artist
   applies it as a real AE effect. That covers the tonal signature — what makes
   it *this* film — while the spatial half stays in the bake.
3. **Plugins.** `SEED Film Look`, `SEED Lens`, `SEED Grain` as native effects,
   ported from the pure core rather than reimplemented from prose.

The order is not arbitrary. **A LUT cannot be validated without an exact
reference to diff it against**, so the engine has to exist before the filter
that approximates it — which is also the argument for why the bake is first
rather than a detour.

## Consequences

The config is the single source of truth across all three steps. A plugin, a
LUT and a bake all read the same preset JSON and the same merge rule
(`defaults ← look ← intensity ← user`), so they cannot drift into three looks
wearing one name.

Video will need GPU work. The chain is per-frame separable blurs plus one
gather; in plain JavaScript a ten-second clip is not viable. The spec's Phase
A/B checkpoint — cache at `linear_to_srgb()` so grade changes re-run only the
display half — is worth implementing for that reason alone, and it is also what
makes interactive grading feasible later.

Grain and H.264 are in tension: grain is the highest-entropy thing you can put
into a video before encoding it. Whatever encoder settings the video path uses
will need revisiting once grain is real, alongside the colour findings already
in `MODEL_API_NOTES.md`.

## What was verified before accepting this

The handoff claims internal consistency; it was checked rather than believed.

- The documented merge rule reproduces the shipped `resolved_half` config
  **exactly — 66 of 66 parameters, zero mismatches.** That becomes the golden
  vector for the config layer.
- `intensity_full` is exactly twice `intensity_half` on all nine artefact
  parameters, as the Intensity-slider design requires.
- `kodak_5217`'s asymmetric grain matches its prose description: `grain_rms`
  0.0145 / 0.0127 / 0.0262, `grain_size_mul` 0.19 / 1.0 / 1.17, identity
  matrix, global desaturation 0.85, no black lift or white rolloff.

## Open questions, and one blocker

**Blocker — colour space is declared but never recorded.** `AeContext` has an
optional `colorSpace` and the host never populates it. The entire chain assumes
sRGB-encoded 0..1 in and out, and the spec is explicit that ambiguity here
produces double-gamma, which reads as "too contrasty" and gets corrected with a
grade that makes it worse. Capture must record the project working space and
bit depth, and SEED should say so when a project is not 32-bit float, before any
of this can be trusted.

**The anamorphic contradicts the interpolation spec.** `03_LENS_SPEC` says
multi-state lenses interpolate on focal length with monotone PCHIP. The one
anamorphic solve has `focal_mm: null` on both states and varies on **focus**
(236 cm and 610 cm). Interpolation must key off whichever axis actually varies,
and the author should confirm which was intended.

**Its squeeze terms are inert.** `squeeze_x` and `squeeze_y` are both 1.0
despite `squeeze_nominal: 2`, implying desqueeze is a format concern rather than
part of the model. Worth confirming rather than assuming.

**Prime solves are an order of magnitude looser than the zooms.** The 14 mm is
plumbline-solved at `rms_px` 1.36 with all-zero tangential terms; the
grid-solved 70-200 is 0.12. The package says to treat primes as lower
confidence — that belongs in the UI, not only in the documentation.

**Confidentiality.** The lens profiles carry real vendor serials and lens names
from an unannounced production. `reference/` is git-ignored and nothing has been
published. If profiles ever ship inside the product, the serials and names must
be stripped: the coefficients are what an implementation needs, and the labels
are the only part that carries risk.
