# Advanced features — where SEED should go next

Researched 2026-08-22. The existing `FUTURE_FEATURES.md` is a list of known
gaps and small fixes; this is the strategic layer above it — what to build to
be worth using rather than merely working.

## What the market actually looks like now

Three findings that should shape everything below.

**The models have commoditised.** Higgsfield and Runway both carry Seedance
2.0, Kling 3.0, WAN 2.6, Veo 3.1 and Gemini Omni Flash as licensed
integrations. The same weights, at slightly different prices — Kling 3.0 is
$1.00 on one and $1.30 on the other. **Nobody differentiates on the model any
more.** Chasing model breadth is chasing the commodity.

**Identity has separated from motion, and everyone has done it.** The 2026
shift is not that models remember characters, it is that workflows separate
*creating an identity* from *creating a shot*. Higgsfield's Soul ID trains a
persistent identity from 20+ reference photos and reuses it across every
generation. SEED's Items are the same *idea* — but Items are a bundle of
plates and text, not a trained identity, and that difference will show on
angles no plate covers.

**The professional gap is control and provenance, and it is wide open.** The
recurring complaint about consumer tools is that a director who dislikes one
element has no way to change it — the tools are described plainly as "not very
director-friendly". What studios need instead is provenance, budget and
approval on every shot, and tooling that fits around existing edit decisions,
footage management, colour workflows and human approval. C2PA provenance is
becoming product-level infrastructure across Apple, Nikon, Leica and Samsung.

**And Adobe is now in the room.** After Effects shipped AI motion design in
January 2026 — extending shots and generating B-roll without leaving the
application. That is validation of SEED's thesis and a warning: *being inside
After Effects* is no longer by itself a differentiator. What Adobe will not do
is provenance, recipes, and a library that outlives the project file.

## Where that leaves SEED

SEED already has the three things the market is missing, in rough form:

| the gap | what SEED has | how far along |
|---|---|---|
| director-level control | regions, roles, seeds, recipes | real, and unusually good |
| identity across shots | Items, revisions, lineage | real, but plate-based not trained |
| provenance | generation records, AE provenance, immutable assets | real, but nobody outside SEED can read it |

The plan below deepens those three rather than adding a fourth.

---

## Tier 1 — things only something living in the timeline can do

This is the moat. None of it is possible from a web app, and Adobe is unlikely
to build it because it requires a library with memory.

### 1. The shot list is the comp

An artist already has a sequence: layers on a timeline, or markers, or a
folder of comps. Today SEED generates one shot at a time and knows nothing
about the others.

Read the edit as a shot list, and generate across it with shared Items. Not a
separate storyboard app — the storyboard is the timeline, which is the whole
point of living here. A shot list view that shows which shots have results,
which are stale, and which never ran.

**Rests on:** `seedListRegions`/comp traversal already in the host, Items
already resolved per generation.

### 2. A region that moves

Regions are static rectangles today, which is why the plate has to be a still
or a clip that happens to hold still. After Effects already has tracking data,
and a region is an ordinary layer that can be keyframed or parented.

Read the guide layer's animated transform per frame and let a region follow a
face across a shot. This turns region generation from "a locked-off insert"
into "an actual VFX task".

**Rests on:** regions already being real layers with real transforms; the
capture already renders a temp comp per frame.

### 3. The conform pass

Change an Item's revision — a character's costume, a location's time of day —
and every shot made from the old revision is now stale. The lineage already
records exactly which revision each generation used.

Make that actionable: show what is stale, and re-run a selected set against
the new revision as a batch. This is the feature that turns a library into a
production database, and it is worth more than any model.

**Rests on:** `generation_items` and revision ids, already recorded.

### 4. Finishing as a pass, not a manual step

Every generated clip currently arrives raw. The film look and the frequency
detailer both exist and both have to be applied by hand.

A per-project finishing chain — detail transfer from the source plate, then
the look — applied on import, as ordinary AE effects the artist can adjust or
delete. Nothing destructive, nothing hidden.

**Rests on:** both plugins existing; `insertAtPlayhead` already builds layers.

---

## Tier 2 — identity, where the market is ahead

### 5. Choose plates by what the shot needs

An Item can hold many plates but the resolver allocates them round-robin under
a budget. It has no idea that a shot is a profile close-up and that three of
the eight plates are three-quarter mids.

Tag plates by what they show — angle, framing, lighting — either by asking the
describer or by measuring, then pick the plates closest to the shot being
generated. This is the cheapest large win available: no new infrastructure,
noticeably better likeness.

**Rests on:** `agent/describer.ts` already reads plates; `allocatePlates`
already has the budget mechanics.

### 6. Trained identity, if Ark offers it

The honest position: a bundle of plates cannot match a trained identity on
angles no plate covers, and Soul ID is a real advantage. Whether SEED can
answer it depends entirely on whether Ark exposes fine-tuning or an identity
endpoint.

**This is research, not a plan.** Nothing should be designed around it until
someone has read Volcengine's documentation and established what exists. If
nothing does, item 5 is the answer and is good enough for most shots.

---

## Tier 3 — the things a studio buys

### 7. Provenance that leaves the building

SEED records more about how a shot was made than any competitor. All of it is
trapped in a local SQLite file.

Two exports, both small:

- **C2PA-signed outputs.** The manifest work already exists for packs. Signing
  a delivered clip with its recipe is credible provenance at exactly the moment
  the industry is standardising on it.
- **A shot report.** One page per shot: the plates, the prompt, the Item
  revisions, the seed, the cost. Producers ask for this and nobody can produce
  it.

### 8. Approval state, and a library two people can share

`status` exists on assets but means "is the media ready", not "has a human
signed this off". Add an approval state and who set it. Then the cloud sync
already anticipated in the architecture has something worth syncing.

---

## Tier 4 — economics

### 9. Cost per shot, per project

`CLAUDE.md` names cost accounting as a reason for the service. It has never
been built, and this session alone lost track of three billed generations
because a probe bypassed the service.

Record what each generation cost, roll it up per shot and per project, and
show it before Generate rather than after.

---

## What not to build

- **More providers, for breadth.** The models are commodity and each adapter is
  a permanent maintenance cost. Add one only when it does something Ark cannot.
- **A prompt-chat front end.** The deterministic workflow is the product;
  `CLAUDE.md` says this and the market agrees — the complaint about consumer
  tools is a *lack* of control, not a lack of conversation.
- **A web version.** Everything in Tier 1 is worthless outside the host.

---

## Suggested order

1. **Plate selection by shot need** (5) — cheapest real quality win.
2. **The conform pass** (3) — turns the library into a production tool.
3. **Finishing chain on import** (4) — makes existing work pay off.
4. **Shot list** (1) — the frame everything else hangs on.
5. **Moving regions** (2) — the hardest, and the most obviously ours.

Provenance export (7) can go at any point and is the best demo material in the
list.

## Sources

- [Elser AI — best AI video generators with consistent characters, 2026](https://www.elser.ai/blog/best-ai-video-generators-with-consistent-characters-in-2026-what-actually-works-across-multiple-scenes)
- [Elser AI — which model keeps characters most consistent](https://www.elser.ai/blog/best-ai-video-model-character-consistency-2026)
- [Higgsfield vs Runway 2026](https://higgsfield.ai/blog/higgsfield-vs-runway-2026)
- [Apostle — Runway vs Higgsfield, tested by a production studio](https://apostle.io/compare/runway-vs-higgsfield/)
- [VFX Voice — AI/VFX roundtable](https://vfxvoice.com/ai-vfx-roundtable-revolutionizing-imagery-the-future-of-ai-and-newer-tech-in-vfx/)
- [FXiation — what AI-driven VFX can and cannot do in 2026](https://www.fxiationdigitals.com/blog/ai-driven-vfx-production/)
- [Digen — professional AI video production workflow 2026](https://resource.digen.ai/professional-ai-video-production-workflow-2026/)
- [MindStudio — storyboards and character sheets for AI video](https://www.mindstudio.ai/blog/storyboards-character-sheets-ai-video-generation)
