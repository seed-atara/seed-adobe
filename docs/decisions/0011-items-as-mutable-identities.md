# 0011 — Items are identities on the reference channel, pinned by immutable revisions

Status: proposed
Date: 2026-08-17

## Context

Everything in the library is a file. That was the right first model — an Asset is
immutable, append-only, and carries the recipe that made it — and it has no way
to say *this is the same character as that*.

Consistency across shots is what a production actually needs and it cannot be
expressed with assets alone. `@bar_wide` today points at one frame, resolved from
its filename. It cannot mean "the bar, from whichever four angles we have,
described the way that works, at night".

Two problems have to be solved together.

**A curated bundle of references is mutable** — it gains plates, loses them, gets
rewritten mid-show — while every recipe here is a promise that the same inputs
can be recovered later.

**And the obvious implementation is wrong.** The first draft of this decision had
an Item inject its description into every prompt. Three characters at forty words
each is a hundred and twenty words of identity competing with the shot direction,
and the research (`docs/research/CONSISTENCY_PLATFORMS.md`) says plainly that no
mature platform does this. Runway states the principle — *"references define who
your character is; prompts define what happens to them"* — and its `@name` tag
resolves to an image slot contributing no text at all. Midjourney passes a URL
and a scalar weight. MiniMax and Vidu take a `subject_reference` array that is a
separate API field from the prompt. Underneath, IP-Adapter's decoupled
cross-attention exists precisely so image conditioning does not compete with text
for the same attention budget, and prompt adherence is documented to degrade with
length, worst when a prompt carries many objects with many attributes.

## Decision

Introduce **Items** as a second first-class entity — identity split from
definition, and identity carried on the reference channel rather than in prose.

An Item is an identity: a handle, a kind (**character, location, prop, style**),
and nothing generative. A **Variant** is a deliberate alternate state. A
**Revision** is an immutable snapshot of what the variant means. Items reference
Assets and never contain them, so every plate keeps its own lineage.

Five constraints are the decision.

**A generation records revision ids and the expanded bundle, never just an item
id.** An Item resolved at generation time is a snapshot, and the snapshot is what
persists. Reopening reproduces identical inputs whatever the Item has since
become; moving an old recipe forward is explicit and shows a diff. Recording only
the item id would produce recipes that look reproducible and are not — the
failure already found here once, when a reopened video recipe silently changed
its own length.

**Binding is always written; description shrinks as plates fit.** Two kinds of
text were conflated in the first draft of this decision. *Description* — "late
30s, dark bob, olive jacket" — belongs on the plate and not in the prompt, which
is Runway's principle and the reason IP-Adapter has a separate attention pathway
at all. *Binding* — "@image1 is Sara's face and wardrobe; ignore its background"
— can be carried by nothing else, and Ark's own guide requires it: 素材映射关系
必须写进提示词, the material mapping must be written into the prompt, including
what is explicitly *not* to be taken from each reference.

So an Item emits a compact materials manifest derived from the plate roles it
already stores — software's job, never the artist's — and grows it with
drift-prone traits only as plates are lost to the budget, reaching a full
character sheet only where the provider accepts no references at all. Identity is
therefore structured as traits with facets and priorities rather than one prose
blob, because a blob cannot be cut intelligently. Drift-prone traits are the
discrete nameable details — a scar, a logo, a specific colour — that references
drop and sentences hold. The manifest scales with the number of materials rather
than with how much personality anyone wrote down, which is what keeps it from
blurring the shot direction.

**Influence is a first-class control, not prompt syntax.** Every mention carries
0–100. Identity strength and text control pull against each other — a character
locked at maximum cannot be given a new coat by the prompt — which is why every
platform that has been at this a while ships the dial (`--cw`, `--sw`, Magnific's
strength sliders). Ark has none, so influence maps to how much of the reference
budget the Item wins, and the panel says that rather than implying a knob the
provider does not have. The prompt text selects *which* thing; the control sets
*how strongly*.

**Expansion is a pure function in its own package that knows nothing about Adobe
or any provider.** `packages/items` takes prompt text, resolved mentions and a
`ProviderCapabilities` value and returns the bundle. It does not know Ark exists.
This is what keeps the feature liftable into a studio-wide service, and it is why
the boundary is a rule rather than a preference.

**Nothing is dropped silently, and nothing is invisible.** Plates compete for a
small budget, allocated round-robin across Items by weight rather than
depth-first — three characters and a budget of three gets one plate each, not
everything to the first and two characters described but never shown. Every plate
that did not fit is named in a warning before Generate, and the assembled prompt
is displayed with each Item's contribution tinted, labelled and adjustable in
place. ADR 0007's rule, applied to a component whose failure mode is a prompt the
artist did not write.

Style is one of the kinds rather than a separate concept: `--sref`/`--sw` is a
structural parallel of `--cref`/`--cw`, and Runway and Kling put style and
subject on one reference channel. A style Item may additionally carry a
`packages/filmlook` preset, so a look and its references travel together.

**Where Ark has the concept already, we use Ark's.** SEED talks to one vendor and
that vendor has most of this natively: an **Asset Group** is documented as the
several references of *one character* — which is exactly an Item — and an
**Asset** carries a permanent, free-to-register `asset://` id, while generation
is paid. So an Item owns an asset group rather than sharing the single
product-wide group the service uses today, and a plate stores its asset id
beside its hosted URL because `asset://` is accepted for video and rejected for
images. Ark's own prompt syntax is `@图片N`, which the mention system built for
the direction agent converges with by accident, and Ark's recommended character
plates — full-body front plus neutral face close-up — replace the turnaround
this decision first invented. Budgets are built against the published stable
range of 1–8 images, not the accepted maximum of 30.

Two of those facts are constraints rather than conveniences. Requests carrying
recognisable real people are intercepted on the inline path, so the asset
library is the sanctioned route for the feature's headline case. And real-person
assets require the subject themselves to complete liveness authentication, while
virtual characters are automatic — so an Item carries a `realPerson` flag and an
authorisation state, and the UI routes to the hand-off rather than failing at
generation time.

The portable form is an **Item Pack**: a directory of `item.json` plus
content-addressed media, plates named by sha256 rather than local asset id, so a
pack means the same thing in any instance, commits to a show's repo, and is
readable without SEED, SQLite or Adobe. **A pack never carries raw `asset://`
ids** — they are described as needing to be treated as secrets, are not
individually authenticated, and exporting a character must not export the
ability to generate with that person's likeness. Ids stay local and are
re-registered on import.

## Consequences

- Assets keep their discipline untouched. Mutability arrives as a new entity with
  its own rules rather than by relaxing the triggers that make the library
  trustworthy.
- Handles are chosen rather than derived from filenames, and renaming is allowed:
  handle history is kept and linkage is by revision id.
- Items are studio-scope by default while Assets stay project-tagged — the
  inverse of the existing rule, and deliberate. Items exist to travel.
- Plate generation is not new machinery: a plate set is a fan-out of ordinary
  `image.edit` generations, each with its own recipe and lineage.
- Ark has a single reference channel, so style plates compete with subject
  plates and may leak subject content. They sort last and are labelled as colour
  and grain only. Whether that is sufficient is an open probe question.
- An Item built from a generated character is instant; one built from a real
  actor needs the actor, once, with their phone. That is a product fact to model
  honestly, not an error case to handle.
- **What this does not decide, and the sourcing behind it.** BytePlus's docs are
  JavaScript-rendered and would not fetch, and `docs.volcengine.com` returned
  403. Everything above about Ark's native concepts is corroborated across
  ByteDance's published prompt guide, Chinese-language coverage and a
  third-party gateway's documentation — **concepts, not contracts**, and
  `CLAUDE.md` is explicit that a contract is not real until it is measured. The
  AK/SK OpenAPI client already exists, so the probe list in
  `CONSISTENCY_PLATFORMS.md` §15 is cheap to run and comes first: per-Item asset
  groups, an English materials manifest against the Chinese form, and `asset://`
  plates against hosted links. Beyond the contracts, whether these models hold
  an identity given N plates is unmeasured, the tiering model is reasoned from
  literature about other models, and no UI copy claims consistency before the
  probe has numbers.
