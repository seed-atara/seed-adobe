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
