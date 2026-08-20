# Testing SEED Frequency Detailer

The core has its own tests and they pass. What they cannot reach is the After
Effects glue — the world-to-float conversion, the parameter reading, the second
layer's checkout, the premultiply round trip. Nothing in the suite can run an
`.aex`, so that half is unverified until someone opens After Effects.

This procedure closes it, and ends in **numbers rather than impressions**:
After Effects renders a pair, and the same pair goes through the core
directly. If the two answers differ, the glue is wrong, and the difference says
by how much.

---

## 0. Install

```
npm run detailer:build
npm run detailer:install      # elevated prompt — MediaCore is under Program Files
```

Restart After Effects. **Effect → SEED → SEED Frequency Detailer.**

Not appearing at all is almost always the PiPL, not the code — see
`plugins/seed-film-look/README.md`, which paid for that lesson.

---

## 1. Make the pair

```
npx tsx scripts/detail-test.ts make --out D:/tests
```

Two 768×768 images:

| file | what it is |
|---|---|
| `detail-plate.png` | the sharp plate — the **detail source** |
| `detail-soft.png` | the same image blurred by sigma 2.5 — the **soft render** |

Blurred by a known amount on purpose. "Did detail come back" is then a
measurement against a known answer rather than an opinion about a screenshot.

The plate deliberately contains the three things this effect has to survive:
fine texture over a smooth ramp (the thing being carried), a hard edge (where
a ratio haloes if it is going to), and a near-black third (where the divide
explodes if it is going to).

---

## 2. Set up the comp

1. New comp, **768×768**, any frame rate, **8 bpc is fine** for this test.
2. Import both PNGs.
3. `detail-soft.png` on the timeline. `detail-plate.png` above it, and
   **switch its video off** — a detail source is read as a layer, not
   composited, so it must not be visible.
4. Apply **SEED Frequency Detailer** to `detail-soft.png`.
5. Set **Detail source** to `detail-plate.png`.

**Leave every other control at its default.** The checker renders the core's
answer at those exact defaults; changing one makes the comparison meaningless.

Defaults, for confirmation: Radius 0.4, Working space Scene-linear, Gain 1.00,
Replace 0.70, Channels Luma only, Shadow floor 0.020, Highlight rolloff 0.30,
Detail limit 4.00, **Structure guard 0.00** — the guard is off for this test
because it is graded separately in §5 — Tolerance 0.30, Show guard off, Mix
1.00.

---

## 3. Export one frame

Composition → Save Frame As → File, as **PNG**, at **full resolution**.

Scaling or a reduced preview resolution changes the separation radius, since
the radius is a fraction of the frame diagonal. The checker refuses anything
that is not 768×768 rather than grading it wrongly.

---

## 4. Grade it

```
npx tsx scripts/detail-test.ts check D:/tests <the exported png>
```

**Expected: three passes.**

```
detail energy: plate 11.70, soft 0.14, yours ~10.2

PASS  detail came back            ~87% of what the blur removed
PASS  matches the core            mean 0.00, worst 0 code values
PASS  the effect did something    mean difference from the soft plate ~10.3
```

What each failure means:

| failure | what it means |
|---|---|
| `detail came back` at **0%** | the effect did nothing. Detail source is unset, or the layer parameter never checked out — the single most likely glue failure, and the reason it is tested first |
| `matches the core` with a **large mean** | the plugin runs but computes something else. Suspect the ARGB channel order, the 8/16/32-bit conversion, or a parameter read from the wrong index |
| `matches the core` with a **small mean but a large worst** | agreement everywhere except a few pixels — look at the frame edges and the near-black third |
| `the effect did something` fails alone | the export is the untouched input; check the effect is enabled and on the right layer |

A mean of 1–3 code values is fine: After Effects works in float and rounds once
more than the reference does. A mean above 3 is a real disagreement.

---

## 5. The drift guard, separately

The guard cannot be graded by this pair, because the pair does not drift — the
soft image is exactly the plate, blurred. To exercise it:

1. Set **Structure guard** to 1.0 and turn on **Show guard**.
   The frame becomes the **detail strength** map — how much of the plate's
   detail each pixel is accepting, whatever is deciding it: structure
   agreement, shadow protection, highlight rolloff. With no drift and a
   well-exposed plate it should be **almost entirely white**.

   It shows the whole field rather than agreement alone because agreement
   alone could not explain a frame the shadow protection was driving: it read
   white everywhere while detail was being held to a quarter.
2. Now move the `detail-plate.png` layer 20 px sideways.
   The map should go **dark along every vertical edge** — those are the places
   the plate and the render now disagree, and where detail will be held back.
3. Turn Show guard off, leave the offset in place.
   Compare against Structure guard 0: at 0 the edges double and ghost, at 1
   they soften instead. That trade is the whole point of the control.

Drift showing up as *missing* detail rather than doubled edges is the intended
behaviour. It is a mitigation, not alignment.

---

## 6. Depth, if you want to be thorough

Repeat §2–4 with the comp at **16 bpc** and **32 bpc** (File → Project
Settings → Color → Depth). All three should pass the same way.

They exercise genuinely different code: 8-bit divides by 255, 16-bit by
`PF_MAX_CHAN16` — After Effects' 16-bit is 0–32768, not 0–65535, and getting
that wrong halves the picture — and 32-bit passes floats through unclamped so
values above nominal white survive.

Note the export from a 16 or 32 bpc project will be a **16-bit PNG**. The
checker reads those; it did not until 2026-08-20, when that was the cause of
every capture appearing black in the library.

---

## The one-line version

```
npx tsx scripts/detail-test.ts make --out D:/tests
# build the comp as in §2, export a frame, then:
npx tsx scripts/detail-test.ts check D:/tests <export.png>
```

Three passes means the plugin computes what the tested core computes, and the
glue is doing its job.
