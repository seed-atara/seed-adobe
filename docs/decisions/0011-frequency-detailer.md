# 0011 — SEED Frequency Detailer

**Status:** accepted 2026-08-20, built for After Effects
**Date:** 2026-08-20

## The problem

A reskinned render (Beeble, Seedance, anything generative) comes back with the
right look but the wrong amount of *detail*. Two distinct failures, and they
need separating because the fix differs:

1. **Soft.** The render has lost pore, weave, hair and fabric detail the plate
   had. Nothing invented it; it is simply not there.
2. **Drift.** The render has moved away from the likeness — features shifted,
   proportions changed slightly.

Detail transfer fixes (1). It does **not** fix (2), and applied naively it
makes (2) worse, because misaligned detail lands as double edges. The effect
has to be honest about that boundary rather than pretend to close it.

## The technique

The manual version, done today by hand in the timeline:

```
detail  = plate / blur(plate)      # a ratio image, ~1.0 where the plate is flat
tweak   = colour-correct(detail)
out     = render * tweak
```

This is the **ratio** (divide/multiply) form of frequency separation, not the
**additive** (subtract/add, "Linear Light", high-pass + offset 128) form that
Photoshop retouching tutorials describe. The distinction matters here and is
the reason the manual workflow works:

|  | additive | ratio |
|---|---|---|
| separation | `H = P − blur(P)` | `H = P ÷ blur(P)` |
| recombine | `out = L + H` | `out = L × H` |
| detail is | an absolute amplitude | a *relative* contrast |
| across two images | imposes the plate's brightness | carries only its texture |

Additive detail carries the plate's exposure with it: transfer it onto a render
that is graded differently and the texture arrives too strong in the shadows
and too weak in the highlights. The ratio form is exposure-invariant — a pore
that is 3% darker than its surroundings stays 3% darker whatever the render's
brightness is. For same-image retouching either works; for **cross-image
transfer**, which is what this is, the ratio form is the correct one.

It is well established in compositing for exactly this purpose — restoring
detail lost to edge extension, clean-up and paint — where it is usually
described as blur-and-divide, then multiply back over the target.

## Proposed maths

Per pixel, in **scene-linear**:

```
B  = blur(P, radius)                     # 3-pass box ≈ Gaussian, separable
D  = P / max(B, floor)                   # the detail ratio
D' = 1 + (D − 1) · protect               # shadow/highlight protection
D' = clamp(D' ^ gain, lo, hi)            # shaping and a halo/noise ceiling
T' = lerp(T, blur(T, radius), replace)   # how much of the render's own detail to drop
out = T' · D'
```

Notes on each choice:

- **Linear, not display.** A ratio in linear space is a shading/reflectance
  separation — physically what surface texture is. In display space the same
  ratio means different things at different brightnesses. The core already has
  `SrgbToLinear`/`LinearToSrgb`.
- **`D ^ gain`, not `1 + (D−1)·gain`.** A ratio scales naturally by
  exponentiation — that is linear in log space, which keeps the operation
  multiplicative and symmetric. Doubling detail and then halving it returns
  exactly where it started; the linear form does not.
- **`max(B, floor)`.** The divide explodes as the blurred plate approaches
  black, which is the single most common way this technique produces garbage.
- **`replace`** is the answer to "gets a bit blurry". At `0` the render keeps
  its own high frequency and the plate's is added on top — the current manual
  behaviour, and prone to doubling. At `1` the render's high frequency is
  discarded and *replaced* by the plate's. Replace is usually what a soft AI
  render actually wants.
- **`clamp(lo, hi)`** bounds the ratio, which bounds haloing at hard edges and
  stops grain being multiplied into noise.

## The drift guard

The part worth arguing about. When the render has drifted, plate detail is in
the wrong place and multiplying it in produces ghosting.

Proposed: attenuate the detail where the two images' **local structure
disagrees**. Both blurred fields are already computed, so the test is nearly
free:

```
agree = 1 − |normalise(blur(P)) − normalise(blur(T))|
D'    = 1 + (D' − 1) · smoothstep(agree, tolerance)
```

Where the plate and the render describe the same shapes, detail transfers at
full strength. Where they have diverged, it fades out rather than ghosting.
This is a *mitigation*, not alignment — it makes drift show up as missing
detail instead of doubled edges, which is the better failure. Real alignment
(optical flow, or a warp driven by landmarks) is a much larger piece of work
and is explicitly out of scope.

**This is the one part I would most like a second opinion on before building.**

## Parameters

| group | control | range | default |
|---|---|---|---|
| | Detail source | layer | none |
| Separation | Radius | 0–5% of frame diagonal | 0.4% |
| | Working space | linear / display | linear |
| Detail | Gain | 0–4 | 1.0 |
| | Replace render detail | 0–1 | 0.7 |
| | Channels | luma / RGB | luma |
| Protection | Shadow floor | 0–0.2 | 0.02 |
| | Highlight rolloff | 0–1 | 0.3 |
| | Detail limit | 1–8 | 4.0 |
| Drift | Structure guard | 0–1 | 0.5 |
| | Tolerance | 0–1 | 0.3 |
| | Show guard | bool | off |
| | Mix | 0–1 | 1.0 |

**Radius as a fraction of the diagonal**, not pixels, so a setting found at
1440×1440 still means the same thing on a 5750×2818 plate. `RadiusPixels`
already does this for the film look.

**Luma-only by default.** Transferring chroma detail across two images that
were graded differently is the usual source of colour fringing.

**Show guard** renders the structure-agreement map, so drift can be seen rather
than guessed at.

## Where it lives

A new plugin, `plugins/seed-frequency-detailer`, built the same way as
`seed-film-look` — which means the traps already paid for there apply and are
already documented: the PiPL resource is not optional, and the PiPL and code
versions must agree or After Effects refuses with error 8001.

```
plugins/seed-frequency-detailer/
  src/core/detail.{h,cpp}      # host-free, testable, the actual maths
  src/ae/SeedFrequencyDetailer.cpp
  src/ae/SeedFrequencyDetailerPiPL.r
  test/parity.cpp              # against vectors from a TS reference
```

The core stays free of any Adobe header, as `look.cpp` does, so it can be
tested outside the host — which matters because nothing in the suite can run an
`.aex`.

**Reuse:** the separable box blur in `look.cpp` is already cache-tuned and
thread-banded; the radius helper, the linear/display conversions and the
BGRA/ARGB channel-order handling all carry over. The row-order accumulator and
the Premiere pixel-format work are the expensive lessons here and none of them
need relearning.

## Risks and unknowns

- **A second input layer in Premiere.** After Effects handles `PF_ADD_LAYER`
  and `checkout_layer_pixels` normally. Premiere's support for layer parameters
  through the AE plugin API is weaker and I have **not** verified it. If it does
  not work, Premiere gets a degraded mode — sharpen-from-self, no external
  detail source — rather than a broken effect. This needs measuring before the
  Premiere path is promised.
- **Cost.** Two blurs at full resolution instead of the film look's one. On a
  5750×2818 plate that is the dominant cost. The existing blur is already the
  optimised one; if it is too slow, the honest answer is the same as ADR 0008 —
  a GPU path, not micro-optimisation.
- **Alpha.** Detail transfer on a premultiplied edge will do strange things.
  Proposal: operate unpremultiplied, restore on the way out.

## Scope

**v1 (proposed):** everything in the table above, After Effects only, with the
core under parity test. Premiere declared only once measured.

**Later, deliberately not now:** alignment or warping; a service-side provider
like the film look (it takes two inputs, and the provider interface assumes
one); guided/edge-aware blur instead of Gaussian.

## Decided

All four as proposed, with Premiere dropped entirely for now rather than
attempted and degraded: replace defaults to 0.7, the drift guard is built,
detail is luma-only by default, and the effect is After Effects alone.

## What the tests found while building it

Two things, both of which would have shipped invisibly.

**The guard treated one-sided structure as agreement.** An edge present in the
plate and absent from the render is *drift* — the single case the guard exists
for — and the first implementation scored it 1.0, passing detail straight onto
a feature that had moved. Where neither image has structure there is genuinely
nothing to dispute; where only one does, there is. Now separated.

**The exposure-invariance test was measuring the encoding.** It built both
plates with a multiplicative amplitude in sRGB, which is not the same relative
contrast in linear — so it reported a 2.3x difference that was the test's, not
the technique's. Rebuilt in linear, the same detail lands from plates four
stops apart to within 15%.

## Still unproven

The core is tested; the After Effects glue is not, and cannot be — nothing in
the suite can run an . Specifically unverified until someone opens AE:
that the layer parameter checks out at all, that  with
 behaves as an unset source rather than an error, and
that the unpremultiply/premultiply round trip is right for AE's worlds.
