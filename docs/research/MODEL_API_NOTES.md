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

## Seedance 2.5

Product objective: use Seedance 2.5 as the hero video model for the ByteDance demonstration.

As of this research snapshot, this starter pack does **not** contain a verified official Seedance 2.5 Ark request/response schema. Therefore:
- do not guess endpoints
- do not derive production contracts from third-party examples
- do not alias an older model's payload and call it 2.5
- build a provider skeleton and mock fixture
- update this file with official docs/access once obtained

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
