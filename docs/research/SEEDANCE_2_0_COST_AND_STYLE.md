# Seedance 2.0 — what a clip costs, how long it takes, and the house recipe

Measured from **150 succeeded generations on this account**, read out of
`generations.raw_response_json` in the live SQLite rather than from anybody's
price page. Every Ark video task returns a `usage` block, and SEED has been
storing it since the adapter was written:

```json
"usage": { "completion_tokens": 488748, "total_tokens": 488748 }
```

Endpoint on this account is **BytePlus**,
`ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`.

## Cost is tokens, and tokens are pixels

| resolution | tokens / second of output | spread across samples |
|---|---|---|
| 720p | **21,750** | 21,690 – 21,886 |
| 1080p | **48,800** | 48,684 – 49,319 |
| 4K | **195,750** | 195,750 (n=2 at base rate) |

Those three numbers are one number. Divide by 24fps and then into the frame:

| resolution | tokens / frame | pixels / frame | **pixels per token** |
|---|---|---|---|
| 720p | 906 | 921,600 | 1017 |
| 1080p | 2034 | 2,073,600 | 1020 |
| 4K | 8156 | 8,294,400 | 1017 |

So the meter is **~1017 pixels per token** — near enough a 32×32 patch — and
the whole cost model is:

```
tokens ≈ width × height × fps × seconds / 1017
```

Which makes the only decision that matters a clean one:

> **4K costs 4× 1080p costs 2.25× 720p, per second.** Exactly the pixel ratio.
> Nothing else about the request moves it.

Duration is strictly linear. Aspect ratio does not matter beyond the pixels it
implies — `21:9`, `1:1` and `16:9` at the same tier land within 0.3% of each
other.

### One thing doubles it: a reference video

Grouping the same 150 jobs by measured-over-predicted tokens:

| multiplier | n | what the request contained |
|---|---|---|
| ×1.0 | 116 | text + images only (`t2v`, `i2v`, `flf2v`) |
| ×1.8 – ×2.3 | 34 | **a `video_url` content part** (`r2v`) |

Attaching a motion reference roughly doubles the bill — the input clip is
tokenized too. That matches Volcengine's published split between a
video-input rate and a pure-generation rate, and it is the one parameter that
changes the cost without changing the output size.

No evidence that `bitrate_mode`, `generate_audio`, seed, or the number of
still references moves the total at all.

### Turning tokens into money

**Not established here, and worth checking in the console rather than
trusting.** Secondary sources disagree by a factor of three, and none of them
names `dreamina-seedance-2-0-260128`:

- [TechNode](https://technode.com/2026/03/05/bytedances-seedance-2-0-video-model-costs-about-0-14-per-second/)
  reports Volcengine pricing Doubao-Seedance-2.0 at ¥46/M tokens for pure
  generation and ¥28/M with video input, working out to ≈¥1/s — about $0.14/s.
- BytePlus list examples for a 5s clip with no video input, via
  [nxcode](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026):
  $0.35 at 480p, $0.76 at 720p, $1.87 at 1080p, **$3.89 at 4K**.
- Resellers quote $0.092 / $0.197 / $0.492 per second for 480p / 720p / 1080p
  ([apimodels](https://apimodels.app/models/seedance-2.0)) — markup unknown.

Note the BytePlus figures are not token-linear against each other, so at most
one of these models is right. The measured token counts above are the part
that is ours; multiply them by whatever the console actually charges.

Rough order of magnitude at the TechNode rate: a 10s 1080p loop is ~488k
tokens ≈ **$3**; the same shot at 4K is ~**$12**.

## Speed

Wall clock from request to completed job, same 150 samples:

| resolution | typical | observed range |
|---|---|---|
| 720p | **~2½ min** | 95 s – 292 s |
| 1080p | **~4 min** | 163 s – 622 s |
| 4K | **~6½ min** | 202 s – 639 s |

The spread is queue, not content — the same prompt at the same settings has
come back in 107 s and in 330 s. Plan on the upper end and poll; do not treat
a slow job as a failing one until well past ten minutes.

`seedance-2-0-fast` and `seedance-2-0-mini` exist on this account and stop at
720p. Neither has been run yet, so the ~50% saving reported for mini is
unverified here.

## Resolution ceilings (previously measured, still current)

| model | accepts |
|---|---|
| `dreamina-seedance-2-0-260128` | 480p, 720p, 1080p, **4K** |
| `dreamina-seedance-2-5-260628` | 480p, 720p, 1080p |
| `-2-0-fast-260128`, `-2-0-mini-260615` | 480p, 720p |

**2.0 is the only model here that reaches 4K**, which is why it is the one to
use for anything destined for a wall. See `MODEL_API_NOTES.md` for the probe.

## The house recipe for a cel element

Eleven generations against `ANUAL_SUMMIT.aep` — the GYG arcade projection,
built as a wide illustrated street assembled from separately animated
entities. The pattern that produced the ones that worked:

1. **One entity per clip.** A cyclist, a woman walking, a mariachi trio, a
   rooftop crowd, one cafe table. Not a scene.
2. **Isolated background, stated twice.** `"isolated on a flat chroma-green
   background with no shadow spill"` in the description, and again at the end:
   `"Flat chroma-green backdrop stays pure, even and unchanged for the whole
   shot"`. Green for keying, white where the element is comped by other means.
3. **Hold the plate.** Open with `"Image 1 as the first frame, held exactly:"`
   or `"Image 1 animated as-is:"` followed by a description of the artwork —
   style, line weight, colours, props. The description is there to stop the
   model redesigning, not to tell it what to draw.
4. **A timed beat sheet, not a sentence.** One line per beat with explicit
   second ranges:

   ```
   0-3s   Both seated, laughing together — she lifts the taco toward her mouth…
   3-7s   He drinks from the cup, turns his head slightly toward her and grins…
   7-10s  They settle back into the opening pose… for a seamless loop
   ```

5. **`camera locked off, no movement` on every single beat.** A cel element
   that drifts cannot be comped back into a plate.
6. **Close the loop in the last beat** — *"hands returning to the exact
   starting position"* — and send the same still as both first and last frame.
   SEED calls this the `loop` role; Ark calls the mode `flf2v` and treats it
   as first-class. 7 of the 11 used it.
7. **A fixed tail of constraints**, verbatim each time:

   > characters stay fully inside frame at constant scale. Stable faces, clear
   > features, normal proportions, natural fluid motion, consistent line
   > weight and flat colour, no stuttering or flickering.

8. **Aspect follows the entity, not the comp.** The eleven used `1:1`, `4:3`,
   `16:9`, `21:9` and `adaptive` — chosen per element from the shape of its
   bounding box. A trio of musicians is not 21:9; a row of cafe tables is.

### What failed

Both failures were the same shot at `9:16` — a portrait frame for a figure
that had been described in a landscape plate. Re-run at `1:1` it succeeded
twice. One data point, not a law, but it points the same way as item 8: frame
the entity the shape it actually is.

## Sources

- Measured: `generations` table, `ANUAL_SUMMIT.aep` and the Seedance probe
  runs, read 2026-10-11.
- [TechNode on Seedance 2.0 pricing](https://technode.com/2026/03/05/bytedances-seedance-2-0-video-model-costs-about-0-14-per-second/)
- [nxcode Seedance 2.0 API guide](https://www.nxcode.io/resources/news/seedance-2-0-api-guide-pricing-setup-2026)
- [apimodels Seedance 2.0](https://apimodels.app/models/seedance-2.0)
