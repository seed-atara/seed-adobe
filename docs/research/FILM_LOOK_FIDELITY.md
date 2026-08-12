# Film look — what is exact, and what is interpreted

The handoff specifies some stages to the formula and others by description
alone. Both are implemented; only the first kind can be called a match. This
records which is which, so that when the result is compared against the
reference the conversation starts from what is actually known rather than from
an assumption that everything was specified.

Status: written 2026-08-12, at the end of the chain implementation. No
comparison against the reference renderer has been made yet — that needs a
reference frame, which we do not have.

## Exact — transcribed from the specification

| Stage | Note |
| --- | --- |
| Halation threshold | **Where highlights begin (`glare_threshold`), not display white.** Thresholding at 1.0 linear looks obviously right and is wrong for anything a compositor will feed it: a maximum-white sRGB pixel is exactly 1.0 in linear, and the show exposure of 0.97 pulls it below, so halation never fired on ordinary footage at all. The specification says to threshold the bright areas without saying where. |
| Whitepoint tonemap | `x = wp_gain·c`, `out = x(1+x/wp²)/(1+x)`, `out^(1/wp_gamma)`, lerped by `wp_tonemap`. Verified to map `wp/wp_gain` to exactly 1.0. The signature stage; check here first if a comparison fails. |
| Distortion + lateral CA | One combined gather. `scale(r) = 1 + k1·r² + k2·r⁴`, R and B at `scale(r)·(1 ± ca·r)`, G at `scale(r)`. Never two passes. |
| Halation | Threshold, blur at `halation_radius`, tint by `halation_tint`, add back scaled by the stock's `halation` × `halation_scale`; `halation_color` leaks green. |
| Grain amplitude and sizing | Per-channel `grain_rms` × `grain_scale`, clumped at `grain_size` with `grain_size_mul`, generated at `grain_ref_longedge`. `grain_chroma` blends mono to per-channel, `grain_gate` weights shadows against mids. |
| Stock colour | Matrix, saturation, black lift, white rolloff, contrast about pivot, warmth — all per the stock table. |
| ASC-CDL | Slope, offset, power, saturation, in the standard order. |
| Phase order | Both phases, exactly as listed. Non-reorderable by construction. |
| sRGB transfer | The piecewise definition, not a 2.2 power. The difference lives in the bottom two stops, which is where the optical half works. |

## Interpreted — described but not specified

Each of these is implemented from the description and its intent. They are the
places to look first if the look is close but not identical, and each is
marked `INTERPRETED` in the source.

| Stage | What was decided, and why |
| --- | --- |
| Optical vignette | cos⁴ via the identity `1/(1+r²)²` with `r` normalised to the half-diagonal, plus a smooth mechanical term biting only outside `r = 0.66`. Applied in linear as illumination falloff, never as a dark ellipse in display space. |
| Diffusion | A broad blur screened back over the original — a pro-mist lays a low-contrast copy over the picture rather than softening it. |
| Anamorphic streak | Highlights, blurred horizontally only, added back. Horizontal-only is specified; the threshold and radius are not. |
| Bloom | Threshold at `glare_threshold`, blur, add. Achromatic. |
| Veiling glare | Threshold at `glare_threshold`, wide blur, add. |
| Auto levels | 0.1st and 99.9th percentiles per channel, so a few hot pixels cannot drag the match. Default 0, and the spec warns it is easy to overdo. |
| Split tone | Teal shadows and warm highlights weighted by luminance. Coefficients are a judgement. |
| Bleach bypass | Desaturate toward luminance and overlay it back. |
| Dehalo | Clamp toward a small-radius blur only where a pixel is brighter than its surroundings. Runs before sharpen, which *is* specified. |
| Clarity | Unsharp at `clarity_radius`. Negative softens, which is deliberate and useful on generated frames. |
| Sharpen | Fine luminance-only unsharp; chroma untouched. |
| Chroma denoise | Blur, then restore the sharp luminance — so only chroma moves. |
| Fade | Lifted black, scaled to a tenth so the control has usable range. |
| White balance | Channel gains, not a chromatic adaptation transform. The spec gives the controls and their sense, not their matrix. |
| Path to white | AgX-style desaturation toward the peak channel as it approaches the shoulder. |

## Not implemented

**Defocus** and **atmospheric haze**. Both are depth-driven, there is no depth
map, and both are off in the show preset. Their parameters are carried in the
config so a preset round-trips intact, and they are absent rather than
approximated — a fake defocus would be worse than none.

## Deliberate departures

**Blur is three iterated box passes, not a true Gaussian kernel.** At the radii
this chain uses, a tap-per-sample Gaussian costs hundreds of multiplies per
pixel per axis where three boxes cost a constant few, and they converge on a
Gaussian anyway. The visible difference is nil; the difference in render time
decides whether the thing is usable at all.

**Grain is renormalised after clumping.** Blurring reduces variance, so a
clumped noise field is quieter than the stock asks for. Restoring the standard
deviation afterwards makes `grain_rms` mean what it says at any clump size —
and the spec's own grain test measures exactly that.

## A note on the resolution-invariance test

The spec offers this as the check that no radius was written in pixels. Run
against the show preset it passes **even when every radius is hard-coded**,
because that preset has diffusion, bloom and halation at zero and its stock has
no halation — so almost nothing with a radius executes.

The test therefore runs with every spatial stage deliberately switched on. This
was found by mutation: hard-coding `radiusPixels` and confirming the test went
red. It did not, until the config was fixed. Worth remembering for the lens
round-trip and grain tests when those arrive — a test that cannot fail is worse
than no test, because it reassures.
