# Prompt craft — what the director was taught, and from where

**Written 2026-08-27.** Source: the skills corpus in `harness-workbench`
(`packages/db/src/seed/skills-corpus/`), principally `seedance-prompt-lab.md`,
which is itself distilled from BytePlus's own prompt-engineering guidance —
the `Prompt_Lab_SD` deck (June 2026) plus the first-party ModelArk docs at
`docs.byteplus.com/en/docs/ModelArk/2607689`, captured by hand.

That corpus is roughly 23,000 lines across eighteen files, fifteen of them
genre playbooks (cinematic, anime action, product 360, real estate). This note
records the part that was ported into SEED's direction agent, the part that was
not, and why the line falls where it does.

## Why this happened at all

SEED's director had a rule that read, in full:

> One paragraph. No lists, no headers, no "masterpiece, 8k, highly detailed"
> tag-soup.

For a still that is right. For a moving shot it is the **opposite** of the
model-maker's own guidance: Seedance splits a prompt into a spatial layer (what
is in frame) and a temporal one (how it changes), and reads a shot as an
ordered sequence of beats. A paragraph gives the temporal layer nothing to
follow.

So we were asking for the wrong shape and then judging the model on the answer.
That is worth stating plainly, because it is the kind of defect no test catches
and no error message reports — the prompts kept coming back, they were just
worse than they needed to be.

## Ported

| Rule | Why it is safe to port |
| --- | --- |
| Timecoded beats for video, paragraph for stills | Craft, published by the model's makers, and directly contradicted by what we had |
| Element order — subject, action, scene, light/colour, camera, style, constraints | Craft; surface-agnostic |
| One camera move per beat | Craft; a push and a pan together cost frame stability |
| Externalise emotion ("lips trembling", not "very sad") | Craft; directable versus not |
| Closing constraint line (stable face, fluid motion, no flicker) | Published as an always-append tail |
| No resolution tag in the prose | Resolution is a request parameter. Seedance 2.5 has no 4K, so "4K" in a prompt asks for a thing that does not exist |
| `{}` dialogue, `()` music, `<>` SFX, `【】` titles | Documented API markup. SEED passes the prompt through verbatim, so it reaches the model intact |
| Trigger words flip the task type | Real, reported API failure: `add`/`remove`/`replace`/`change to`/`insert`/`delete`/`edit` in the **prose** can lock the request into edit mode, which forces `duration=-1` and `ratio=adaptive` and then fails a fixed duration with `InvalidParameter.TaskTypeConstraint`. Nobody set a field; the words did it |

## Deliberately not ported

**`@Image1` / `@Video1` / `@Audio1` prose tagging.** The corpus is explicit
that this is *two matching halves*: the tag in the prose **and** a matching
semantic role on the reference object. SEED's roles are frame pins — `first`,
`last`, `loop`, `reference` — which the Seedance adapter sends as the API's own
`reference_image` / `first_frame` / `reference_video` values. There is no
"character anchor" or "scene setting" role in SEED's payload to pair a tag
with.

Telling the director to write tags whose other half we do not send would be a
capability announced and not wired — the exact failure this repo has already
paid for twice. If SEED grows semantic reference roles, this becomes portable
and is the first thing to revisit.

**The fifteen genre playbooks.** They are written for a project that picks a
genre up front (`01-cinematic`, `08-anime-action`, `15-real-estate`). SEED's
director works from the artist's own footage and their own words, and
`CLAUDE.md` is explicit that the artist's vocabulary is load-bearing. Injecting
a genre playbook would push against the reference frames rather than read them.

**Reference-count ceilings.** The corpus gives an official 50-asset ceiling (30
images / 10 videos / 10 audio) and a recommended 4–5. SEED already has its own
measured numbers in `SEEDANCE_MAX_REFERENCES` and `SEEDANCE_STABLE_REFERENCES`,
and `docs/research/MODEL_API_NOTES.md` records what was actually generated
with. Measured beats documented; the existing values stand.

## Not verified here

Everything in the ported column is either craft (unfalsifiable in the short
term, and costs nothing if wrong) or documented API behaviour taken on the
corpus's authority. **None of it has been A/B'd against SEED's own output.**
The honest claim is "the director now asks for the shape the model's makers say
it reads", not "prompts are better". Judging that needs the same shot directed
both ways, and that has not been done.

The regression tests in `apps/service/test/director.test.ts` assert the rules
are present in the system prompt. They cannot assert the prompts are good.

## Worth taking next

- **`byteplus-seed-stack.md`** — routing and credentials, overlapping what
  SEED already knows. Read it before changing `ARK_BASE_URL` guidance.
- **`seedance-sequence-designer.md`** (442 lines) — multi-shot sequence
  planning. Relevant when SEED grows beyond one generation at a time.
- The EXTEND-versus-SPLICE decision for content past 30s. SEED does not chain
  clips yet; when it does, the corpus already has the rule (dialogue and slow
  emotional beats extend, action splices).
