# How other platforms hold a character, a place, or a look

Date: 2026-08-17
Status: **Parts 1 and 2 are desk research; Part 3 is measured.** Parts 1 and 2
are what vendors and papers say and have not been run against Ark — treat them
as hypotheses. Part 3 reports real generations and says so. Claims about
Seedream/Seedance behaviour must come from `MODEL_API_NOTES.md`, which is
measured, or from a probe.

The question this was written to answer: if an Item injects a paragraph of
identity text into every prompt, does the prompt get so long that the actual
shot direction stops landing?

**Answer: yes, and it is the wrong channel.** Not one mature platform puts
identity in the prompt text. They all put it somewhere else and leave a pointer.

---

## 1. The pattern, stated once

> "References define who your character is; prompts define what happens to
> them."
> — Runway's own Gen-4 References guidance

Every platform below implements that sentence. Identity travels on a
**non-textual channel** — an image slot, a code, an embedding — and the prompt
carries a **short pointer** plus *only what is different about this shot*.

| Platform | Identity channel | Pointer in the prompt | Strength control |
|---|---|---|---|
| Midjourney | `--cref <url>` | none needed | `--cw 0–100` |
| Midjourney (style) | `--sref <url\|code>` | none needed | `--sw 0–1000`, default 100 |
| Runway Gen-4 | up to **3** reference images | `@name` tag, autocompleted | — |
| Kling Elements | 1–4 images per element | prose refers to the element | — |
| MiniMax Hailuo S2V-01 | `subject_reference` array | prose | — |
| Vidu Reference-to-Video | `reference_images` array | prose | — |
| Magnific | style ref + structure ref images | — | style / structure strength sliders |

Two things are worth noticing about that table.

**The pointer is a name, not a description.** Runway's `@name` autocomplete is
the exact affordance we designed independently — and in Runway the tag resolves
to an *image slot*, contributing no descriptive text at all.

**Every platform that has been at this a while has a scalar.** Midjourney has
two (`--cw`, `--sw`), Magnific has two (style strength, structure strength).
Identity strength is not a nicety; it is the primary creative control, because
of the trade-off in §3.

---

## 2. Why the text channel is the wrong one, architecturally

IP-Adapter — the technique most of this is built on — works by **decoupled
cross-attention**: it adds a *separate* cross-attention layer for image features
rather than reusing the text one. The entire point of the design is that image
conditioning should not have to compete with text conditioning for the same
attention budget.

InstantID goes further, replacing the coarse CLIP embedding with a dedicated
face ID embedding, and in its own cross-attention conditions on the face
embedding rather than the text prompt. PuLID adds contrastive alignment
specifically to *minimise disruption to the original model's* text following.

So the industry's engineering effort has gone into getting identity **out** of
the text pathway. Writing forty words of character description into a prompt
puts it back in — using the channel these architectures were built to avoid,
and spending the attention budget the shot direction needs.

---

## 3. The trade-off that makes a strength dial necessary

Identity conditioning and text control pull against each other, and this is
documented rather than folkloric:

- PhotoMaker and IP-Adapter-FaceID reach good identity fidelity with "obvious
  degradation of text control capabilities."
- InstantID and ConsistentID "tend to generate high-fidelity portraits but often
  lose consistency with textual semantics."
- Practitioner summary of PuLID: it "locks the face so tight that you get a
  series of images that all look like the reference photo with a body attached
  — great for portrait work and terrible for diverse content."
- Midjourney's `--cw` is exactly this dial: at `100` it takes face, hair *and*
  clothing; at `0` it takes essentially the face only, freeing the prompt to
  redress the character. Community consensus puts the `--sw` sweet spot at
  65–175 against a default of 100 and a max of 1000.

**Consequence for us:** a character locked at maximum is a character who cannot
be given a new coat by the prompt. "More identity" is not "better". Any Item
design that has no way to say *hold the face, let the wardrobe go* is missing
the control artists actually reach for.

---

## 4. Long prompts measurably degrade

- Prompt adherence shows "consistent degradation as prompt length increases",
  and models "cannot perfectly handle long and complex text prompts, especially
  when the text prompts contain various objects with numerous attributes and
  interrelated spatial relationships" (DetailMaster, arXiv 2505.16915).
- CLIP text encoders cap at **77 tokens**. T5 (SD3.5, FLUX) reaches 512.
  Seedream 4.0 is a diffusion transformer with its own encoder stack and no
  published 77-token cliff — but "handles long prompts better" is not "is
  indifferent to length".
- "Attention dilution": as user content grows, proportionally less attention
  weight lands on the earlier tokens.

"Various objects with numerous attributes" is a precise description of three
Items each contributing hair, face, wardrobe and props to one prompt. This is
the failure mode named in the literature, not a hypothetical.

---

## 5. What the production side does about it

The independent film-production advice converges on the same shape from the
other direction: build a **character bible** of canonical reference images once,
then "instead of re-describing your lead in each prompt, feed the model her
reference portrait." Where text is used, it is **"look tokens — short, reusable
descriptors"**, not paragraphs.

The failure they name is **attribute drift**: generate from a text description
twice and you get "similar hair, different face."

That last point is the useful nuance, and it cuts *both* ways: references are
strong exactly where text is weak (face, proportion, palette), and text is
strong exactly where references are weak (a discrete nameable detail — a scar,
a logo, a specific colour — that a model will quietly drop from a plate). They
are not redundant. **They should carry different information.**

---

## 6. What this means for SEED's Items

Six conclusions, each with a design consequence:

1. **Identity belongs on the reference channel; the prompt gets a pointer.**
   Full descriptions are a *fallback tier*, not the default.
2. **Text should carry only what references drop** — discrete, nameable,
   drift-prone details. So identity text must be structured as individual
   traits with priorities, not one prose blob, or the resolver cannot choose.
3. **The artist's shot direction goes first in the prompt**, because attention
   decays with position and the direction is what must land.
4. **An influence scalar per Item is a core control, not a refinement.** Ark
   exposes no `--cw`; where a provider has no dial, plate count and ordering are
   the dial, and the panel must say that is what it is doing.
5. **Style is the same mechanism as character.** Midjourney's `--sref`/`--sw` is
   a straight parallel of `--cref`/`--cw`, and Runway/Kling collapse style and
   subject into one reference channel. A `style` Item kind is not an extension —
   it is the same object with different plate roles.
6. **Reference budgets are small.** Runway takes 3, Kling 4 per element,
   Midjourney one `cref` at a time. Seedance accepted 30 and even 64 references
   without complaint in our own testing — but *"whether generation quality holds
   at high reference counts" is explicitly unverified* in `MODEL_API_NOTES.md`.
   Accepting is not using. Assume small, measure before assuming otherwise.

---

## 7. Still unknown, and only a probe can answer

1. Does Seedream/Seedance identity retention improve, plateau, or degrade
   between 1, 2, 4 and 8 plates of one Item?
2. Is a short look token (§5) worth its tokens *when plates are already
   present*, or does it just dilute?
3. With no `--cw`, does plate count actually behave like an influence dial on
   Ark — and does a high count cost prompt adherence, as §3 predicts?
4. Multi-item: does a three-character prompt hold all three, or collapse?
5. Do style plates and subject plates interfere when mixed in one request?

These are the probe's job. Nothing in the UI should claim consistency until
1, 3 and 4 have numbers.

---

# Part 2 — Ark's own concepts (2026-08-17)

The pass above surveyed platforms we do not use. This pass asks the sharper
question: **since SEED only talks to Ark, what does Ark already have?**

Answer: nearly all of it. Ark has a native grouping-of-references-per-character
concept, a permanent reference id, a native `@` prompt syntax, and published
guidance on how references should be described. We have been using one of these
correctly and the rest not at all.

> **Sourcing warning.** BytePlus's own docs are JavaScript-rendered and would not
> fetch; `docs.volcengine.com` returned 403. What follows is corroborated across
> ByteDance's published prompt guide (via mirrors), Chinese-language coverage,
> and a third-party gateway's documentation. **Per `CLAUDE.md`, none of it is a
> contract until probed.** The repo already has a working AK/SK OpenAPI client,
> so probing is cheap — see §14.

## 8. An Ark Asset Group is an Item

The single most useful finding:

> "同一人物的「全身正面图 + 人脸正面无表情特写」放进同一个素材组，效果最好"
> — put the same person's full-body front shot and neutral-expression face
> close-up in **one asset group** for the best result.

And, more strictly, for real people: "一个真人组只能录同一个人" — **one
real-person group holds exactly one individual.**

So Ark's `AssetGroup` is not a folder. It is *the multiple references of one
character*, which is precisely what an Item's plate set is.

**SEED currently uses one asset group for the entire product** —
`ARK_ASSET_GROUP`, default `"seed-ae"` (`apps/service/src/config.ts`). That is
one group holding every reference from every character in every show, which is
the one thing the feature is documented not to be for.

`packages/providers/src/ark/openapi.ts` already implements `CreateAssetGroup`,
`ListAssetGroups`, `CreateAsset`, `GetAsset` and `ListAssets`. The plumbing for
an Item-per-group exists and is wired to a constant.

## 9. `asset://` is a permanent plate id — for video only

- Asset ids are **permanent**: "素材 ID 永久有效", reusable across requests with
  no expiry.
- Registration is free; generation is paid. `MODEL_API_NOTES.md` already draws
  the conclusion — pre-registering turns use-time into a cache hit — and an
  Item's plates are the perfect case, since they are referenced over and over.
- **Images are still excluded.** `asset://` works for video generation only;
  `images/generations` rejects an asset id in every form. That is our own
  measured finding (ADR 0010) and this pass corroborates it independently.

So Seedance gets the native path and Seedream keeps hosted R2 links. The Item
layer must therefore hold **both** a plate's `asset://` id and its hosted URL,
and hand the provider whichever it can use.

There is also a non-obvious reason to prefer the native path that
`MODEL_API_NOTES.md` already records: **requests carrying recognisable real
people are intercepted on the inline path.** The asset library is the sanctioned
route. For a product whose headline feature is consistent *characters*, that is
not an optimisation, it is the difference between working and being blocked.

## 10. Real humans need the person's own liveness authorisation

A hard product constraint, not a technicality.

- Real-person assets require the subject themselves to complete **liveness
  authentication** by logging into their own Volcano/Douyin account through an
  H5 flow. A session returns a `GroupId` bound to that authenticated person, and
  every subsequent upload to it is checked for facial consistency.
- Virtual characters skip all of it: "虚拟人像入库是全自动的，没有人工审核、没有
  授权环节" — fully automatic, no review, no authorisation step.

**Consequence:** an Item built from a real actor cannot be self-served by the
artist. It needs the actor present, once, with their phone. An Item built from a
generated character is instant. The Items UI has to model this difference
honestly — a `realPerson` flag on the Item, an authorisation state, and a route
that hands off to the liveness flow rather than failing at generation time.

Asset ids are also described as needing to be treated as **secrets**: they are
not individually authenticated, so anyone holding one can reference it. That
lands directly on the Item Pack design in `ITEMS.md` §7 — **a pack must not ship
raw `asset://` ids**, or exporting a character exports the ability to generate
with that person's likeness. Packs carry content hashes; asset ids stay local
and are re-registered on import.

## 11. Seedance 2.5 takes 50 reference materials

| | Max | Recommended for stability |
|---|---|---|
| Images | 30 | 1–8 primary subjects (some sources say 9–12) |
| Video | 10 (30s total) | 1–5 subjects, 5–10s each |
| Audio | 10 (30s total) | only where directly relevant |
| **Total** | **50** | — |

Seedance 2.0's ceiling was 12, so 2.5 is a fourfold increase. "超过推荐范围仍可
尝试" — you may exceed the recommended range, with stability decreasing.

This reconciles with our own probe, which found 30 and even 64 passing
*validation* on 2.5: validation is not the limit, and `MODEL_API_NOTES.md` was
right to record that accepting is not using. **The recommended range, not the
maximum, is the number to build budgets against.**

## 12. `@图片N` is Ark's native prompt syntax

ByteDance's published Seedance 2.5 prompt guide uses an **`@` prefix** for
materials: `@图片N`, `@视频N`, `@音频N`.

The `@` mention system in this repo — built for the direction agent, before any
of this was known — converges with the provider's own syntax. Mentions should
therefore render *into the native form* for Seedance rather than being flattened
to "Image 1", which is the form our measured notes recorded for Seedream.

The guide also gives a sound notation: music `( )`, sound effects `< >`,
dialogue `{ }`, subtitles `【 】`.

## 13. The correction: Ark *requires* mapping text — but not description

Part 1 concluded that identity belongs on the reference channel and the prompt
should carry almost nothing. **For Seedance that is half wrong**, and the
distinction is the most useful thing in this document.

The official guide is explicit: **"素材映射关系必须写进提示词"** — the material
mapping relationship *must* be written into the prompt. Its template:

> "@图片1用于<主体>的<外貌、服装、结构或材质>。"
> — @image1 is used for <subject>'s <appearance, clothing, structure or texture>.

And it requires stating what is **not** to be taken: "不采用图片背景" — do not
adopt the image's background.

So there are two different kinds of text and Part 1 conflated them:

| | Carried by | In the prompt? |
|---|---|---|
| **Identity description** — "late 30s, dark bob, olive jacket" | the plate | no |
| **Role binding** — "@图片1 is Sara's face and wardrobe; ignore its background" | nothing else can | **yes, required** |
| **Drift-prone detail** — "scar through the left eyebrow" | text only | as budget allows |

Role binding is short, mechanical and derivable **from the plate roles an Item
already stores**. It is a materials manifest, not prose — exactly the kind of
thing software should generate and an artist should never type.

That is also the real answer to the prompt-bloat worry: the Item block is a
compact, structured mapping table, and it grows with the *number of materials*
rather than with how much personality anyone wrote down.

## 14. The official prompt formula

> 主体 ＋ 动作或事件 ＋ 场景与环境（可选）＋ 视觉风格（可选）＋ 运镜或切镜（可选）＋ 声音（可选）
>
> subject + action/event + scene/environment + visual style + camera move/cut + sound

And for complex multi-material shots the guide organises the prompt under
section headers — 【素材职责】 (material responsibilities) and 【编排方式】
(arrangement).

Its element-separation advice is the facet model arriving from the other
direction: split **identity, clothing, environment, action, camera and sound**
across *different* materials rather than asking one reference to carry
everything.

**Unverified and important:** the guide is Chinese-language, and SEED prompts
are English. Whether an English "Materials:" block performs as well as
【素材职责】 is a straight A/B and nobody here knows the answer.

## 15. What to probe, in order

The repo has a signed OpenAPI client and a live account, so these are cheap:

1. **Does `CreateAssetGroup` per Item work**, and does a per-character group beat
   the current single shared group? (Groups are free; this is a structural fix.)
2. **Does an English materials-manifest block work as well as the Chinese
   form?** Highest-value prompt question we have.
3. **Does registering plates as `asset://` beat hosted R2 links for Seedance**
   on identity retention — and does it dodge the real-people interception?
4. Retention across 1 / 2 / 4 / 8 plates, against the documented 1–8 sweet spot.
5. Does a three-character prompt hold all three?
6. The liveness flow end to end for one real person, before promising it.

## Sources

### Part 2

- [Digital character library | ModelArk](https://docs.byteplus.com/en/docs/ModelArk/2223965) *(JS-rendered; not retrievable)*
- [Add Real-Human Assets to ModelArk Library](https://docs.byteplus.com/en/docs/ModelArk/2315856) *(JS-rendered; not retrievable)*
- [Private virtual portrait library | ModelArk](https://docs.byteplus.com/en/docs/ModelArk/2333565) *(JS-rendered)*
- [Terms of Use for Asset Library | ModelArk](https://docs.byteplus.com/en/docs/ModelArk/2275639)
- [Seedance 2.0 私域素材库（虚拟人像 / 真人人脸）— APIYI](https://docs.apiyi.com/api-capabilities/seedance2/asset-library) *(third-party gateway — concepts corroborated, contracts not)*
- [字节官方 Seedance 2.5 提示词指南 (mirror)](https://www.woshipm.com/ai/6439817.html)
- [Seedance 2.5 正式发布：50 个参考素材、原生 4K — SegmentFault](https://segmentfault.com/a/1190000047897908)
- [一镜成片，随心参考｜Seedance 2.5 正式发布 — 知乎](https://zhuanlan.zhihu.com/p/2066557760272070198)

### Part 1

- [Creating with Gen-4 Image References – Runway](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References)
- [Runway Gen-4 References Prompt Guide](https://www.imagine.art/blogs/prompt-guide-runway-gen-4-references)
- [Character Reference – Midjourney](https://docs.midjourney.com/hc/en-us/articles/32162917505293-Character-Reference)
- [Style Reference – Midjourney](https://docs.midjourney.com/hc/en-us/articles/32180011136653-Style-Reference)
- [Moodboards – Midjourney](https://docs.midjourney.com/hc/en-us/articles/39193335040013-Moodboards)
- [Kling Element Library User Guide](https://kling.ai/quickstart/klingai-element-library-3-user-guide)
- [Kling AI Video Character Consistency](https://app.klingai.com/global/quickstart/ai-video-character-consistency)
- [S2V-01: Subject Reference of Hailuo – MiniMax](https://www.minimax.io/news/s2v-01-release)
- [Subject-Reference to Video Generation Task – MiniMax API Docs](https://platform.minimax.io/docs/api-reference/video-generation-s2v)
- [Vidu Reference to Video 2.0](https://wavespeed.ai/models/vidu/reference-to-video-2.0)
- [Magnific Image Style Transfer – API reference](https://docs.magnific.com/api-reference/image-style-transfer/image-styletransfer)
- [IP-Adapter (decoupled cross-attention)](https://medium.com/@wangdk93/ipadapter-2036c535ba35)
- [InstantID: Zero-shot Identity-Preserving Generation in Seconds (arXiv 2401.07519)](https://arxiv.org/pdf/2401.07519)
- [PuLID: Pure and Lightning ID Customization via Contrastive Alignment](https://huggingface.co/papers/2404.16022)
- [DetailMaster: Can Your Text-to-Image Model Handle Long Prompts? (arXiv 2505.16915)](https://arxiv.org/pdf/2505.16915)
- [Seedream 4.0: Toward Next-generation Multimodal Image Generation (arXiv 2509.20427)](https://arxiv.org/abs/2509.20427)
- [Attention dilution](https://github.com/yiheinchai/attention-dilution)

---

# Part 3 — English beats Chinese for the manifest — MEASURED (2026-08-17)

§15 question 2 is answered. `scripts/probe-manifest-language.ts`, on
`seedream-4-0-250828`: one generated reference plate, then four shots × two
manifest languages, paired on the same plate, the same shot text and the same
seed, so the language of the materials block is the only variable. Nine real
generations — unlike the parameter probes this one costs money, because quality
cannot be read off a validation error.

**Verdict: keep the English manifest. It is the default already, and it is
right.**

| | English (`Materials:` / `Image 1`) | Chinese (`【素材职责】` / `@图片1`) |
|---|---|---|
| Identity retention | held | held |
| Shot adherence | **followed** | **under-shot, repeatedly** |

Identity was indistinguishable: the bob, the eyebrow scar and the olive field
jacket survived in every one of the eight images. That part of the design works
in both languages, which is itself worth knowing.

Shot adherence did not. Asked for a *close-up, laughing*, English gave a true
close-up with an open laugh and the tungsten lamp in frame; Chinese returned
what was essentially the plate's framing with a lamp added and a polite smile.
Asked for a *wide shot walking away*, English gave a full figure down the alley;
Chinese gave head-and-shoulders. In both pairs the Chinese version stayed nearer
the reference and further from the direction.

The reading that fits: a Chinese block inside an otherwise-English prompt does
not read as instructions in the same register as the direction around it. It
anchors harder to the reference and competes with the sentence that says what
is supposed to happen — which is the attention-budget problem in Part 1 arriving
from an unexpected direction. Ark's guide is written for prompts that are
Chinese throughout; ours are not, and the guide's form does not transplant.

**A methodological warning, because this nearly went the other way.** The
script's colour-distance-to-plate proxy was *lower* for Chinese in all four
shots — 27 against 67 in the starkest pair — and read as a clean win. It is the
opposite. Distance to the plate mostly measures how little the image moved, so
a low number means the shot direction was ignored. The metric is now documented
as inverted for this purpose. Reporting those numbers without opening the images
would have produced a confident, backwards recommendation, and would have
flipped a correct default.

One false finding was also caught by checking the control. The Chinese run put
Chinese-script neon in the alley, which looked like the manifest language
leaking into the set — until the English image showed the same signage. It is
the character's ethnicity plus "neon alley", not the manifest.

Two questions this does not answer: it was run on **Seedream**, where
`requiresBindingText` is false, so it measures prompt language rather than the
manifest's necessity; and Seedance, which actually requires the mapping, is
untested here because each clip is minutes rather than seconds. If the same
effect holds there it matters more, not less.

Remaining open from §15: 1 (asset groups), 3 (`asset://` vs links), 4 (plate
count), 6 (multi-character), 7 (style leakage), 8 (liveness). Question 5 is now
partly answered by Part 2's measurement that Ark exposes no influence dial at
all.
