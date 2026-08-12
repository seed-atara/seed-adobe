# P1 — Film look on a still, end to end

The smallest slice that proves the architecture in ADR 0008. Stills only, bake
route only, one preset. No lens, no video, no LUT, no plugins — each of those
is a later phase and none of them can be trusted before this one exists.

**Done means:** an artist selects a generated frame in the library, picks
*SATOSHI / Josh — half*, presses Apply, and gets a treated child asset whose
recipe reopens, whose lineage points at its parent, and which can replace the
shot in the timeline through the iterate flow that already works.

---

## 1 · `packages/filmlook` — the engine

Pure TypeScript. Float buffers in, float buffers out. No Adobe, no service, no
filesystem, no `Date.now()`.

**Config layer**

- The 66-parameter schema, typed, with the shipped defaults.
- The five stocks.
- `resolveConfig(preset?, overrides?)` implementing `defaults ← look ←
  intensity ← user`, later layers winning, nothing undefined at render time.
- `intensity` as a scalar mapped 0..2 onto the artefact layer, 1.0 = the shipped
  half column. It scales the nine artefact parameters and touches neither
  tonemap, stock nor exposure.

*Golden test:* `resolveConfig("josh", { intensity: 1 })` equals the package's
`resolved_half` on all 66 parameters. This has been checked by hand and passes;
it becomes the regression.

**The chain**

Both phases in the spec's order, which is not negotiable and should be
expressed as one non-reorderable sequence rather than composable steps.

Phase A in scene-linear: exposure → distortion + lateral CA as *one* combined
gather → optical vignette (cos⁴ plus mechanical) → diffusion → anamorphic streak
→ bloom → veiling glare → halation → filmic tonemap with path-to-white →
whitepoint tonemap.

Phase B in display space: stock colour → auto levels → grade → temp/tint → CDL
→ split tone → bleach bypass → dehalo → clarity → sharpen → chroma denoise →
fade → grain → letterbox.

Deferred within P1, wired as no-ops with their parameters present: defocus and
atmospheric haze. Both need a depth map, both are off in the show preset, and
neither can be evaluated without depth we do not have.

Every spatial radius is a fraction of the image diagonal computed from the
actual buffer. `grain_size` is the sole value in pixels, and `grain_ref_longedge`
governs the resolution grain is generated at — 4096 in the show preset, so grain
is locked to the look rather than the raster.

Grain is seeded from a hash of (seed, frame, x, y): stable per frame so it does
not crawl under scrubbing, different between frames so it does not read as dirt
on the lens.

**Tests, taken from the spec**

1. *Resolution invariance.* The same config at 1920×1080 and 3840×2160,
   smaller upscaled, must match closely everywhere except grain. Fails loudly if
   any radius was written in pixels.
2. *Grain in isolation.* Grain onto flat 18% grey; per-channel standard
   deviation must equal the stock's `grain_rms` scaled by `grain_scale`.
3. *Determinism.* Same seed and frame, same bytes. Different frame, different
   noise.
4. *Order.* Grain is measurably last — a grade applied after grain differs from
   the same grade applied before it, and the engine must produce the former.
5. *Golden config.* As above.

## 2 · Service — the look as a provider

- `LookProvider` registered in the same registry as Seedream and Seedance,
  declaring its own capabilities. Always available: it needs no credential.
- A new operation, `look.apply`, taking one input asset and a config.
- Reuses the existing job lifecycle, media ingestor, thumbnailing and asset
  registration unchanged. The output is a child asset; the config is its recipe;
  the parent is its lineage.
- PNG in, PNG out for P1. The existing codec handles it.

Nothing here should need new plumbing. If it does, that is a signal the
provider abstraction is being fought rather than used, and worth stopping over.

## 3 · Panel — apply, compare, iterate

- A **Look** section on an asset: preset dropdown (start with the five the
  package recommends shipping), an Intensity slider defaulting to 1.0, and full
  parameter access under a disclosure with a visible modified-from-preset state.
- **Apply** starts a job like any other and the result lands in the library.
- **Before/after** on the result. A treated frame is judged by comparison or not
  at all, and asking someone to hold the original in their memory is how looks
  get approved that should not have been.
- Reopening a treated asset's recipe restores the look config, so *iterate on
  selected shot* works on looks exactly as it does on generations.

## 4 · The blocker, which lands first

Capture must record the project's working space and bit depth into
`AeContext.colorSpace` — the field exists and has never been populated. The
chain assumes sRGB-encoded 0..1; a 32-bit linear project would silently produce
double-gamma, which looks like a contrast problem and gets "fixed" with a grade
that makes it worse.

The panel should also say plainly when the project is not 32-bit float, because
the optical half of this chain is physically meaningless in 8-bit and the
tonemap will band in skies.

---

## Not in P1, and why

| | Phase | Because |
|---|---|---|
| Lens ST maps, undistort/redistort around generation | P2 | Needs the engine and the colour-space fix under it first |
| LUT export as a real AE filter | P3 | A LUT can only be validated by diffing it against an exact implementation |
| Video | P4 | Needs GPU; a ten-second clip in plain JS is not viable |
| `SEED Film Look` / `Lens` / `Grain` as native plugins | P5 | C++ is out of V0 scope, and the port should come from working code |

## Risks to watch during P1

**Performance on stills is fine; do not let that reassure you about video.**
The expensive stages — large-radius blurs for bloom, halation and glare — are
per-frame costs that multiply by 240 for a ten-second clip.

**The tonemap is the stage to check first if a comparison fails.** It is not
interchangeable with a generic filmic curve, and it is the one stage that was
reverse-engineered rather than authored.

**Camera artefacts must be switchable off as a group.** Applying this to
footage that already has real distortion, vignetting or grain doubles all three,
which is the classic tell. The Intensity slider at 0 should be exactly that
switch.
