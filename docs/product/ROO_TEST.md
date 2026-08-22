# Testing ROO

The whole loop, in the order the tab uses it. Roughly twenty minutes, and only
one step costs money.

Everything except §3 is free, offline and repeatable, so if you have limited
time, do §1, §2, §4 and §6 — they are where the interesting failures live.

---

## 0. Before you start

```
npm run install:extension
npm run dev
```

Restart After Effects. **ROO** is a new tab between *items* and *library*.

**The first measurement downloads the model** — about 50 MB, once, cached
afterwards. It happens on your first press of *Measure passes*, not at startup,
so the service still runs offline until you ask for it.

Pick a source shot with a face or an object at a clear distance from its
background. A flat graphic gives depth estimation nothing to work with, and the
whole chain hangs off depth.

---

## 1. Measure — free, and the foundation of everything else

Library → select a shot → **ROO** → **Measure passes** with both boxes ticked.

**Expected:** two thumbnails appear within a few seconds, and the panel says
"No cost."

Now *look at them*, because this is the one step where a wrong result is
obvious and everything downstream inherits it:

| pass | what right looks like |
|---|---|
| **depth** | near things pale, far things dark, a clean silhouette. On a portrait the nose and hands should be brightest |
| **normals** | mostly lavender-blue, with left-facing surfaces turning cyan and right-facing turning magenta |

**If depth is inverted** — background pale, subject dark — stop and tell me. The
normal map's sign depends on brighter-being-nearer, and everything built on it
would be lit from the wrong side while looking plausible.

**Relief** changes how pronounced the normals are. Try 1 and then 8 on the same
shot; the difference should be obvious and the *shape* identical.

---

## 2. Relight — arithmetic, no model, instant

Still in ROO, section 4. **Normals** should already be filled in from §1.

You need an albedo. If you have not made one yet, use the source shot itself as
a stand-in — the lighting will double up, but it proves the geometry is right,
which is what this step is testing.

Set **Azimuth −90**, **Elevation 0**, and press **Relight**.

**Expected:** the result is lit from the left. Now try **+90**.

**Pass:** the shading flips sides, and the highlight sits where you would
expect it on a real surface. If the light appears to come from the opposite
side to the azimuth, the normal map is mirrored and §1 is where the problem is.

Worth trying while you are here:

- **Elevation 80** — light from almost overhead. Foreheads and the tops of
  shoulders catch it; eye sockets go dark.
- **Ambient 0** — everything facing away from the key should go to black. If it
  does not, the albedo has lighting baked into it, which is the honest reason
  to make a real albedo pass in §3.
- **Specular 1.0** — a highlight appears. With no roughness pass it assumes a
  half-rough surface.

---

## 3. Generate an albedo — the one step that costs

Section 3, tick **Albedo** only, choose Seedance 2.5, **Generate passes**.

**Expected:** it starts a normal generation and arrives in the library like any
other result.

**What a good albedo looks like:** the same shot, flat, with the lighting gone.
Skin keeps its colour and its pores; the shadow under the chin is *not* there.
Nothing is relit, nothing is recomposed, the framing is identical.

**What a bad one looks like:** a slightly brighter copy of the original with
the shadows still in it. That means the prompt did not win — worth telling me,
because the prompt is the product for this pass and it can be tightened.

Then repeat §2 with the real albedo and **Ambient 0**. The difference from the
stand-in should be plain: with a real albedo, the unlit side goes properly
black instead of showing the original lighting.

---

## 4. Read another shot's camera — free

Section 5. Choose a **Reference shot** — ideally a real photograph, not a
graphic — and press **Read its camera**.

**Expected:** five readings, each with a percentage, and a list of anything the
frame could not answer.

**This is the part to test hardest, because confident wrong numbers are the
failure mode.** Try all three of these:

| reference | what should happen |
|---|---|
| a real photograph with a bright highlight | most readings confident; halation reports something |
| a product shot **on black** | vignette must report **"not measurable here"** — a subject on black falls off exactly like a lens and the measurement is meant to refuse it |
| a flat graphic or a title card | nearly everything unmeasurable; the list of skips should be long |

**Pass:** the second case refuses to give a vignette. Two real frames caught
that bug during development — a product shot claimed a 0.92 vignette it did not
have — so it is the case most worth confirming still holds.

With a **source shot also selected**, the settings are a *difference*: what to
add to your shot so the reference's camera appears to have shot it. Reading a
shot against **itself** should ask for close to nothing.

---

## 5. Apply the camera — in After Effects

The panel prints film-look settings, for example:

```
vignette = 0.184
ca_lateral = 0.0021
grain_scale = 0.412
grain_size = 0.59
```

Apply **SEED Film Look** to your shot and set those parameters by hand.

**Pass:** the two shots sit together more comfortably than before —
particularly the grain, which is the thing an eye notices immediately and a
colourist spends longest matching.

This step is deliberately manual for now. The numbers are visible and yours to
argue with, which is worth more than an automatic application you cannot see
inside.

---

## 6. Transfer another shot's lighting — free, and the real test

This is the claim worth checking: **light this shot the way that shot is lit**,
with the lighting *measured* rather than described.

You need four things: an albedo and normals for the **reference**, and an
albedo and normals for **your shot**. Run §1 and §3 on both.

Fill in section 5's **Reference albedo** and **Reference normals**, set
**Amount 1**, and press **Transfer its lighting**.

**Expected:** your shot lit from the reference's direction, in the reference's
colour. The panel reports how many samples the solve used and a **residual**.

Reading the residual:

| residual | means |
|---|---|
| under 0.15 | the reference's lighting solved cleanly; trust the result |
| 0.15–0.25 | mostly soft light with something the fit could not carry |
| over 0.25 | hard shadows or strong occlusion — only the soft part transferred, and the panel says so |

**Pass:** a reference lit hard from one side produces a result lit from the same
side. A warm reference produces a warm result.

**Known and honest:** this transfers *soft* light. Second-order spherical
harmonics cannot represent a hard shadow edge, and a reference with one will
report a high residual rather than pretending. Beeble's own paper lists strong
shadows as a limitation too — it is hard for everyone.

Try **Amount 0.5**. It should land halfway, which is usually what you want: a
full transfer imposes the reference's key direction even when your subject is
facing the other way.

---

## What would tell me something is wrong

In rough order of how much it would matter:

1. **Depth inverted** — everything downstream is wrong and looks plausible.
2. **Relight lit from the wrong side** for a given azimuth — the normal map is
   mirrored.
3. **A vignette reported confidently on a subject-on-black** — the shape check
   has regressed.
4. **Albedo that still has shadows in it** — the prompt needs tightening.
5. **A lighting transfer that ignores the reference's direction** — the solve
   is not finding the light.

## What is not tested by any of this

The generated passes are only as good as the model's willingness to follow the
prompt, and that varies by shot. Where a pass comes back wrong, the fix is the
prompt in `packages/domain/src/pass.ts` — they are written to be edited, and
they are visible in the panel so you can see what was asked.
