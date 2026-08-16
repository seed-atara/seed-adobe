# Items — the consistency layer

Status: **design, not yet built**
Date: 2026-08-17 (revised — see §4, which replaces the first draft's approach)

An **Item** is a thing a production needs to look the same every time it
appears: a character, a location, a prop, a **style**. `@sara` in a prompt
should mean the same woman in shot 4 as in shot 61, six weeks apart, on a
different provider, in a different project.

This document defines what an Item is, what `@sara` expands into, how Items are
authored, and how they leave this repository as a studio format.

The evidence behind §4 is in [`docs/research/CONSISTENCY_PLATFORMS.md`](../research/CONSISTENCY_PLATFORMS.md).

---

## 1. Why an Item is not an Asset

The library already holds media, and it holds it well: an Asset is immutable,
append-only, and carries the recipe that made it. That is exactly the wrong
shape for a character.

A character is **mutable by nature**. You start with one frame from a comp, add
a profile a week later, tighten the description after three shots come back
wrong, then change the coat for act two. None of that is a new character. All of
it changes what `@sara` should mean.

| | Asset | Item |
|---|---|---|
| What it is | a file | an identity |
| Lifetime | immutable | evolves |
| Identity | content | name |
| History | lineage of derivation | revisions of definition |
| Scope | tagged by project | studio-wide by default |

Items **reference** Assets and never contain them. Every plate is an Asset id,
so it keeps its own lineage, provenance and AE capture context. The Item adds
meaning on top: *this frame is Sara's profile*.

---

## 2. The three levels

```
Item        @sara                 the identity
 └─ Variant @sara/red-coat        a deliberate alternate state
     └─ Revision  rev 3           an immutable snapshot of the definition
```

**Item** — handle, kind, name, tags. Nothing generative; the thing the handle
points at.

**Variant** — a deliberate alternate state of the same identity. Sara in the red
coat. The bar at night. The hero prop, damaged. A variant inherits from a parent
and overrides parts of it, so `@sara/wet` is three plates and one trait replaced
rather than a second character maintained by hand. Every Item has an implicit
`base`.

**Revision** — the immutable payload, and the reason this design works.

### Why revisions are non-negotiable

If a generation recorded only `itemId`, reopening a recipe would resolve against
whatever the Item has since become. A six-week-old shot would silently
regenerate with a different coat — a recipe that *looks* reproducible and is
not. That exact failure has already happened here once, when video recipes
dropped duration and roles and quietly changed length on reopen.

So: **a generation records the resolved revision ids and the fully expanded
bundle they produced.** Reopening reproduces identical inputs. Moving to the
current definition is an explicit action — *Update to rev 5* — that shows the
diff first.

---

## 3. Kinds, including style

`character` · `location` · `prop` · `style` · `other`

**Style is an Item.** This is not a stretched metaphor — it is how the mature
platforms are built. Midjourney's `--sref` / `--sw` is a straight structural
parallel of `--cref` / `--cw`, and Runway and Kling collapse style and subject
into one reference channel. A style Item is the same object with different plate
roles and different traits:

```jsonc
{ "handle": "kodak_night", "kind": "style",
  "plates": [ { "assetId": "ast_…", "role": "style-plate", "weight": 1 } ],
  "identity": { "traits": [
    { "text": "halation on practicals", "facet": "grade",  "priority": 1 },
    { "text": "heavy shadow grain",     "facet": "grain",  "priority": 2 },
    { "text": "anamorphic flare",       "facet": "optics", "priority": 3 } ] },
  "look": { "preset": "show-stock", "parameters": { … } }
}
```

That last field is the unification worth having: `packages/filmlook` is already
an ordinary provider with 66 parameters and named stocks. A style Item can carry
a look preset alongside its plates, so `@kodak_night` means both *generate
toward this reference* and *finish with this grade*. The look stays a separate
generation with its own recipe and lineage — Items just stop the artist having
to remember which grade went with which shot.

**One risk to name:** style plates leak content. Ark has a single reference
channel, so a style plate competes in the same list as Sara's face and the model
may take a subject from it. Midjourney separates the channels; we cannot. So
style plates sort last, are labelled explicitly in the prompt as colour-and-grain
only, and §9 question 5 exists to find out whether that is enough.

---

## 4. What `@sara` expands into — *revised*

**The first draft of this document appended a full identity paragraph to every
prompt. That was wrong.** The research is unambiguous and the correction is the
most important part of this design.

### The finding

Not one mature platform puts identity in the prompt text. Runway states the
principle outright — *"references define who your character is; prompts define
what happens to them"* — and its `@name` tag resolves to an **image slot**
contributing no descriptive text at all. Midjourney passes a URL and a scalar.
MiniMax and Vidu take a `subject_reference` array that is a separate API field
from the prompt.

Underneath, IP-Adapter's whole design is **decoupled cross-attention**: a
*separate* attention layer for image features so image conditioning does not
compete with text for the same budget. Writing forty words of character
description into a prompt puts identity back into the channel these
architectures were built to keep it out of — and spends attention the shot
direction needs. Prompt adherence degrades measurably with length, worst
"when the text prompts contain various objects with numerous attributes", which
is a precise description of three Items in one prompt.

### Two kinds of text, which the first draft conflated

Ark's own prompt guide corrected this, and the distinction is the whole answer
to prompt bloat. **"素材映射关系必须写进提示词"** — the material mapping
relationship *must* be written into the prompt — with the template
*"@图片1用于&lt;主体&gt;的&lt;外貌、服装、结构或材质&gt;"* and an explicit statement of what
**not** to take: *"不采用图片背景"*.

So Runway's "references define who, prompts define what happens" is right about
*description* and wrong about *binding*:

| | Carried by | In the prompt? |
|---|---|---|
| **Identity description** — "late 30s, dark bob, olive jacket" | the plate | no |
| **Role binding** — "@image1 is Sara's face and wardrobe; ignore its background" | nothing else can | **yes, required** |
| **Drift-prone detail** — "scar through the left eyebrow" | text only | as budget allows |

Role binding is short, mechanical, and derivable **from the plate roles the Item
already stores**. It is a materials manifest, not prose — the kind of thing
software generates and an artist never types. And it grows with the *number of
materials*, not with how much personality someone wrote down, which is why it
does not blur the shot direction.

### The rule

> **Description shrinks as plates fit. Binding is always present.**

| Tier | When | Contributes | Size |
|---|---|---|---|
| `none` | all plates fitted | binding clause only | ~8 words/plate |
| `anchor` | most plates fitted (default) | binding + drift-prone traits | +6–10 words |
| `brief` | plates partly dropped | binding + top traits by priority | +20 words |
| `full` | no plates fitted, or provider takes no references | the character sheet | unbounded |

At `full` — text-to-image with no references at all — there is nothing else to
carry her, so the description returns in full.

**Unverified:** ByteDance's guide is Chinese and SEED's prompts are English.
Whether an English `Materials:` block performs as well as 【素材职责】 is a
straight A/B nobody here has run — probe question 2.

### Traits, not prose

The tiers only work if the text can be cut intelligently, so identity is
**structured** rather than one blob:

```jsonc
"identity": {
  "traits": [
    { "text": "dark bob cut to the jaw",           "facet": "hair",     "priority": 1, "driftProne": true },
    { "text": "faint scar through the left eyebrow","facet": "face",    "priority": 2, "driftProne": true },
    { "text": "olive canvas field jacket",          "facet": "wardrobe","priority": 3 },
    { "text": "late 30s, Korean-American",          "facet": "age",     "priority": 4 }
  ],
  "avoid": ["sunglasses", "modern logos"]
}
```

`driftProne` is the field that earns its place. References and text are **not
redundant** — they are good at different things. A plate carries face,
proportion and palette better than any sentence. A sentence carries the
discrete, nameable detail a model quietly drops from a plate: a scar, a logo, a
specific colour. `driftProne` marks the traits worth spending words on *even
when the plates are present*, which is exactly what the `anchor` tier emits.

`avoid` folds into `negativePrompt` where the provider takes one, and is
dropped with a warning where it does not.

### Influence, and where it lives

Every mention carries an **influence** of 0–100. Midjourney has `--cw` and
`--sw`, Magnific has style and structure strength; the dial is the primary
creative control everywhere it exists, because identity strength and text
control pull against each other. Locked at maximum, a character cannot be given
a new coat by the prompt. This is documented behaviour, not folklore.

Ark exposes no such dial. So influence maps to **how much of the reference
budget this Item wins** — plate count and ordering — and the panel says that is
what it is doing rather than implying a knob the provider does not have. When a
provider that *does* have one is added, the adapter maps to it and nothing above
the adapter changes.

**Influence is a control, not prompt syntax.** The text selects *which* thing —
`@sara`, `@sara/red-coat` — and the chip beside it sets *how strongly*. Putting
parameters back into the prose would undo the point of the whole section.

### Assembly order

Ark's published formula is *subject + action/event + scene/environment + visual
style + camera move/cut + sound*, with complex multi-material shots organised
under section headers (【素材职责】 material responsibilities, 【编排方式】
arrangement). SEED assembles to that shape:

```
1. The artist's direction, verbatim, first    ← attention decays with position
2. Materials:                                  ← the manifest, generated
     @image1 — SARA's face and hair. Do not use its background.
     @image2 — SARA's wardrobe.
     @image5 — colour and grain only. Do not take subject or composition.
3. Notes: scar through the left eyebrow.      ← drift-prone traits, tier-gated
```

The artist's sentence is never rewritten and never interrupted — splicing forty
words mid-clause wrecks the grammar these models are sensitive to, and the
direction is what must land. Everything the Item adds sits below it, in a block
whose size is a function of how many materials there are.

### Everything else the resolver does

1. **The artist's own inputs come first.** A captured frame is the *shot*;
   plates are supporting evidence. Nothing explicitly attached is demoted.
2. **Plates are allocated round-robin across Items by weight, never
   depth-first.** Three characters and a budget of three gets one plate each.
   Depth-first would give all three to `@sara` and leave two characters
   described in the prompt with no reference at all — the worst failure
   available, because the prompt still confidently names them.
3. **Every drop is a warning shown before Generate.** House rule already, from
   the direction agent: they are about to spend money on it.
4. **A plate is always `reference`, never `first` or `last`.** A first frame is
   the shot's geometry; a plate is identity. The service already refuses to give
   a video a frame role — same rule, same reason.
5. **An unresolvable handle is left as typed.** Prose containing an `@` for some
   other reason is not an error.

### The resolved bundle

```jsonc
{
  "prompt": "Wide shot, Image 2 crossing the bar toward camera, handheld.\n\nImage 2 is SARA — dark bob, scar through the left eyebrow.\nUse Image 5 for colour and grain only.",
  "negativePrompt": "sunglasses, modern logos",
  "inputAssetIds": ["ast_frame…", "ast_sara1…", "ast_style…"],
  "inputRoles":    ["first",      "reference",   "reference"],
  "items": [
    { "itemId": "itm_…", "revisionId": "itr_…", "handle": "sara",
      "labels": ["Image 2"], "tier": "anchor", "influence": 70,
      "plateAssetIds": ["ast_sara1…"], "droppedPlateAssetIds": ["ast_sara2…", "ast_sara3…"] }
  ],
  "warnings": ["@sara: 3 plates declared, 1 fitted — the provider accepts 3 references and the captured frame and @kodak_night took the others. Text raised to `anchor` to compensate."],
  "budget": { "referencesUsed": 3, "referencesAvailable": 3, "promptWords": 31 }
}
```

`budget` is not diagnostics — it drives the UI in §5.

### Where expansion happens

In the **service**, not the panel. The panel resolves handles for autocomplete;
the bundle is built server-side and persisted on the generation, because the
bundle *is* the reproducibility record. A panel building its own would be a
second implementation of the rules that matter most, drifting against the one
that gets stored.

---

## 4b. Items map onto Ark's own concepts

We talk to one vendor, and that vendor already has most of this. Using its
concepts instead of inventing parallel ones is most of the implementation.

| SEED concept | Ark native concept | Status |
|---|---|---|
| Item | **Asset Group** — "同一人物的多张素材", the several references of *one* character | plumbing exists, used wrong |
| Plate | **Asset**, with a permanent `asset://` id | implemented for video |
| `@sara` | **`@图片N` / `@视频N` / `@音频N`** — Ark's own prompt syntax | converges by accident |
| Plate roles | the guide's split of identity / clothing / environment / action / camera / sound across separate materials | same model |
| Plate recipe | "全身正面图 + 人脸正面无表情特写" — full-body front plus neutral face close-up | better than the turnaround I invented |

Four consequences, each a change to the plan above.

**An Item is an Asset Group, not a row in a shared one.** SEED currently sends
every reference from every character in every show to a single group
(`ARK_ASSET_GROUP`, default `"seed-ae"`) — the one thing the feature is
documented not to be for. `CreateAssetGroup` and `ListAssetGroups` are already
implemented in `packages/providers/src/ark/openapi.ts`; the Item just needs to
own the group id.

**A plate holds two addresses.** `asset://` ids are permanent and free to
register, and generation is paid, so an Item's plates are the ideal
pre-registration case — register once, reference forever, turn use-time into a
cache hit. But `asset://` is **video only**; `images/generations` rejects an
asset id in every form (our own measurement, ADR 0010). So a plate stores both
its asset id and its hosted URL, and the resolver hands each provider the form
it accepts.

There is a second reason to prefer the native path, and it is not an
optimisation: `MODEL_API_NOTES.md` records that **requests carrying recognisable
real people are intercepted on the inline path.** For a feature whose headline
is consistent characters, that is the difference between working and blocked.

**Budgets follow the recommended range, not the maximum.** Seedance 2.5 accepts
50 materials — 30 images, 10 video, 10 audio — but the published stable range is
**1–8 primary subject images** and 1–5 subject videos, and our own probe found
validation does not enforce a cap at all (30 and 64 both passed). Accepting is
not using. Default plate budgets are built against 8, not 30.

**Real people are a different object.** Real-person assets require the subject
to complete **liveness authentication themselves**, logging into their own
account through an H5 flow that returns a group bound to that person; every
later upload is checked for facial consistency. Virtual characters skip all of
it — "全自动的，没有人工审核、没有授权环节".

So an Item carries a `realPerson` flag and an authorisation state, and the UI
routes to the liveness hand-off rather than failing at generation time. An Item
built from a generated character is instant; an Item built from an actor needs
the actor, once, with their phone. That is a product fact, not an error case.

**And it changes the Item Pack.** Asset ids are described as needing to be
treated as secrets — they are not individually authenticated, so anyone holding
one can generate with that likeness. **A pack therefore never ships raw
`asset://` ids.** Packs carry content hashes; asset ids stay local and are
re-registered on import. Exporting a character must not export the ability to
impersonate someone.

> **Sourcing.** BytePlus's docs are JavaScript-rendered and would not fetch;
> `docs.volcengine.com` returned 403. The above is corroborated across
> ByteDance's published prompt guide, Chinese-language coverage and a
> third-party gateway's documentation — **concepts, not contracts.** Per
> `CLAUDE.md` none of it is settled until probed, and the probe list is in
> `CONSISTENCY_PLATFORMS.md` §15. The AK/SK client already exists, so it is
> cheap.

---

## 5. Seeing the prompt you are actually sending

The direct answer to *"the important parts get blurry and hard to control"*: the
assembled prompt is shown, not hidden.

Above Generate, the final prompt renders with each contribution visually
distinct — the artist's own words plain, Item-contributed text tinted and
labelled with the handle that produced it, style clause marked separately — with
a word count and a references-used-of-available meter.

Every Item contribution is adjustable in place: raise or lower influence, drop a
tier, mute an Item's text entirely and keep its plates. Nothing an Item adds to
a prompt is invisible or unremovable. That is the whole feature, and it is the
part that decides whether artists trust it.

---

## 6. Authoring — the item generator

**a. Adopt.** Select frames in the Library → *Make Item* → name, kind, roles by
drag order. No generation, no cost. How most Items will really be born, because
the artist has usually just captured the frame that made them want the character.

**b. Generate a plate set** — the generator proper. One seed image plus a
**plate recipe** for the kind:

- **character** — Ark's own recommendation first: **full-body front shot plus a
  neutral-expression face close-up**, which is documented as the pairing that
  works best in one asset group. Three-quarter, profile and back follow as
  optional extras rather than the core set. Neutral light, plain background.
- **prop** — three-quarter, top-down, detail, in-hand for scale
- **location** — establishing wide, reverse, detail, alternate time of day
- **style** — the reference plate is usually adopted, not generated

The character recipe is the native recommendation rather than the four-angle
turnaround the first draft invented, because the vendor has published which
pairing it wants and guessing over that would be silly.

Each plate is an ordinary `image.edit` generation from the seed image, so it
arrives with a full recipe and lineage and can be regenerated alone. The only
new machinery is the fan-out and a *promote outputs to plates* step. Recipes
live in runtime configuration so a studio tunes its own house turnaround.

**c. Import a pack** (§7).

**And: let the director draft the traits.** The agent already reads real
thumbnails. Pointed at an Item's plates it proposes a trait list with facets and
priorities — a structured output, which is what it is good at, rather than prose
we would then have to cut. Proposal only, editable, never auto-applied, under
ADR 0007's boundary.

---

## 7. The Item Pack — why this is a studio format

```
sara.seeditem/
  item.json          # item, every variant, every revision — self-contained
  media/
    3f9a…c1.png      # plates, content-addressed by sha256
  README.md          # generated character sheet
```

Plates are named by **sha256 plus original filename**, never local asset id, so a
pack means the same thing in every instance. Import maps hashes onto media that
already exists — the Ark asset library already does content-hash dedupe, same
instinct — and registers only what is new. Importing an Item you already have
never overwrites: it creates a revision, or forks on a handle collision, and
says which.

- A pack is **git-committable** — a show's cast lives in the show's repo.
- A pack is readable **without SEED**: no SQLite, no Adobe, no service.
- A pack **survives this product**. If SEED is replaced, the cast is not.

---

## 8. Where the code goes

| Piece | Home |
|---|---|
| Schemas | `packages/domain/src/item.ts` |
| Resolver + tiering + budget | **`packages/items`** (new, pure) |
| Pack read/write | `packages/items` |
| Storage | migration **v5** — `items`, `item_variants`, `item_revisions`, `item_plates`, `item_traits`, `item_handles`, `generation_items` |
| Provider binding | `items.ark_group_id`, `items.real_person`, `items.authorisation_state`; `item_plates.ark_asset_id` beside the hosted URL |
| HTTP | `apps/service/src/routes/items.ts` → `/v1/items/*` |
| Panel | new **Items** tab + prompt preview in Generate |
| Standalone | same bundle, second Vite entry `items.html` |
| CLI | `scripts/item.ts` |

**The rule that keeps this abstract:** `packages/items` imports nothing
Adobe-specific and nothing provider-specific. The resolver takes
`ProviderCapabilities` as a plain argument; it does not know Ark exists. A future
studio-wide Item service is then a lift, not a rewrite — and that possibility is
the entire reason for the constraint.

**Handles** are chosen, not derived from filenames. Renaming is allowed:
`item_handles` keeps every handle an Item has held with the window it was current
for, so old prompts still resolve. Recipes link by revision id regardless; the
handle is presentation.

---

## 9. What is guaranteed, and what is not

**Guaranteed:** the same plates in the same order, the same traits at the same
tier, a bundle that reproduces exactly, and a warning whenever something did not
fit.

**Not guaranteed:** that the model holds the identity. That varies by provider
and plate count and **has not been measured here.** Nothing in this document is
a claim about Seedream's or Seedance's identity retention.

So `scripts/probe-items.ts` ships *with* the feature. Everything in §4b is
concepts corroborated from unofficial renderings of official docs, so the first
three questions are contract checks before they are quality checks:

1. **Does a per-Item `CreateAssetGroup` work, and does it beat the single shared
   group we use today?** Groups are free; this is a structural fix either way.
2. **Does an English materials manifest work as well as the Chinese
   【素材职责】 form?** The highest-value prompt question we have, and the one
   the whole §4 tiering model rests on.
3. **Do plates registered as `asset://` beat hosted R2 links** for Seedance
   retention — and do they avoid the real-people interception?
4. Does retention improve, plateau or degrade across 1 / 2 / 4 / 8 plates,
   against the documented 1–8 stable range?
5. With no `--cw`, does plate count behave like an influence dial, and does a
   high count cost prompt adherence as the literature predicts?
6. Does a three-character prompt hold all three, or collapse?
7. Do style plates leak subject content when mixed with subject plates?
8. The liveness flow, end to end, for one real person — before it is promised
   in any UI.

Seedance accepted 30 references and even 64 in our own testing while the
published stable range is 1–8. Accepting is not using. Budgets are built against
8.

No UI copy claims consistency before 2, 4 and 6 have numbers.

---

## 10. The standalone tool

The panel already runs in a browser against the local service with a mock host —
that fallback is most of the standalone tool, built and tested. So: **the same
React bundle, second Vite entry** (`items.html`) mounting only the Items tab. A
producer or concept artist opens a URL, builds the cast, exports packs. No After
Effects, no CEP. Same component in and out of AE, so they cannot drift.

```
npx tsx scripts/item.ts new sara --kind character
npx tsx scripts/item.ts add-plate sara --role profile --asset ast_…
npx tsx scripts/item.ts trait sara --add "faint scar left eyebrow" --facet face --drift-prone
npx tsx scripts/item.ts export sara --out ./cast/
npx tsx scripts/item.ts import ./cast/sara.seeditem
npx tsx scripts/item.ts resolve "wide of @sara in @bar, @kodak_night" --provider seedream
```

`resolve` is the important one: it prints the exact bundle — plates chosen,
plates dropped, tier per Item, final prompt, word count, warnings — without
spending anything. When a shot comes back wrong that is the first command to
run, and it is the difference between a system you can debug and one you argue
with.

---

## 11. Build order

**Slice 1 — the spine.** Schemas, migration v5, `/v1/items` CRUD, traits,
adopt-from-library, the resolver with tiering and budget, `@item` wired into
Generate, revision ids on the generation, Items tab, prompt preview.
*Done when:* type `@sara`, generate, get her plates attached and the right
amount of text — then reopen after two revisions and get the identical bundle.

**Slice 2 — authoring.** Plate-set generation, variants, revision history and
diff, drag-order weights, influence control, style Items with look binding.

**Slice 3 — the studio format.** Pack export/import, content-hash mapping,
handle-collision forking, CLI, standalone entry.

**Slice 4 — the measured part.** Director-drafted traits; the probe and its
research note; video plates where `videoReferences` allows.

---

## 12. Open questions

1. **Everything in §9.** Tiering is a reasoned design against measured
   literature, not a measured result on Ark.
2. **Video plates.** Useful for a location, and straight into the rule that a
   `reference_video` makes Ark read the request as video editing and refuse
   duration and ratio. In the model, offered only where measured.
3. **Two Items, one plate** — a prop inside a character's plate. Real, currently
   just allowed, unclear whether it should be modelled.
4. **Scope default.** Items studio-wide, Assets project-tagged — the inverse of
   the existing rule, deliberate, worth disagreeing with before the migration.
