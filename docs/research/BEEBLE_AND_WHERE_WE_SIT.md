# Beeble, and where SEED sits next to it

Researched 2026-08-22, from the SwitchLight paper and Beeble's own material.

## Beeble is not a generative model, and that is the whole story

The instinct is to file Beeble alongside Seedance and Kling. It is a different
kind of machine entirely, and understanding that explains why it gives better
reskinning results than anything generative does.

SwitchLight performs **inverse rendering**. It decomposes a portrait into five
physical intrinsics:

| intrinsic | what it is |
|---|---|
| surface normals | the geometry of the face, per pixel |
| albedo | the surface colour with all lighting removed |
| roughness (α) | how sharp or diffuse a highlight is |
| Fresnel reflectivity (f₀) | how reflective the surface is at grazing angles |
| source lighting | the light that was there, as "convolved HDRIs" using Phong lobes |

Then it **re-renders**: a Cook-Torrance pass computes `L_PBR = L_diffuse +
L_specular` under the new illumination, accounting for microfacet
distribution, geometric attenuation and Fresnel terms — and a neural network
refines that result, taking albedo alongside the diffuse and specular renders.
The pre-training is MMAE, a masked autoencoder variant with dynamic masking
plus perceptual and adversarial losses.

**Nothing is invented.** The geometry and the albedo come from the actual
footage. That is why the likeness never drifts: there is no likeness being
guessed at. It is the same person, relit.

Seedance resynthesises the pixels and approximates the identity from
references. Drift is not a bug there, it is the mechanism. Beeble cannot drift
and also cannot change what is in the shot.

## Where that leaves SEED

They are not competitors. They are consecutive stages, which is exactly how
this project already uses them:

```
real footage → Beeble (relight, keep identity) → SEED/Seedance (change what it is)
             → SEED detailer (put the real detail back) → SEED film look
```

Beeble owns "same person, different light". SEED owns "different thing,
recognisable across shots". Neither does the other's job.

Two honest observations about our own work in that light:

**The frequency detailer is a crude version of what Beeble does properly.**
It recovers high-frequency detail by transferring a ratio from the plate. Beeble
recovers it from *normals* — actual surface geometry — which is why its result
holds up under a lighting change and a ratio transfer does not. Ours is the
right tool when there is no decomposition available, and it should not be
mistaken for the same thing.

**The structure guard is guessing at what Beeble measures.** It compares
gradient direction between two blurred images to decide whether the plate and
the render describe the same shape. A normals pass answers that question
directly and correctly.

## The opportunity, and it is concrete

SwitchLight 2.0 exports **layered EXRs** — normals, depth, albedo, roughness,
specular, ambient occlusion — for Nuke, Blender, Unreal and After Effects. SEED
lives in After Effects. Those passes are sitting in the same application,
already aligned to the plate, and SEED currently ignores all of them.

**1. Albedo as the identity plate.** This is the cheap, obvious win. A plate
carrying baked-in lighting teaches the model that lighting along with the
identity — which is a large part of why an Item's plates fight the shot they
are sent to. An albedo plate is identity with the light removed. It needs
nothing new in SEED beyond a plate role and a note in the describer; the Items
system already carries roles, and `shotFromRole` already reads them.

This is worth measuring before building: generate the same shot with a normal
plate and with an albedo plate, and compare likeness. It is a cheap experiment
with a clear answer.

**2. Normals and depth as structural conditioning.** If Ark accepts any
ControlNet-style structural input, a normals pass is a far stronger constraint
than a reference image. **Whether it does is unknown and nobody has looked** —
this is research, not a plan, and it should not be designed around until the
Volcengine documentation has been read.

**3. The finishing chain could consume AO and specular.** The film look
currently invents its halation and grain from the image alone. Real specular
and AO passes would let it place them where the surface actually is.

## What Beeble does not do, from its own paper

Stated limitations, worth knowing before relying on it:

- **Strong shadows** are not reliably neutralised.
- **Reflective surfaces** are misread — sunglasses are the example given.
- **Face paint** produces inaccurate albedo.

The authors suggest semantic segmentation and shadow augmentation as remedies,
which means these are open problems rather than solved ones. In practice: a
shot with hard shadows or glasses is where a Beeble pass will need the most
help, and that is precisely where SEED's detailer and manual control earn
their place.

## The strategic read

Beeble is the strongest argument yet for the roadmap's central claim. It
competes with nobody on models — it does not have one in the generative sense —
and it is valuable because it is *physically grounded* and *fits a pipeline*.
Its output is layered EXR for compositors, not an MP4 for a feed.

That is the same bet SEED is making: control, provenance, and living where the
work already is. The difference is that Beeble has one deep capability and SEED
has a production layer around many. The sane relationship is to consume its
passes rather than to imitate them.

## Sources

- [SwitchLight: Co-design of Physics-driven Architecture and Pre-training Framework for Human Portrait Relighting (arXiv)](https://arxiv.org/html/2402.18848v1)
- [Beeble Research](https://beeble.ai/research)
- [SwitchLight 2.0 is here](https://beeble.ai/research/switchlight-2-0-is-here)
- [Digital Production — We have to talk about SwitchLight 2.0](https://digitalproduction.com/2025/09/05/we-have-to-talk-about-switchlight-2-0/)
- [Digital Production — Beeble AI relighting steps up to validate in your pipeline](https://digitalproduction.com/2025/07/04/beeble-ai-relighting-steps-up-validate-in-your-pipeline/)
