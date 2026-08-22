# Relighting and background replacement — what to actually build on

Researched 2026-08-22, against the stated mission: take a sequence, restyle it
with a reference image, replace the background of a plate, and relight the
plate to match that background — the Beeble use cases, in After Effects.

The research changes the plan, and it changes it in SEED's favour.

## IC-Light is the engine for this, and it is open

[IC-Light](https://github.com/lllyasviel/IC-Light) — "Imposing Consistent
Light" — ships two models, and the second one is the mission almost verbatim:

| model | what it does |
|---|---|
| text-conditioned | relight a foreground from a description |
| **background-conditioned** | **composite a subject into a new background and relight it to match** |

**IC-Light V2** is the Flux-based successor. It handles relighting *and*
background modification, takes light direction, intensity and colour gradients,
and — the part that matters most here — **migrates lighting style from a
reference image via IPAdapter**. That is "restyle this with a reference" as a
first-class input rather than something to be approximated.

It is hosted (fal.ai, among others) and runnable locally through ComfyUI.

**So the recommendation is: do not compete with IC-Light. Run it.** Spherical
harmonics cannot do what a diffusion relighter does — SH carries soft light and
nothing else, which is stated plainly in ADR 0012. Trying to out-engineer this
with maths would be choosing the harder path to a worse result.

## The part that validates work already done

From a production ComfyUI video-relighting workflow, describing what to do
about IC-Light's known weakness:

> Since IC-Light may lose details at low denoising, the details and original
> colors are transferred back using **Frequency Separation** at the end of the
> workflow to maintain video quality after relighting.

That is precisely the SEED Frequency Detailer, and SEED has it as a **native
After Effects plugin** rather than a node in a graph. The best-practice fix for
the best available relighter is already built here, sitting one tab away from
where the footage lives.

## The part nobody has solved, which is SEED's opening

The same sources are consistent about the failure:

> Video relighting requires processing each frame through IC-Light V2 and then
> reassembling the sequence… frame-to-frame consistency can be challenging as
> subtle variations in relighting might create **flickering**. Specialized video
> workflows with temporal consistency mechanisms exist but are complex to set
> up.

Per-frame relighting flickers. Everyone knows it, and the fixes are described
as complex and bolted on.

**SEED has a timeline.** `averageLighting` already exists and already does the
shot-level version of this for the SH solve. The same idea applied to a
diffusion relighter — solve the lighting once for the shot, hold it constant
across frames, and let the detailer restore what the model softened — is a
temporal-consistency story that a node graph cannot tell as naturally.

## Where the spherical-harmonic work still earns its place

It does not become redundant; it becomes the *fast, deterministic* half.

| | SH (built) | IC-Light (to add) |
|---|---|---|
| speed | instant, free, offline | seconds per frame, costs |
| quality | soft light only, no hard shadows | the current state of the art |
| what it is good for | previewing, **measuring**, matching two shots, holding a shot steady | the final relight |

And the measurement half has no equivalent in IC-Light at all: solving the
light *out of* a reference shot, and measuring a camera's vignette, aberration,
grain and halation, are things a relighting model does not attempt.

So the shape is: **measure with maths, relight with the model, restore with the
detailer, hold it steady across the shot.**

## The plan

1. **`ICLightProvider`.** Behind the same `GenerationProvider` seam as Seedance,
   against a hosted endpoint first — the adapter is small and the seam already
   exists. Two operations: relight-from-background, and relight-from-reference.
2. **Background replacement as one action.** The artist has a plate and a new
   backdrop; SEED already has regions, mattes and compositing. Handing IC-Light
   the foreground and the backdrop and getting a matched composite back is one
   button, not a graph.
3. **Hold the shot steady.** Solve the lighting once across the sequence rather
   than per frame, and pass it as a constant condition. This is the flicker fix
   and it is the piece a timeline makes natural.
4. **Detailer as the finishing pass, automatically.** It is already the
   recommended remedy for what IC-Light softens; it should not have to be
   applied by hand.
5. **Keep the SH path as the preview.** Instant feedback while an artist decides
   the direction, then commit to the model for the frame that ships.

## On generating normals through a model

Raised alongside this, and worth recording: the normal map currently derives
from depth plus high-frequency luminance. The luminance half has a real flaw —
**painted detail becomes fake geometry.** A striped shirt embosses; a dark
tattoo becomes a groove.

The fix is not more filtering, it is a better detail source:

- **A model-generated normal pass** (already a ROO pass) carries surface without
  albedo, which is exactly what luminance cannot separate.
- **Marigold Normals** does it properly and needs Python.
- Depth Anything takes RGB only, so "feeding it depth as a starter" is not
  something that model supports — the practical version of that instinct is
  using the generated normal pass for detail and the measured depth for shape.

That combination — measured shape, model surface — is the honest best available
without a Python sidecar, and it is a small change to what exists.

## Sources

- [IC-Light (GitHub)](https://github.com/lllyasviel/IC-Light)
- [IC-Light V2, Flux-based — discussion](https://github.com/lllyasviel/IC-Light/discussions/98)
- [ComfyUI IC-Light workflow for video relighting](https://www.runcomfy.com/comfyui-workflows/comfyui-ic-light-workflow-for-video-relighting)
- [ComfyUI product relighting video workflow](https://www.runcomfy.com/comfyui-workflows/comfyui-product-relighting-video-workflow)
- [IC-Light V2 via fal.ai, ComfyUI node](https://www.runcomfy.com/comfyui-nodes/ComfyUI_IC-Light-v2_fal)
- [IC-Light V2 advanced lighting control](https://comfyui.org/en/ic-light-v2-advanced-lighting-control)
