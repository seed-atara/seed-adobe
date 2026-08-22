# Getting real passes, not just asked-for ones

Researched 2026-08-22. The question: SEED currently gets albedo, normals and
depth by *asking Seedance very precisely*. What would it take to get them
properly, and can any of it run where SEED already runs?

Two findings, and the second one is the useful one.

## Marigold does what Beeble does, in the open

[Marigold](https://github.com/prs-eth/Marigold) (CVPR 2024, best-paper
candidate) repurposes a pretrained latent diffusion model for dense prediction.
The 2025 releases are directly on target:

| model | predicts |
|---|---|
| **Marigold-IID-Appearance v1.1** | albedo, **roughness**, **metallicity** |
| **Marigold-IID-Lighting v1.1** | albedo, **diffuse shading**, non-diffuse residual |
| **Marigold Normals v1.1** | surface normals |
| **Marigold Depth** | monocular depth |

That is essentially Beeble's decomposition — albedo, normals, roughness,
lighting — trained on small synthetic datasets, and open. It is diffusion-based
and therefore heavy: Python, `diffusers`, and a GPU to be usable at video
lengths.

**Cost of adopting it:** a Python sidecar next to the Node service, with its own
environment and model weights. That is a real dependency and a real support
burden, and it should not be added on the strength of a search result. It
belongs behind the same seam as everything else, and it can wait.

## Depth Anything V2 runs in Node, today, with no Python

This is the finding worth acting on.

[Depth Anything V2](https://huggingface.co/onnx-community/depth-anything-v2-small)
has **ONNX weights published by the ONNX community** in small, base and large,
and runs through `@huggingface/transformers` (transformers.js v3), which uses
ONNX Runtime underneath:

```js
import { pipeline } from "@huggingface/transformers";
const depth = await pipeline("depth-estimation", "onnx-community/depth-anything-v2-small");
const { depth: map } = await depth(imageUrl);
```

No Python. No sidecar. It runs in the service process SEED already has, on CPU
if there is no GPU, and the small variant is a modest download.

Known caveat from the issue tracker: it **requires transformers.js v3** — v2
fails on these models, which is the error most people hit.

## What that makes possible without any model at all

Once depth is real, two things follow deterministically — no network, no
weights, no waiting:

**Normals from depth.** The surface normal is the cross product of the depth
gradient. It is standard, exact given the depth, and about thirty lines. A
normal map derived from a *measured* depth is far better than one a language
model drew, and it is free.

**Relighting by recombination.** Albedo × N·L, plus a Blinn-Phong specular
term weighted by roughness, is the Lambert-plus-microfacet split Beeble does
with Cook-Torrance. Given albedo and normals, a new key light is arithmetic.

That is the "beeble with this tool" ask, and most of it is maths this
repository is already the right shape for — the film look core is the same kind
of code.

## The shape this should take

A **pass provider seam**, exactly like `GenerationProvider`, because the same
pass can come from very different places and the rest of SEED should not care:

| provider | passes | cost | quality |
|---|---|---|---|
| **prompted** (Seedance 2.5) | all of them | a generation each | rough, drifts |
| **local depth** (Depth Anything V2, ONNX) | depth | free, offline | real, measured |
| **derived** (in-repo maths) | normals from depth | free, instant | exact given depth |
| **Marigold** (Python sidecar) | albedo, roughness, normals, shading | a GPU | best available open |

And a **recombination stage** that takes whichever passes exist and produces a
relit result, plus a "normal enhance" that uses a real normal map to drive
detail rather than the frequency detailer's gradient guess.

## Order

1. **Recombination maths** — normals from depth, and relight from albedo +
   normals. Pure functions, fully testable, no dependencies. This is the part
   that makes passes *worth having* rather than worth looking at.
2. **Depth Anything V2 via transformers.js** — one dependency, no Python, and
   it turns the derived normals from a guess into a measurement. Worth doing
   as soon as someone approves the download.
3. **Marigold behind a sidecar** — only once 1 and 2 are earning their keep,
   and only if albedo from prompting proves too weak to use.

Prompted passes stay regardless. They are the only route that works on footage
where nothing else does, and they cost nothing to keep once written.

## Sources

- [Marigold (GitHub)](https://github.com/prs-eth/Marigold)
- [Marigold: Affordable Adaptation of Diffusion-Based Image Generators for Image Analysis (arXiv)](https://arxiv.org/html/2505.09358v1)
- [Marigold usage in diffusers](https://huggingface.co/docs/diffusers/using-diffusers/marigold_usage)
- [Depth Anything V2 small, ONNX](https://huggingface.co/onnx-community/depth-anything-v2-small)
- [Depth Anything V2 base, ONNX — README](https://huggingface.co/onnx-community/depth-anything-v2-base/blob/main/README.md)
- [transformers.js issue: Depth Anything V2 needs v3](https://github.com/huggingface/transformers.js/issues/857)
