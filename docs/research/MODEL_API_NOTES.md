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
- Assets are reusable: register once, reference forever as `asset://<Asset_Id>`.
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
