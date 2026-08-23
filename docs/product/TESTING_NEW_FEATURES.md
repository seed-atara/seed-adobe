# Testing what has just landed

Ten things shipped since the last time any of this was exercised. This is the
order to test them in — cheapest and most likely to be broken first, so a
failure stops you before you have spent twenty minutes on the ones that need
After Effects.

Nothing here costs money except where it says so.

---

## 0. Deploy, once

```
npm run install:extension     # panel + host scripts
npm run dev                   # the service, in its own terminal
```

Then **restart After Effects**. The host script is read at launch, so none of
the capture fixes are live until you do.

Two of these need the plugins as well:

```
npm run detailer:build && npm run detailer:install    # elevated prompt
```

There is a helper for everything that talks to the service, so none of the
steps below need curl:

```
npx tsx scripts/api.ts GET /v1/items/stale
```

---

## 1. Captures are no longer black — 2 minutes, AE

The one that has cost the most time. Two separate bugs: a 1-second wait that
lost large captures, and 32-bit projects writing at a tenth of scale.

1. Open a **32 bpc** project (File → Project Settings → Color → Depth).
2. Open a large comp — the 5750×2818 one is ideal, because it is what failed.
3. Panel → **Capture current frame**.

**Pass:** it completes in a few seconds and the library card shows the picture,
not a black square. Behind the scenes the project drops to 16 for the write and
is put back.

**Check your project is still 32 bpc afterwards.** That restore happens in a
`finally`, and if it ever fails to run that is the bug worth knowing about
immediately.

Measure it if you want the number rather than the impression:

```
npx tsx scripts/check-capture.ts <the captured png>
```

**Fail modes:** a black card means the depth guard did not fire; "no file
appeared" means the settle budget is still too short for that frame size.

---

## 2. Flat colour frames — 2 minutes, panel

Type each of these into the prompt and watch for the button to appear:

| prompt | expected button |
|---|---|
| `from fully black, the logo forms` | **Open from black** |
| `she turns away, then fade to black` | **End on black** |
| `from fully black, the logo forms, then fade to black` | **both** |
| `starts on a green screen, she walks in` | **Open from green screen** |
| `the shot ends on a bluescreen` | **End on blue screen** |

And these must produce **no button at all** — this is the half that matters,
because a false positive puts a card in front of a shot that never asked:

- `a black car drives in from the left`
- `she walks into black smoke`
- `she stands in front of a green screen`
- `from green fields to the sea`

**Pass:** clicking a button adds a flat frame at the comp's shape, in the right
role, and the reference strip reads in shot order.

---

## 3. A last frame alone is refused — 1 minute, panel

Attach one reference and set its role to **last**, with nothing else.

**Pass:** Generate greys out and a notice explains it, with the **Open from
black** button offered right there as the way out. Previously this reached Ark
and came back as a 400 you had paid a round trip for.

---

## 4. Plate selection by shot — 5 minutes, free

The resolver picks which plates travel. Test it with `/v1/items/resolve`, which
answers the same question generation does **without generating anything**.

Take an Item with several plates whose roles differ — `profile`, `front`,
`face`, `wide`. Find its id:

```
npx tsx scripts/api.ts GET "/v1/items?query=<handle>"
```

Then ask the same Item for two different shots:

```
npx tsx scripts/api.ts POST /v1/items/resolve "{\"providerId\":\"seedance-2-5\",\"prompt\":\"a close-up in profile\",\"itemMentions\":[{\"token\":\"<handle>\",\"itemId\":\"<id>\",\"influence\":70}]}"

npx tsx scripts/api.ts POST /v1/items/resolve "{\"providerId\":\"seedance-2-5\",\"prompt\":\"a wide establishing shot\",\"itemMentions\":[{\"token\":\"<handle>\",\"itemId\":\"<id>\",\"influence\":70}]}"
```

Compare `bundle.items[0].plateAssetIds` between the two.

**Pass:** the order differs, and the profile-roled plate leads for the profile
prompt while the wide-roled plate leads for the wide one.

**If they are identical**, check the prompt actually contains a phrase the
reader knows (`close-up`, `profile`, `wide shot`, `night`) — an unrecognised
prompt deliberately falls back to weight order and changes nothing.

This works on your existing library because plate **roles** already imply a
shot. Tagging is only needed where the role does not say.

---

## 5. The conform pass — 3 minutes, free

```
npx tsx scripts/api.ts GET /v1/items/stale
```

**Pass on a clean library:** `{"stale": []}`.

Now make it say something. Add a revision to an Item you have generated with —
in the panel, edit it and save — then run it again.

**Pass:** every finished shot that used the previous revision is listed, with
the handle and both revision numbers. Failed shots are deliberately absent;
there is nothing to conform about a shot that never produced anything.

Scope it while you work:

```
npx tsx scripts/api.ts GET "/v1/items/stale?itemId=<id>"
```

---

## 6. Colour drift between shots — 3 minutes, free

Take two or three finished clips that should cut together, and their ids from
the library:

```
npx tsx scripts/api.ts POST /v1/assets/colour-match "{\"assetIds\":[\"ast_a\",\"ast_b\",\"ast_c\"]}"
```

**Reading it:** `distance` is a Lab distance from the reference — the first
asset unless you name a `referenceId`.

| distance | means |
|---|---|
| under 2 | invisible; they will cut fine |
| 2 to 10 | noticeable in a cut |
| over 10 | reads as a different setup |

`a` is green→red and `b` is blue→yellow, both signed, so a positive `b` on one
shot and a negative `b` on another is one warm and one cool.

**Pass:** two shots you know match report a small distance, and one you know is
off reports a large one. It measures only — it does not grade anything.

---

## 7. Regions that follow a moving guide — 10 minutes, AE

The one with the most that can go wrong, and entirely unproven.

1. In a comp with movement, **Add region**.
2. Give the guide layer a Position keyframe at the start and another at the end
   — or parent it to a tracked null, which is the case worth testing most.
3. **Capture region**.
4. Scrub the timeline.

**Pass:** the captured sub-comp shows the region's contents following the
guide, and after generating, the composite sits over the moving region rather
than where the guide was at capture time.

**Known and deliberate:** only position follows. A guide that **scales** during
the shot still captures at the size it holds at capture, because a sub-comp
cannot change size over time.

**The failure worth watching for:** if the guide layer is renamed or deleted,
the expression falls back to its static value. It must **not** drop the layer
to the top-left corner — that is what an unguarded expression error does, and
guarding against it is why there is a try/catch in every one.

A locked-off guide should behave exactly as it did before, with no expression
on anything.

---

## 8. The frequency detailer — 10 minutes, AE

Has its own procedure, which grades the plugin against the core rather than
against an opinion: **`docs/product/DETAILER_TEST.md`**.

Short version:

```
npx tsx scripts/detail-test.ts make --out D:/tests
# build the comp as described, export a frame, then:
npx tsx scripts/detail-test.ts check D:/tests <export.png>
```

Three passes means the After Effects glue computes what the tested core
computes. That glue is still the only part of the detailer never verified.

---

## 9. Video references reach Ark protected — costs one generation

The `asset://` route for video was fixed, and the only honest test is a real
generation.

Attach a **clip** as a reference on Seedance 2.5 and generate something short.

**Pass:** it runs. **Fail:** "may contain real person" — which would mean the
clip travelled as a plain link again. If that happens, look for
`ark.asset.fallback` in the service log; it names the real reason, which is the
whole point of it existing.

---

## 10. ROO — passes, relighting and shot matching

Its own guide, because it is a workflow rather than a check:
**`docs/product/ROO_TEST.md`**.

Short version — the two steps most worth doing, both free:

```
ROO tab → select a shot → Measure passes
```
Depth should show near things pale and far things dark; normals should be
lavender with cyan and magenta edges. **If depth is inverted, stop** — every
later step inherits it and still looks plausible.

```
ROO → section 5 → a product shot on black → Read its camera
```
Vignette must report **"not measurable here"**. A subject on black falls off
exactly like a lens, and a real frame claimed a 0.92 vignette during
development before the shape check was added.

## What is still unproven after all of this

- The **detailer's AE glue**, until §8 is run.
- **Moving regions**, until §7 is run — it is ExtendScript, so nothing in the
  test suite can touch it.
- Whether Ark accepts **`first_frame` + `last_frame` as two different images**.
  Everything measured used the same image in both slots. §2 and §3 produce
  exactly this shape, so the first fade-from-black generation answers it.


---

## 11. Relighting, reframing and scene-switching — the paid providers

Added 2026-08-23. Three of these need a key, and **a provider with no key is not
registered at all** — so "it is missing from the list" is the expected symptom
of a missing key, not a bug.

### Which key unlocks what

| provider | key | what it does |
|---|---|---|
| `iclight-v2` | `FAL_KEY` | relight a subject from a description |

Get it from fal.ai → Keys.

**Luma Reframe and Beeble SwitchX were removed on 2026-08-23** (ADR 0016).
SEED's own `/v1/switch` does the SwitchX job, free and locally, so
`BEEBLE_API_KEY` and `FAL_REFRAME_MODEL` are no longer read.

Check what actually registered, which is faster than hunting through the panel:

```
npx tsx scripts/api.ts GET /v1/providers
```

Expect `iclight-v2` once `FAL_KEY` is set.

**Costs money.** IC-Light is billed per image. The expansion and switch routes
cost nothing; only the Seedance generation that fills a residual does.

### Testing IC-Light — 3 minutes, panel

1. Capture or pick a frame with a clear subject.
2. Select **IC-Light V2 (relight)** and describe the light: *"low warm key from
   the left, cool rim, dark background"*.

**Pass:** the subject keeps its shape and identity, and the light moves.

**It also needs `SEED_R2_*`.** IC-Light takes a link and nothing else, so the
plate has to be hosted. Until 2026-08-23 the service ignored what a provider
declared about addressing and handed every non-Seedream provider raw base64 —
so this would have failed on its first real generation with "needs a fetchable
URL" for a reference the service had a bucket and every means to host. Fixed;
if the bucket is not configured the job now fails naming the four settings that
would fix it, which is the right refusal rather than a confusing one.

**Know before judging it:** this endpoint is the **text-conditioned** model.
Handing it a backdrop and expecting the light to be matched to that backdrop is
not what it does — that is the background-conditioned variant, which is not
exposed. Use SEED's `/v1/switch` for reference-driven light.

### Testing the SEED feature that needs no key at all

`/v1/switch` is local, free and instant. The smoke script builds its own
frames, so it needs no footage:

```
npx tsx --env-file=.env scripts/switch-smoke.ts
```

**Pass:** `/v1/switch` registers a render and a matte.

**Fail modes worth recognising:**

- `expressible: false` — the reference needs a hard shadow edge, which nine
  spherical harmonics cannot carry. The relight will be soft where the
  reference is sharp.
- a `matteCoverage` near 0 or 1 in `auto` mode — the depth threshold went wrong.
  Pass `threshold`, or supply a matte with `alphaMode: "custom"`.

### If you want the comparison back

Both adapters were complete and tested against their published contracts, and
are in the history (`394d298`, `ff4dc18`). Reverting one is a small job, and
worth doing if a shot turns up where ours is visibly worse — that is a thing
worth knowing rather than arguing about.

