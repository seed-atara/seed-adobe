# Wave Warp's Pinning dropdown, measured

**Status: measured in After Effects 26.0, from rendered pixels.** Not read
off a dialog, not inferred from the order of the menu, and not taken from any
earlier note in this repo — two of those were wrong.

## Why it had to be measured again

The table in `packages/domain/src/buntingWeave.ts` had been through two wrong
versions, both claiming to be measured. The reason they could not have been
is the probe:

`layerBounds` asks After Effects for `sourceRectAtTime(t, true)` — the source
rectangle *including* effect extents. **That rectangle does not move when a
Wave Warp is applied.** Measured directly:

| Wave Height | reported bounds |
|---|---|
| 0   | `left 3210, top 296, width 1316, height 1647` |
| 300 | `left 3210, top 296, width 1316, height 1647` |

Byte-identical, on a 1316×1647 layer, at an amplitude almost a fifth of its
height. Any "measurement" of a warp taken through `layerBounds` is reading a
number that cannot change.

## The probe that does work

1. Solo the layer, so the capture contains it and nothing else.
2. Set `Wave Speed` to 0 and drive `Phase` instead. Phase at time *t* is
   `phase0 + 360 · speed · t`, so sweeping phase visits exactly the states
   the clip will play through — reachable without a playhead command.
3. Capture the comp to PNG at each phase, and read the alpha channel.
4. For each edge, take an alpha-weighted centroid of a band 15% deep along
   that edge, and compare it between phases. An edge that is held does not
   move; an edge that is free does.

One trap: `saveFrameToPng` returns before the bytes have landed. A PNG read
mid-write raises rather than returning short, so the failure is loud — but
wait for the file size to settle before opening it.

## The table

Measured on a 478×556 tree layer, `Wave Height` 12, `Wave Width` 2200. Top
and bottom come from a `Direction` 0 sweep (horizontal displacement, varying
with height); left and right from a `Direction` 90 sweep. Travel in pixels,
peak to peak.

| value | top | bottom | left | right | reads as |
|---|---|---|---|---|---|
| 1  | free 34 | free 9.1 | free 6.2 | free 4.1 | None |
| 2  | HELD  8 | HELD 2.2 | HELD 2.0 | HELD 1.5 | All edges |
| 3  | free 34 | free 9.1 | free 6.2 | free 4.1 | — |
| 4  | free 34 | free 9.1 | free 6.2 | free 4.1 | — |
| 5  | free 34 | free 9.1 | HELD 2.2 | free 4.1 | Left edge |
| 6  | HELD  8 | free 9.1 | free 5.9 | free 3.8 | Top edge |
| 7  | free 34 | free 9.1 | free 6.2 | HELD 1.7 | Right edge |
| 8  | free 34 | HELD 2.2 | free 6.2 | free 4.1 | Bottom edge |
| 9  | free 34 | free 9.1 | free 6.2 | free 4.1 | — |
| 10 | HELD  8 | HELD 2.2 | free 5.9 | free 3.8 | Top and bottom |
| 11 | free 34 | free 9.1 | HELD 2.2 | HELD 1.7 | Left and right |

Values above 11 are refused by After Effects — *"Value 12 out of range 1 to
11"* — so the dropdown has exactly eleven entries and this covers all of them.

`3`, `4` and `9` were indistinguishable from `none` on all four edges. They
are recorded in `WAVE_PINNING_INERT` rather than named, because nothing
measured says what they are.

### The correction

The previous table said `leftEdge: 6`. **`6` holds the top edge. Left is
`5`.** Nothing had shipped against the wrong value — every strand on the
right-hand side of the arcade was set to `none` — but a flag pinned with it
would have been nailed by its upper edge instead of its pole.

## Direction is two facts, not one

`Direction` sets both the axis the pixels move along *and* the axis the wave
varies along, and the two are perpendicular. This is what makes a tree
possible:

- **`90`** displaces vertically, varying along x. Every pixel in a column
  moves together. Right for bunting, where a whole pennant should lift at
  once.
- **`0`** displaces horizontally, varying along y. Every pixel in a *row*
  moves together and the amount changes with height. Right for anything
  rooted, because only then can the base and the top differ.

At `Direction` 90 no pinning value can save a tree: the base travels exactly
as far as the canopy, because they are in the same column.

## Amplitude is not travel

`Wave Height` is not the distance anything moves. Measured on the avocado
tree at `Wave Height` 12, wavelength 2200, bottom edge pinned:

| | canopy travel | base travel |
|---|---|---|
| Pinning `none` | 9.06 px | 9.08 px |
| Pinning `bottomEdge` | 9.06 px | 2.22 px |

So travel ≈ 0.755 × `Wave Height` at four wavelengths per layer height, which
is what `SWAY_TRAVEL_PER_HEIGHT` encodes — callers ask for the travel they
want to see. And that second row is the entire effect: the canopy keeps all
of its movement while the base loses three quarters of it. The first row is
a sticker being pushed sideways.

## One more thing the probe showed

Travel across a bunting strand is quantised to half-pixel steps. The artwork
is hard-edged flat vector with effectively binary alpha, so a sub-pixel
displacement lands in discrete buckets rather than shading between them.
At the amplitudes this project ships — 3 px on bunting, which measures as
2.5 px of travel — that is near the floor of what the artwork can express.
It is not a bug, but it is the reason a smaller amplitude would do nothing
at all rather than doing less.
