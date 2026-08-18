# Model API Research Notes

Research snapshot: 2026-08-08.

## Confirmed: Seedream via Volcengine Ark

Volcengine developer documentation shows Seedream image calls using:

`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`

Authentication:
`Authorization: Bearer $ARK_API_KEY`

Examples show:
- text-to-image
- image-to-image with an `image` URL
- multiple image references via an `image` array
- `size`
- `sequential_image_generation`
- `stream`
- `response_format`
- `watermark`

Do not freeze the example model ID into product code. Model ID belongs in configuration.

Sources:
- https://developer.volcengine.com/articles/7553203404664176650
- https://www.volcengine.com/

## Confirmed: Volcengine currently advertises a Doubao video generation model 2.0

The Volcengine product page surfaced on 2026-08-08 lists "Doubao video generation model 2.0" among current models.

Source:
- https://www.volcengine.com/

## Seedance 2.5 — contract confirmed against the live API (2026-08-09)

Product objective: Seedance 2.5 as the hero video model for the ByteDance
demonstration.

The contract below was **not** guessed and **not** taken from third parties. It
was read off the live Ark API on an account that already has 473 tasks,
50 of them `dreamina-seedance-2-5-260628`, by:

1. listing real completed tasks (`GET`), and
2. sending deliberately invalid requests and reading the validation errors,
   which name the accepted fields and values.

### Endpoints

| Purpose | Call |
| --- | --- |
| Create | `POST {ARK_BASE_URL}/contents/generations/tasks` |
| Poll one | `GET {ARK_BASE_URL}/contents/generations/tasks/{id}` |
| List | `GET {ARK_BASE_URL}/contents/generations/tasks?page_size=N` |
| Delete | `DELETE {ARK_BASE_URL}/contents/generations/tasks/{id}` |

Auth is the same Bearer `ARK_API_KEY` as image generation. Unlike Seedream,
video **is** asynchronous: create returns `{"id": "cgt-..."}` and you poll.

### Request

Required: `model` and `content`. `content` is an array of typed parts, and the
API states the accepted types outright:

> `content[0].type` … supported values are: `text`, `image_url`, `audio_url`,
> `video_url`

- `{"type": "text", "text": "..."}`
- `{"type": "image_url", "image_url": {"url": "..."}}` — an **object**; a bare
  string is rejected with ``The parameter `content.image_url` … is not valid``

The API infers the mode from the parts and says so in errors: with only text it
reports `... for model dreamina-seedance-2-5 in t2v`, with an image part
`... in i2v`.

Optional parameters, all observed on real completed tasks: `seed`,
`resolution` (e.g. `720p`), `ratio` (e.g. `16:9`), `duration` (e.g. `30`),
`framespersecond` (e.g. `24`), `generate_audio`, `output_format` (`mp4`),
`draft`, `service_tier`, `priority`, `execution_expires_after`.

`resolution`, `ratio` and `duration` are validated **per model and per mode** —
the error is `the parameter X specified in the request is not valid for model
dreamina-seedance-2-5 in t2v`, without listing the accepted set. Treat them as
configuration and surface the API's rejection rather than hard-coding a list.

### Response (verified, succeeded task)

```json
{
  "id": "cgt-20260809211822-9lklw",
  "model": "dreamina-seedance-2-5-260628",
  "status": "succeeded",
  "content": { "video_url": "https://ark-acg-ap-southeast-1.tos-...mp4?X-Tos-Expires=86400..." },
  "usage": { "completion_tokens": 1296900, "total_tokens": 1296900 },
  "created_at": 1786281507, "updated_at": 1786282564,
  "seed": 99588, "resolution": "720p", "ratio": "16:9",
  "duration": 30, "framespersecond": 24,
  "generate_audio": true, "output_format": "mp4"
}
```

Observed statuses: `running`, `succeeded`, `failed`. Timestamps are unix
seconds. `content.video_url` is a **signed TOS URL with
`X-Tos-Expires=86400`** — 24 hours — so download on completion rather than
storing the link. A 30s 720p generation billed 1,296,900 completion tokens.

### Traps

- **`framespersecond` is not validated.** A nonsense value such as `999` is
  accepted and **creates a real, billable task**. Probing this endpoint with
  "obviously invalid" values is unsafe unless the invalid field is one that is
  actually checked (`resolution`, `ratio`, `duration` and `output_format` all
  reject cleanly).
- **A running task cannot be stopped.** `DELETE` returns
  `InvalidAction.RunningTaskDeletion`, and there is no cancel route — POSTing
  to `/cancel` or `/stop` falls through to the *creation* handler and asks for
  `model`, so retrying there can create yet another task.
- Poll with `GET`; nothing else is safe to retry blindly.

### Accepted values (probed 2026-08-09, `dreamina-seedance-2-5-260628`, i2v)

Each probe carried `output_format: "bogus"` — a field the API does validate —
so a candidate that passed still failed overall and no task was created.

| Parameter | Accepted | Rejected |
| --- | --- | --- |
| `duration` | 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 30 | 3 |
| `resolution` | `480p`, `720p` | `1080p`, `2k`, `4k` |
| `ratio` | `16:9`, `9:16`, `1:1`, `4:3`, `21:9`, `adaptive` | — but see below |

**`ratio` must not be sent for image-to-video.** A real i2v request with one is
rejected: *"For first-frame or first-last-frame generation, the output ratio
follows the first-frame image."* Text-to-video may choose one. The parameter
probe above shows ratios as accepted because validation order differs when the
request is otherwise invalid — which is a good reminder that probe results are
weaker evidence than a real call.

A 4s 480p image-to-video run took about 4 minutes and returned a 2.3MB mp4.

### Still to confirm

- Whether `video_url` and `audio_url` parts serve reference video / audio, and
  whether `asset://` URIs work here as they do for images.
- Last-frame semantics (the error message implies first-last-frame generation
  exists, but not how to express it).
- Accepted values for text-to-video, which may differ from i2v.

## Ark credential types: API key vs AK/SK — RESOLVED (2026-08-09)

There are **two separate auth systems and both are needed**. They are not
alternatives to each other.

| | Inference (generate the image) | Asset library (register a reference) |
| --- | --- | --- |
| Endpoint | `{ARK_BASE_URL}/images/generations` | `https://open.byteplusapi.com/?Action=…&Version=2024-01-01` |
| Auth | `Authorization: Bearer <ARK_API_KEY>` | HMAC-SHA256 signing with account AK/SK |
| Credential | one API key string | access key + secret key pair |
| Console page | Ark → API Keys | Account → Access Keys |

An AK/SK pair therefore **cannot** authenticate image generation, and an API key
cannot sign asset-library calls.

### Signing (verified working against the live API)

A SigV4 variant, with three differences that break naive ports:

- timestamp header is `X-Date` (not `X-Amz-Date`)
- body hash header is `X-Content-Sha256`
- the credential scope terminator is the literal `request` (not `aws4_request`)

Signing key derivation: `kDate → kRegion → kService → kSigning("request")`.
Region `ap-southeast-1`, service `ark`, version `2024-01-01`.

Verified 2026-08-09 with `ListAssetGroups` against `open.byteplusapi.com`:
authenticated successfully with the **secret used exactly as issued** — no
base64 decoding, despite the key looking base64-shaped. If a 404 with no error
body comes back, the host is wrong; try `open.ap-southeast-1.byteplusapi.com`.

### Why use the asset library at all

- Inline `data:` URL references work for generic imagery, but requests carrying
  **recognisable real people are intercepted on the inline path**. The asset
  library is the sanctioned route, covered by the authorization letter signed in
  the console.
- Assets are reusable: register once, reference forever as `asset://<Asset_Id>`
  — **true for video only.** See "What a reference may actually be" below;
  images/generations rejects an asset id in every form. This line was believed
  for four days on the strength of being written down, which is why the section
  below carries a date and a table.
- Registration is free; generation is paid. Pre-registering turns use-time into
  a cache hit.

`CreateAsset` **fetches the bytes from a URL you provide** and rejects `data:`
URLs, so a local AE render must be reachable over https at request time — a
short-lived presigned link is the intended shape. Status goes
`Processing → Active | Failed`; poll roughly every 4s.

Dedupe by naming each asset `<name>_<sha16>` (first 16 hex of the file's
SHA-256); `ListAssets` supports fuzzy `Name` search, so any machine can find an
existing registration without a shared database. Verified live: a lookup by a
known hash returned the matching Active asset, and an unknown hash returned
zero rows.

**In prompts, refer to inputs by position — "Image 1", "the second reference".
The model does not resolve asset ids in prose.**

### Discovering model ids and keys (verified 2026-08-09)

`ListFoundationModels` (AK/SK signed, `PageSize` max 100 — 200 is rejected)
returns each model's `Name` and `PrimaryVersion`. The id the API expects is
`<Name>-<PrimaryVersion>`; the console shows only the friendly `DisplayName`.
`scripts/ark-models.ts` does this lookup.

Confirmed available on this account: `seedream-4-0-250828`,
`seedream-4-5-251128`, `seedream-5-0-260128`, `dola-seedream-5-0-pro-260628`,
`seedream-3-0-t2i-250415`, plus `seededit-3-0-i2i-250628` (withdrawn) — and
**`dreamina-seedance-2-5-260628`**, the real Seedance 2.5 model id. Its
*request contract* is still unverified, so the adapter stays inert.

**`ListApiKeys` returns key values MASKED** (asterisks in the middle), so an
existing inference key cannot be recovered through the API — Ark reveals a key
once, at creation. `GetApiKey` takes `DurationSeconds`, `ResourceType` and
`ResourceIds`, which suggests it mints a short-lived key; untested. Getting an
`ARK_API_KEY` therefore means the console, or deliberately minting one.

## Seedream models and their real constraints

Minimum output area is a hard constraint, not guidance — `1024x1024` is rejected
outright by the 3.7MP models.

| Model id | Minimum area |
| --- | --- |
| `dola-seedream-5-0-pro-260628` | 921,600 px |
| `seedream-5-0-260128` | 3,686,400 px |
| `seedream-4-5-251128` | 3,686,400 px |
| `seedream-4-0-250828` | 921,600 px |
| `seededit-3-0-i2i-250628` | **withdrawn by the vendor — 404s.** Use a Seedream model with an `image` input for edits. |

`size` takes a keyword (`"2K"`, `"4K"`) or explicit `"WIDTHxHEIGHT"`. Aspect
ratio must be within 1:16 and 16:1. Up to 14 reference images; with multi-image
generation, references + generated ≤ 15.

Image generation is **synchronous** — there is no task polling (that is the
video API). `seed` **is** supported. Returned image URLs are temporary, so
download promptly rather than storing the URL.

Observed on a real call (2026-08-09, `seedream-4-0-250828`, `size: "2K"`,
one reference, `response_format: "url"`):

- the result is **JPEG**, and nothing in the response says so — no format
  field, and the payload shape is identical whatever it returns. Sniff the
  downloaded bytes; do not assume PNG.
- `"2K"` resolved to **2848x1600** for a 16:9 reference.
- end-to-end wall time was ~19s including the download.

### Errors worth recognising

| Error | Meaning |
| --- | --- |
| `ModelNotOpen` | Model not activated for the account; some also need a resource package. |
| `InvalidParameter.DownloadFailed` | `CreateAsset` could not fetch the URL — expired presigned link? |
| `InvalidParameter.FormatUnsupported` | Wrong `AssetType` or unsupported container. |
| `InvalidParameter.FpsTooLow` | Video assets only: 23.8–60 fps. |
| `size … must be at least N pixels` | Below the model's minimum area. |
| `ListAssetGroups` 400 | The required `Filter` was omitted. |
| HTTP 404, no body | Wrong OpenAPI host. |

Source: implementation guide from a sibling project, verified there against the
live BytePlus ModelArk API (global / South-East Asia route); the signing and
asset-library claims re-verified here on 2026-08-09.

## Input materialization concern

Seedream examples use externally addressable image URLs. A frame rendered locally from AE therefore may require:
- upload to Volcengine object storage,
- provider-supported base64/file form if officially documented,
- or a temporary signed upload service.

This must be abstracted via an `InputMaterializer`.

## Research discipline

When updating:
1. Prefer ByteDance/Seed/Volcengine official docs.
2. Add retrieval date.
3. Separate confirmed API behavior from model marketing.
4. Capture endpoint, auth, sync/async semantics, limits, accepted media, and output lifecycle.

## Seedance 2.5 — how images reach the model (verified 2026-08-11)

Established by probing the live API with `dreamina-seedance-2-5-260628`. Every
probe carried `duration: 3`, which this model rejects, so validation always
failed and no billable task was created; the complaint that came back is the
evidence. The script is `scripts/seedance-references.ts`.

**Each image part needs a `role` once a request carries more than one.** A
roleless pair is refused:

> The parameter `content` specified in the request is not valid: role must be
> specified for image contents.

**Three roles are accepted**, and only these — `reference`, `subject`, `image`,
`start_frame` and `end_frame` all come back as "invalid role specified for
image content":

| `role` | Count | Mode the API reports |
|---|---|---|
| `first_frame` | at most 1 | `i2v` |
| `last_frame` | at most 1 | — |
| `reference_image` | many | `r2v` |

Exceeding a count is named exactly: "expected at most one first frame image
content but got 2 instead."

**The two modes are mutually exclusive.** Mixing them is refused:

> first/last frame content cannot be mixed with reference media content.

So a request either anchors on frames (`first_frame`, optionally with
`last_frame`) or draws on references (`reference_image` × n) — never both. The
adapter chooses: a single image becomes `first_frame`, so a captured plate
animates from itself; several become `reference_image`.

**No reference count was refused.** 30 passed, and so did 64 — validation does
not appear to cap it. ByteDance's launch material says 30. Since only a handful
have actually been *generated* with, the offered maximum is configuration
(`SEEDANCE_MAX_REFERENCES`, default 30) rather than a constant.

**Ratio follows the same split.** A first frame dictates the output ratio and
sending one is refused ("the output ratio follows the first-frame image");
reference-driven requests have no such anchor and do accept `ratio`.

Still unverified: whether generation quality holds at high reference counts,
and what `video_url` / `audio_url` parts do.

### Resolutions across the Seedance family (measured 2026-08-11)

**The probe has to be repeated to mean anything.** When two parameters are
invalid the API names only one of them, and which one varies between identical
requests: a nonsense resolution (`banana`) came back as a *duration* complaint
3 times in 10. A single probe therefore cannot tell an accepted resolution from
an unread one — which is why an earlier pass here reported nonsense.

Asking repeatedly does work. A resolution the model refuses is named sooner or
later; one never named across eight tries is accepted. With a ~30% naming rate,
eight silent tries put a false accept near 1 in 15,000.

| model | accepted | refused |
|---|---|---|
| `dreamina-seedance-2-5-260628` | 480p, 720p, 1080p | 1440p, 2160p, 2k, 2K, 4k, 4K |
| `dreamina-seedance-2-0-260128` | 480p, 720p, 1080p, 4k, 4K | 1440p, 2160p, 2k, 2K |
| `dreamina-seedance-2-0-fast-260128` | 480p, 720p | everything above |
| `dreamina-seedance-2-0-mini-260615` | 480p, 720p | everything above |

So **2.0 reaches 4K where 2.5 stops at 1080p**, and the fast and mini variants
stop at 720p. No model accepts a 2K tier, in either spelling, while 4K is
accepted in both — so the tiers are not a simple ladder and cannot be guessed.

The probe is `scripts/seedance-resolutions.ts`; raise ATTEMPTS to tighten it.
Still unmeasured: whether duration ranges differ per model, which cannot be
probed this way without a request valid in every other respect — and that
creates a billable task.

### Reference media is images, video and audio together (verified 2026-08-11)

Reference mode is not images-only. Each kind has its own content part and its
own role, and the API names the mismatch precisely — "reference media mode
requires video role to be reference_video".

| part | role | count |
|---|---|---|
| `image_url` | `reference_image` | many |
| `video_url` | `reference_video` | many (12 accepted) |
| `audio_url` | `reference_audio` | at least one |

They mix freely in one request: a video alongside several stills is accepted.
That is what makes "the camera move from this plate, these characters, that
location" a single request rather than a compromise.

Frames remain exclusive of all of it — a `first_frame` beside a
`reference_video` is refused with the same message as before: "first/last frame
content cannot be mixed with reference media content."

Unverified: whether a referenced video's motion is actually followed, and what
happens to its audio. The shape is accepted; the behaviour has not been run.

### Audio generation

`generate_audio` is a documented body field and SEED has always sent it. It is
now a per-request switch, defaulting to off at every layer — request, provider
config, and the panel checkbox. Sound is baked into the returned clip, so it
is not a thing to leave on by accident.

## Why a generated frame does not match its plate (2026-08-11)

**The returned MP4 carries no colour signalling at all** — not in the container,
and not in the bitstream either. Measured with `scripts/inspect-video-color.ts`,
which parses the H.264 SPS as well as the MP4 boxes, because a file can be
silent in one and explicit in the other and decoders read the bitstream:

```
seedance-2-0_5c9dd95c_00.mp4   container: no colr box
                               bitstream: profile 100, level 3.1, 4:2:0 8-bit
                                          no video_signal_type — range and
                                          colour both unstated
```

Identical across three clips. ByteDance publishes no specification for any of
it; the only stated fact is H.264 at 24fps.

So **the answer to "what colour space does Seedance return" is: it does not
say.** Which means every consumer assumes, and for 8-bit HD H.264 they all
assume the same thing — BT.709 primaries and transfer, limited range 16–235.

The original observation, kept because it is the shorter version:

```
seedance-2-0_15ba53a5_00.mp4  — no colr box
seedance-2-0_407ac357_00.mp4  — no colr box
```

An untagged H.264 file is guessed at, and every editor guesses the same way:
**BT.709, limited range** for HD. The frame that went in was a full-range sRGB
PNG. So even a model that reproduced the first frame exactly would come back
looking different, because the two ends disagree about what the numbers mean:

- **Range** — 0–255 against 16–235. Reading full-range samples as limited
  raises the blacks and lifts contrast.
- **Transfer** — sRGB against BT.709. Similar curves, different toes; the
  difference lives in the midtones, which is exactly where a corrective Curves
  ends up working.
- **Chroma** — 4:2:0 halves the colour resolution. This part is not
  correctable, and is why *pixel* perfection is not available through an H.264
  delivery however well the rest is handled.

`scripts/compare-frames.ts` measures which of these is in play for a given
pair, comparing per-channel percentiles so two frames that differ slightly in
content can still be compared. It was validated against a synthetic pair with a
known limited-range shift: distance 0.23 for the right conversion against 12.57
for none.

### First and last frames

Verified against the live API by probing (see the roles table above):
`first_frame` and `last_frame` are roles on `image_url` content parts, at most
one of each, and they cannot be mixed with `reference_image`. Third-party
wrappers expose the same thing as `first_frame_url` / `last_frame_url`.

Nothing in any documentation claims the first frame is reproduced exactly — the
wording is consistently that the model "preserves the look and style" of the
input. Treat an exact match as something to correct for, not to expect.

## Video references need a public URL — VERIFIED (2026-08-13)

Seedance accepts a video reference as a `video_url` content part with role
`reference_video`, and the adapter has built that part correctly all along. What
had never been established is whether the URL may be inline. It may not:

```
POST {ARK_BASE_URL}/contents/generations/tasks
content: [ {type:"text",...},
           {type:"video_url", video_url:{url:"data:video/mp4;base64,..."},
            role:"reference_video"} ]

HTTP 400
InvalidParameter: The parameter `content` specified in the request is not
valid: reference_video must be provided as a web url.
```

Probed with a real 1.41MB clip from the library — `scripts/probe-video-reference.ts`
reproduces it. The message is unambiguous and arrives before any generation is
charged.

This is a different rule from images, which are accepted inline as data URLs
and are how every reference works today. So video references are blocked on
exactly the `PublicUrlPublisher` that has been on the roadmap since ADR 0005 —
not on the adapter, the panel, or the materializer, all of which already handle
video.

### What was ruled out

- **Ark's asset library.** `CreateAsset` also fetches from a URL and rejects
  `data:`, so it moves the problem rather than solving it.
- **An Ark-hosted upload.** `POST {base}/files` answers 400 and
  `POST {base}/uploads` answers 200 with an empty body to any payload,
  including `{}` — a catch-all route, not an upload API.

### What actually unblocks it

Somewhere Ark's servers can fetch from over https. Any of:

- an S3-compatible bucket with presigned GETs (R2, S3, B2, MinIO), which is
  the shape `PublicUrlPublisher` was always meant to take;
- a tunnel to the local service (Cloudflare Tunnel, ngrok) for development;
- any static host the workspace can write to.

The lifetime only has to cover the request: Ark fetches the media when the task
is submitted, not while it renders.

### The asset-id route does not avoid it either — VERIFIED (2026-08-13)

Registering the clip as an Ark asset and referencing it by id is the obvious
way around a hosting requirement, and it does not work: `CreateAsset` fetches
from a URL too, so it needs the same thing the reference needed.

Probing the OpenAPI for an upload flow — Volcengine's other media services use
apply/upload/commit — shows the asset library has three operations and no way
to hand it bytes at all. `scripts/probe-ark-actions.ts` reproduces this; the
API distinguishes the two cases clearly, which is what makes the probe
conclusive:

```
CreateAsset      MissingParameter.GroupId          <- exists
ListAssets       MissingParameter.Filter           <- exists
GetAsset         MissingParameter.Id               <- exists
ApplyUploadInfo  InvalidActionOrVersion: Could not find operation
CommitUpload     InvalidActionOrVersion: Could not find operation
GetUploadAuth    InvalidActionOrVersion: Could not find operation
ApplyUpload / UploadAsset / CreateUploadTask /
GetAssetUploadURL / CreateAssetUpload   — all absent
```

### Seedance's own URLs work, but not for long

Every generated clip is served from Volcengine object storage and SEED already
keeps that URL in the generation's raw response:

```
https://ark-acg-ap-southeast-1.tos-ap-southeast-1.volces.com/dreamina-seedance-2-5/...
```

So a clip generated in this session can be referenced without hosting anything.
A clip from yesterday cannot: the same URL answers **HTTP 403** roughly a day
later. `scripts/probe-video-ref-url.ts` checks the newest generation's URL and
reports which case it is in.

That makes it a genuine route with a stated limit rather than a solution:
worth taking when the URL is alive, because it costs nothing, and worth
falling back from when it is not.

## A presigned R2 link is a valid `reference_video` — VERIFIED (2026-08-13)

The hosting question is settled. A private Cloudflare R2 bucket, a SigV4
presigned GET, and Ark fetches it:

```
video_url: https://<account>.r2.cloudflarestorage.com/<bucket>/<key>
           ?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=...
           &X-Amz-Date=...&X-Amz-Expires=3600&X-Amz-SignedHeaders=host
           &X-Amz-Signature=...
```

A query string does not bother it, the URL needs no recognisable extension
semantics beyond the key's own `.mp4`, and one hour of validity is far more
than the fetch needs — Ark reads the file within the first few seconds of the
task. `scripts/probe-r2.ts` verifies the bucket itself (signed PUT, anonymous
presigned GET, unsigned GET refused) and `scripts/probe-video-ref-r2.ts` runs a
real generation through it.

Measured: 1.41MB uploaded in ~430ms; the whole 4s 480p video-to-video job took
about two minutes.

## A video reference makes the task "video editing", and duration must be -1

The first run with a real hosted clip failed after 21 seconds — not on the URL,
which had already been fetched and analysed, but on `duration`:

```
InvalidParameter.TaskTypeConstraint
Seedance identified your task as video editing based on your prompt. For this
task type, the output ratio and duration follow the input video selected by the
model for editing, and the video selected must satisfy the duration requirement
of 4 to 30 seconds. Issues: [0] `duration` must be -1.
```

Three things follow, and none of them are guessable from the reference docs:

1. **The classification comes from the prompt, not the parameters.** The same
   payload with the same clip is a different task type depending on what the
   text asks for.
2. **`-1` is a real value for `duration`**, meaning "follow the input". It is
   not documented anywhere we have found.
3. **The input clip must itself be 4–30s.** A one-second reference is refused
   before anything renders.

Rerunning with `duration: -1` succeeded: 123s, a complete mp4 back. `resolution`
was accepted alongside it — only duration and ratio follow the input.

### What each classification actually allows — five live runs

| prompt reads as | `duration: -1` | `duration: 8` | `ratio: 9:16` | `resolution` |
| --- | --- | --- | --- | --- |
| editing the clip | accepted (123s) | **refused**, TaskTypeConstraint | untested | accepted |
| a new shot | accepted (155s) | accepted (128s) | accepted (128s) | accepted |

So `-1` is safe whichever way the prompt is read, and it is the only thing that
is. A number, and by the same rule a ratio, is accepted exactly when the model
decides the prompt describes a new shot rather than a change to the clip —
which is a decision made from the text, after submission, and cannot be
predicted from the request.

The adapter therefore defaults rather than dictates: no duration stated means
`-1`, a stated one is sent, and the same for `ratio`. Silence follows the clip;
asking is allowed and may be refused. `resolution` is unaffected throughout —
720p alongside a 2663x1498 clip works.

The refusal is worth restating because of when it arrives: the task is
accepted, runs for about twenty seconds, and only then fails. Nothing about the
request is rejected up front, so this is not something a client can validate
its way around.

A sixth run, from the panel rather than a probe, added the ratio half of the
same rule and one more value:

```
The parameters `ratio` and `duration` specified in the request are not valid.
Seedance identified your task as video editing based on your prompt.
Issues: [0] `ratio` must be `adaptive`. [1] `duration` must be -1.
```

So for an editing task `ratio` is not merely unwelcome — it has a required
value, `adaptive`, which is Ark's "take it from the input" in the ratio
vocabulary, exactly as `-1` is in the duration one. Omitting the key entirely
also works, which is what the adapter does.

## What a reference may actually be — VERIFIED (2026-08-13)

Every candidate form, tried against the live endpoints with the same registered
asset and the same file:

| value | images/generations `image` | video tasks `video_url` |
| --- | --- | --- |
| `data:...;base64,...` | accepted | **refused** — "must be provided as a web url" |
| presigned https URL | **accepted** | accepted |
| `asset://<Asset_Id>` | refused — "invalid url specified" | **accepted**, task ran to a finished clip |
| bare `<Asset_Id>` | refused — "invalid url specified" | refused — "invalid url" |

The two endpoints are different services and they do not agree on a single
form. Only an https URL works for both.

`asset://` for video is a genuine route with a property a link does not have:
it is permanent, so a reference used across sessions never depends on a
signature. It costs ten to thirty seconds of registration before the job can
start, against about half a second to publish a link — which is why SEED sends
links and keeps the asset library for when that trade is worth making.

Reproducers: `scripts/probe-image-reference-forms.ts` and
`scripts/probe-asset-id-for-video.ts`.

## Text-to-video, with nothing attached — VERIFIED (2026-08-14)

The mode that had never been run, because every live check so far went through
a frame or a clip. It behaves exactly as the adapter assumed:

```
content: [ {type:"text", text:"a slow push through morning fog..."} ]
duration: 5, ratio: "9:16", resolution: "480p"
```

Accepted, 112s, and the result is 480x854 at 5.056s. So with no reference:

- **`ratio` is honoured.** 480x854 is 0.562 against 9:16's 0.563. Nothing
  anchors the shape here, which is why it may be asked for at all.
- **`duration` is honoured**, to within the frame rate.
- **`resolution` names the short edge.** "480p" on a portrait ratio gives 480
  wide and 854 tall, not 854x480 — worth knowing before assuming a resolution
  keyword means height.

## Audio references: accepted, then refused by a copyright filter — (2026-08-14)

`audio_url` with role `reference_audio` is a real content part. Measured with a
hosted WAV, an inline WAV, and no role at all:

| form | result |
| --- | --- |
| hosted https URL, role `reference_audio` | accepted at submission |
| **inline `data:audio/wav;base64,...`**, same role | accepted at submission |
| hosted, no role | 400 — "reference media mode requires audio role to be reference_audio" |

Note the second row: audio is **not** like video. A data URL is accepted, as it
is for images, so audio references do not depend on hosting.

But neither accepted task rendered. Both failed after 94s and 177s with:

```
The request failed because the output audio may be related to copyright
restrictions.
```

The reference was a synthetic 220Hz sine tone generated by
`scripts/probe-audio-reference.ts` — no music, no recording, nothing anyone
holds a right to. So the filter is not recognising a song; it is refusing the
*output* audio of a request that carried an audio reference at all, and it does
so after the render has been paid for.

Until something is shown to survive that filter, `audioReferences` describes a
part shape rather than a usable feature, and the panel says so where one is
attached.

## A 4:4:4 MOV output may exist — UNVERIFIED, PROBE FIRST (2026-08-17)

Prompted by ByteDance telling us directly that a less-compressed MOV can be
used instead of the compressed MP4. Desk research turned up matching parameter
names, and **none of this has been sent to the API.** It is a probe list, not a
contract — the section above on colour is measured, this one is not.

Reported parameters for Seedance 2.5:

| Parameter | Reported values | Why it matters here |
|---|---|---|
| `output_format` | `mp4` (default, "standard color") / `mov` (`yuv444p` or `yuv444p10le`) | 4:4:4 chroma, and 10-bit in the `10le` variant |
| `bitrate_mode` | `standard` (CRF 18) / `high` (CRF 11, 3–5× the file) | `high` is reported as the 2.5 default |
| `return_last_frame` | `true` returns the final frame as a PNG | a real frame, from the provider, for nothing |
| `camera_fixed` | `true` biases toward a locked-off camera | — |

If `output_format: "mov"` is real it settles something this document currently
records as unfixable. "Why a generated frame does not match its plate" ends on
chroma: *"4:2:0 halves the colour resolution. This part is not correctable, and
is why pixel perfection is not available through an H.264 delivery."* A
`yuv444p` MOV is exactly the correction — no subsampling — and `yuv444p10le`
adds the bit depth that the range and transfer mismatches were eating into.

The advice that came with it is worth as much as the parameter: **use MOV for
both input and output when a clip goes round the loop repeatedly.** That is
precisely reskinning and iterate-in-place, where the same shot is decoded,
re-encoded and re-referenced several times and generation loss compounds
silently.

Reference *input* is reported as MP4 or MOV, H.264 or H.265, 24–60fps,
constant frame rate preferred, 2–15s, with per-file limits already recorded
elsewhere here. Our own render path writes H.264 MP4 out of the host, so the
input half is a change to the capture route, not just a request field.

**One reported value contradicts our own measurement and should be trusted
less than we trust ourselves.** The same source lists `4K` among 2.5's
resolutions; our probe found 2.5 accepting only 480p, 720p and 1080p and
refusing `4k`/`4K`/`2160p` across eight repetitions. Measurement wins. Treat
the whole list as equally likely to contain errors of that kind.

### How to probe it for free

The technique from `scripts/seedance-references.ts` applies directly: send a
`duration` this model rejects, so validation always fails and no billable task
is created, and read what the complaint names. An unknown *field* is usually
ignored silently, so the informative probe is an unknown **value** —
`output_format: "banana"` — which gets named if the field is read at all.

Repeat it. When two parameters are invalid the API names only one, and which
one varies between identical requests; a single silent pass is not evidence.
Eight repetitions put a false accept near 1 in 15,000 at the observed ~30%
naming rate.

Sources (third-party, none official):
[awesome-seedance-2.5-api-prompts](https://github.com/Anil-matcha/awesome-seedance-2.5-api-prompts),
[kie.ai Seedance 2.5](https://kie.ai/seedance-2-5),
[Runware Seedance 2.0](https://runware.ai/docs/models/bytedance-seedance-2-0).

### Measured, and mostly negative — VERIFIED (2026-08-17)

`scripts/probe-output-format.ts`, against `dreamina-seedance-2-5-260628` on
`ark.ap-southeast.bytepluses.com`. Every request carried `duration: 3`, which
this model refuses, so validation always failed and nothing billed. Eight
repetitions per case, plus a second pass in i2v with a first frame attached,
because the API reports parameter validity *per mode* ("not valid for model
… in t2v") and a t2v-only answer would not have settled it.

| Parameter | Verdict |
|---|---|
| `bitrate_mode` | **Real.** `standard` and `high` accepted; `low` and `banana` refused by name |
| `return_last_frame` | **Real.** A string is refused by name, so it is a boolean; `true` passes |
| `output_format` | **Does not exist.** `banana`, `mov` and `mp4` all pass unremarked, in t2v *and* i2v |
| `container`, `video_format`, `format`, `pixel_format` | do not exist either |

**So there is no MOV output, and the section above was wrong to hope for one.**
A field that ignores nonsense is a field nobody is reading; `output_format:
"mov"` would have been silently discarded while the panel claimed 4:4:4. This
is the third time a plausible unverified note nearly became a feature, and the
first time the probe caught it before the code was written.

Which means the chroma finding stands as recorded: 4:2:0 is what Seedance
delivers, and it is still the part that cannot be corrected. What we *can* do
about quality is what the two real parameters offer:

- **`bitrate_mode: "high"`** — CRF 11 against `standard`'s 18, 3–5× the file.
  It does not add chroma resolution, but it stops the encoder throwing away
  detail that survived generation. Cheap, and the file size is irrelevant next
  to what a render costs.
- **`return_last_frame: true`** — a real PNG from the provider. Most of the
  poster problem the panel currently solves by decoding the mp4 itself.

Two lessons about the method, both worth keeping:

**A parameter list from an aggregator is a hypothesis, not a contract.** Of six
reported fields, two were real. The same source's `4K` claim was already known
to be false. Treat every entry as independent and unproven.

**A probe that cannot fail proves nothing.** The first run of this script sent
`SEEDANCE_MODEL_ID` verbatim — a comma-separated list of four models — so every
request died at model resolution with "does not exist or you do not have access
to it", and the regex for `bitrate_mode` matched the word *model* inside that
message. It reported 8/8 confident readings of a field it had never reached.
The script now detects a pre-validation failure explicitly and anchors its
patterns to the parameter names.

### Correction: the field is `file_format`, and it must be empty — VERIFIED (2026-08-17)

The section above concluded there is no container parameter. **That was wrong,
and wrong in an instructive way: it asked about `output_format`, which this API
does not read, and took the silence as an answer.** The real name is
`file_format`, found by sweeping plausible names instead of trusting one.

Swept across **all four configured models** — 2.5, 2.0, 2.0-fast, 2.0-mini —
and **three modes**, t2v, i2v and r2v, with `duration: 3` so nothing billed:

```
the specified parameter file_format is not supported for model
dreamina-seedance-2-5 in r2v, must be empty
```

| Field | Status |
|---|---|
| `file_format` | **real and validated** — and refused on every model in every mode tested, `mp4` as firmly as `mov`. "Must be empty." |
| `bitrate_mode` | real; `standard` / `high`. **Not** read by `2.0-mini`. |
| `return_last_frame` | real, boolean |
| `output_format`, `container`, `video_format`, `codec`, `pix_fmt`, `pixel_format`, `format`, `output_type`, `quality` | not read at all |

**What this changes.** "There is no MOV" becomes "**MOV is a parameter this API
knows about, and no model on this account may send it.**" The wording is
specific — *not supported for model X in mode Y* — so the field plausibly exists
for a model or a mode we do not have. That is a question worth putting to
ByteDance by name: *which model and which mode accept `file_format`, and what
values?* It is a far better question than "can we have MOV output", and it came
out of a probe rather than a doc.

The practical answer is unchanged: we send no `file_format`, and 4:2:0 H.264 is
what arrives. `bitrate_mode: "high"` remains the only quality lever, and it is
on by default.

**One mode is still untested:** video editing, where a `reference_video` is
attached. It needs a real hosted clip, so it cannot be probed with a data URL
the way the others can. If `file_format` is supported anywhere, that is the
likeliest place — it is the mode where a clip is decoded and re-encoded, which
is exactly where a lossless container would earn its keep.

**The method has a ceiling, and ByteDance's reply found it.** Told on
2026-08-18 that `output_format` "accepts mov or mp4", which contradicts our
result that it is never named even for a nonsense value. Both can be true: every
probe here poisons `duration` so validation fails, which establishes what the
*request validator* reads and says nothing about what the executor honours. A
parameter acted on only at execution is invisible to this technique.

So "output_format does not exist" was overstated. What is measured is narrower:
it is not rejected by request validation, while `file_format` is — and is
refused on every model on this account, `mp4` included. The open question is now
a question for ByteDance rather than a finding, and it is written up with the
exact curls in `BYTEDANCE_QUESTION_OUTPUT_FORMAT.md`.

Settling it needs one real, billable generation with `output_format: "mov"` and
an inspection of what comes back. That is the only test that can distinguish
ignored from honoured.

**Method note.** Two probes in a row now would have shipped a confident false
negative. The first asked a field that did not exist; the second asked the right
field but only of one model, in one mode. A negative result is only as wide as
the sweep behind it, and the sweep has to include the name itself.

### One still in both frame slots is its own mode — VERIFIED (2026-08-17)

Probed the free way, `duration: 3` so validation always fails and nothing bills:

| Request | Mode the API reports |
|---|---|
| `first_frame` + `last_frame`, **the same image** | **`flf2v`** — accepted |
| `first_frame` alone | `i2v` |
| two `first_frame` parts | refused: "expected at most one first frame image content but got 2" |

So a seamless loop — the shot ending exactly where it began, which is what a
motion graphic wants — is a first-class thing here rather than a trick. Ark has
a distinct mode name for it, `flf2v`, alongside the `i2v` and `r2v` already
recorded above.

The refusal on two first frames is why SEED models this as a **role** (`loop`)
rather than letting the artist add one reference to the list twice: duplicating
a reference is a request the API rejects, while one still carrying both roles is
one it names.

### `output_format` is real, acted on at execution — VERIFIED BY GENERATING (2026-08-18)

ByteDance answered, and we then generated a clip per cell and ffprobed each one
rather than reading the validator. `scripts/probe-output-quality.ts` — **the one
probe here that bills**, necessarily: `output_format` is never touched by the
request validator, which is exactly why every free probe reported it missing.
That was a limit of the method, not a fact about the API.

Measured on `dreamina-seedance-2-5-260628`, 4s each:

| cell | codec / profile | chroma | colour signalling | our bitrate | theirs |
|---|---|---|---|---|---|
| 1080p mov | HEVC **Rext** | **yuv444p10le** | tv / bt709 / bt709 / bt709 | 12.79 Mb/s | 23.51 |
| 1080p mp4 | HEVC Main 10 | yuv420p10le | tv / bt709 / bt709 / bt709 | 5.64 Mb/s | 17.34 |
| 720p mov | H.264 **High 4:4:4 Predictive** | **yuv444p** | all unset | 7.78 Mb/s | 12.86 |

**Every structural claim confirmed exactly** — codec, profile, chroma, depth and
colour signalling all match what we were told.

**Bitrates came in around half theirs, and that is expected rather than a
discrepancy.** `bitrate_mode` is a quality target (CRF), not a rate, so the bits
follow the content. Our probe prompt is deliberately still — "a slow push in on
a still object, locked off" — so there is little to encode. Treat the published
figures as an example, not a guarantee, and never as a way to predict file size.

**What this changes, and it is large.** Two things this document recorded as
uncorrectable are now both fixable:

- **Chroma.** "4:2:0 halves the colour resolution. This part is not correctable"
  — `output_format: "mov"` has no subsampling at any resolution.
- **Colour signalling.** The long-standing "it does not say" is only true below
  1080p. At 1080p the output is fully tagged.

So the maximum-quality combination is **1080p + mov**: HEVC Rext, 4:4:4, 10-bit,
correctly tagged. The two halves are worth separating in the UI, because they
cost differently: **`mov` is free** and strictly better at any resolution, while
1080p costs a larger render and is the artist's call.

`resolution` selects the codec — 480p/720p are 8-bit H.264, 1080p is 10-bit
HEVC — and `output_format` independently selects chroma. That coupling is not
guessable and is the reason the table above exists.

Still limited range everywhere, including the tagged 1080p output, while what we
send is full-range sRGB. That is the remaining lossy step and it is question one
in `BYTEDANCE_REPLY_FULL_RANGE.md`.

**Ingest already copes**, checked against the real files: `sniffMimeType` returns
`video/quicktime` for the MOV (`ftypqt  `), and `readMp4Size` reads 1920x1080 /
1280x720 and 4.04s out of both containers, since MOV is the same box structure.

**One thing that will break.** Posters are extracted by decoding the clip in
Chromium, which cannot decode H.264 4:4:4 Predictive or HEVC Rext. A `mov`
result will fall back to the "video" badge. `return_last_frame` is measured real
and is the obvious fix.

### Do not stretch the range — measured (2026-08-18)

Asked whether SEED should expand limited range back to full. Measured with
`ffmpeg signalstats` on the clips generated above, rather than reasoning from
the tag:

| clip | luma floor | luma ceiling | legal range |
|---|---|---|---|
| 720p mov, 8-bit | **16** | **235** | 16–235 |
| 1080p mov, 10-bit | 65 | **983** | 64–940 |

The 8-bit clip lands exactly on the legal limits, so the `tv` tag is honest and
the untagged 720p output is nonetheless interpreted correctly by every tool's
default assumption. The data really is limited range; it is not full range
mislabelled.

**The 10-bit clip exceeds the legal ceiling.** 983 against a nominal white of
940 — real superwhite headroom, in the highlights. That single number settles
the question:

- **Stretching 64–940 to 0–1023 would clip everything above 940**, throwing away
  highlight detail that is present in the file.
- Stretching in 8-bit is worse again: 16–235 is 220 levels mapped onto 256, so
  the result is banded by construction — gaps where no code value can land.

So SEED does no range conversion, which was already true (there is none anywhere
in the pipeline) and is now true on purpose. The correct handling is to let the
host expand it **in float**, where limited maps to 0–1 and the superwhite
survives as values above 1.0 rather than being crushed against a ceiling.

**Best quality, in order of how much each is worth:**

1. **1080p + `mov`.** 4:4:4, 10-bit, and correctly tagged so nothing has to
   guess. The tagging matters as much as the chroma — below 1080p nothing is
   signalled and correctness depends on a default that happens to match.
2. **32-bit float in After Effects.** Anything less clips the superwhite at
   import and the 10-bit precision is wasted.
3. **`bitrate_mode: high`**, already the default.
4. Do not add a range conversion. The loss happened at encode; expanding
   afterwards cannot recover it and does add banding.

The remaining lossy step is on the *input* side — full-range sRGB going in,
limited range coming out — and that is a question for ByteDance, not something
correctable here.
