# Testing the quality path in Premiere

A procedure that produces **numbers**, not impressions. The failures here are
quiet — a range conversion looks like "slightly milky", chroma subsampling looks
like "a bit soft", 8-bit banding looks like nothing until it is on a projector —
so every step ends in a pass or a fail with the measurement beside it.

Two things are being tested and they are separate:

- **What SEED does with your pixels** — capture, export, import. Fully under our
  control, and fully checkable against a known chart.
- **What Ark returns** — codec, chroma, depth, tagging. Measured with `ffprobe`;
  the chart cannot be used here because a generative model does not reproduce
  its input.

---

## 0. Make the chart

```
npx tsx scripts/make-test-chart.ts --out D:/tests
```

A full-range sRGB PNG containing, top to bottom:

| band | what it catches |
|---|---|
| luma ramp 0→255 | range squeezed into 16–235 |
| patches at 0, 16, 128, 235, 255 | *which way* a range conversion went |
| 1px red/blue comb | chroma subsampling — the most sensitive test here |
| shadow gradient 0→32 | banding, and therefore bit depth |
| saturated primaries | clamping at the extremes |

0 and 255 are both present and both outside legal video range. That is the
point: it makes a range conversion visible rather than suspected.

---

## 1. Set the sequence up

Import the chart, drop it on a **1920x1080** sequence.

Then **Sequence → Sequence Settings → Maximum Bit Depth** and **Maximum Render
Quality**, both on. Or press **Work in 32-bit float** in the SEED panel, which
sets both.

Without this Premiere renders the timeline in 8-bit and clips anything above
nominal white — which is exactly what a 1080p result carries. The panel only
offers the button when it can see the setting is off.

**Interpret the chart as full range.** Right-click the PNG in the project panel
→ Modify → Interpret Footage. A still is full-range by nature; if Premiere is
told otherwise the test grades Premiere's misreading rather than SEED.

---

## 2. Test the capture path — SEED's own pixels

In the panel, **Capture frame**. Then:

```
npx tsx scripts/check-capture.ts <the captured png>
```

Find the file via the Library card, or `.seed-ae/assets/originals/`.

**Expected: four passes.** This is a still-image round trip through Premiere's
`exportFrameAsPNG`, and nothing in it should touch a value.

| failure | what it means |
|---|---|
| `full range survived` fails at 16..235 | the export is applying a legal-range conversion |
| `known patches unmoved` shows 0→16, 255→235 | same thing, and this line says which direction |
| `1px chroma comb` fails | the still was routed through a YUV encode it should not have been |
| `shadow gradient` banded | an 8-bit stage in the chain — check Maximum Bit Depth |

---

## 3. Test the clip path

Mark in and out over a second of the chart, then **Capture in-to-out as clip**.

```
npx tsx scripts/check-capture.ts <the captured mov/mp4>
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,color_range,color_primaries \
  -of default=nk=1:nw=1 <file>
```

This one is graded differently, because it is a *delivery* encode: SEED captures
clips in a codec Ark accepts as a reference, which today is H.264. So expect
**chroma to fail** — 4:2:0 is what H.264 High gives you, and it is the correct
trade for a file that has to be uploaded and accepted.

What must still pass is **range** and **patches**. A delivery codec is not an
excuse for moving values.

To capture for archival instead of for a provider, export a ProRes preset from
Premiere's Export Settings dialog once; SEED discovers it and uses it when the
clip is not bound for Ark. Then chroma should pass too.

---

## 4. Test what Ark returns

The chart cannot be used here — a generative model does not reproduce its input.
Measure the file instead:

```
npx tsx --env-file=.env scripts/probe-output-quality.ts --yes --cells 1080p:mov
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,color_range,color_primaries,color_transfer,color_space \
  -of default=nk=1:nw=1 <the mov>
```

**Expected at 1080p + mov**, verified 2026-08-18:

```
hevc
Rext
yuv444p10le
tv
bt709
bt709
bt709
```

`yuv444p10le` is the whole point: 4:4:4, 10-bit. `tv` is limited range and is
correct — do not try to "fix" it, see §6.

At 720p you get `h264 / High 4:4:4 Predictive / yuv444p` and **no colour tags at
all**. Still 4:4:4, but nothing is signalled, so every tool falls back to
assuming BT.709 limited. It happens to be right. It is right by luck.

---

## 4b. Is it *really* 10-bit?

`ffprobe` says what a file claims. An 8-bit source encoded into a 10-bit
container still reports `yuv444p10le` and still contains only 256 distinct
values, spaced four apart — the claim and the content are different questions.

```
npx tsx scripts/check-depth.ts <clip>
```

It extracts a frame at **16 bits** and measures the spacing between distinct
values. True 10-bit content lands on a fine lattice; 8-bit promoted to 10
leaves gaps four times as wide whatever the header says.

Measured on real Seedance output, 2026-08-18:

| clip | pix_fmt | effective |
|---|---|---|
| 1080p mov | `yuv444p10le` | **~9.8 bits** |
| 1080p mp4 | `yuv420p10le` | ~9.8 bits |
| 720p mov | `yuv444p` | ~7.8 bits |

9.8 rather than 10.0 is normal: a real image does not use every code value.
7.8 is honest 8-bit, not degraded 10-bit — 720p *is* 8-bit H.264, so that is
the correct answer rather than a failure of the file.

**A screenshot cannot answer this.** PNG screen captures are 8-bit by
construction, so banding seen in one may belong to the capture. Measure the
file.

## 5. Test the import

Import the returned clip. In Premiere, open **Lumetri Scopes → Waveform (YC)**.

- Set the scope to **8-bit (0–255)** display and check the highlights: values
  should reach 235 and, on a bright shot, push above it. That headroom above
  nominal white is real — measured at 983 against a ceiling of 940 in 10-bit —
  and if it is clamped flat at 235 the sequence is not in 32-bit float.
- Blacks should sit at 16, not 0. That is correct for limited-range video.

A quick objective version of the same thing:

```
ffmpeg -hide_banner -i <clip> -vf "signalstats,metadata=print:file=-" \
  -frames:v 6 -f null - 2>&1 | grep -E "YMIN|YMAX"
```

10-bit legal range is 64–940. Seeing YMAX above 940 is the superwhite; seeing it
pinned at exactly 940 means something clipped on the way.

---

## 6. What not to "fix"

**Do not stretch limited range to full.** Measured: the 10-bit output reaches 983
against a nominal ceiling of 940, so mapping 64–940 onto 0–1023 clips every one
of those values. In 8-bit it is worse — 220 levels onto 256, banded by
construction.

The correct handling is to let the host expand it **in float**, where limited
maps to 0–1 and superwhite survives above 1.0. That is why §1 insists on
Maximum Bit Depth: it is not a quality nicety, it is the difference between
keeping those highlights and destroying them at the door.

---

## The one-line version

```
npx tsx scripts/make-test-chart.ts --out D:/tests
# capture it through SEED, then:
npx tsx scripts/check-capture.ts <captured file>
```

Four passes on a still capture means the pipeline is not touching your pixels.
Anything else, the failing line names what moved and by how much.
