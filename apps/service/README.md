# Local Service

Node/TypeScript localhost backend: assets, generations, jobs, providers,
credentials, SQLite, storage.

## Run

```bash
npm install
npm run dev          # tsx watch, from the repo root
```

Configuration comes from `.env` (see `.env.example`) or the environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SEED_AE_HOST` | `127.0.0.1` | Bind address — loopback only by default |
| `SEED_AE_PORT` | `47831` | Port |
| `SEED_AE_SESSION_TOKEN` | generated per process | Bearer token the panel must send |
| `SEED_AE_WORKSPACE` | `process.cwd()` | Folder that will contain `.seed-ae/` |
| `SEED_AE_POLL_INTERVAL_MS` | `1000` | How often a running job polls its provider |
| `SEED_AE_MOCK_LATENCY_MS` | `1500` | Simulated latency for the mock image provider |
| `SEED_AE_MOCK_VIDEO_FIXTURE` | — | Video file the mock video provider replays |
| `ARK_API_KEY` | — | Ark **inference** key (Bearer). Enables Seedream with `SEEDREAM_MODEL_ID` |
| `SEEDREAM_MODEL_ID` | — | Seedream model id — never hard-coded |
| `ARK_BASE_URL` | SEA route | Inference base URL |
| `SEED_ARK_AK` / `SEED_ARK_SK` | — | Account key pair for the **asset library** (signed OpenAPI) |
| `ARK_OPENAPI_HOST` | `open.byteplusapi.com` | Asset library host |
| `ARK_REGION` | `ap-southeast-1` | Signing region |
| `ARK_ASSET_GROUP` | `seed-ae` | Asset group to register into |
| `ARK_REFERENCE_POLICY` | `asset-or-inline` | `asset` \| `asset-or-inline` \| `inline` |
| `ARK_SKIP_MODERATION` | `false` | Bypass the CreateAsset content pre-filter |

Ark uses **two** credential systems and they are not interchangeable:
`ARK_API_KEY` bearer-authenticates image generation, while `SEED_ARK_AK`/`_SK`
HMAC-sign the asset library. Generation needs the API key; the asset library is
optional and only enables the `asset://` reference route.

If no token is configured, the service prints a random one at startup. Set
`SEED_AE_SESSION_TOKEN` in `.env` to keep it stable across restarts.

## Workspace layout

```
<workspace>/.seed-ae/
  seed-ae.sqlite
  assets/{originals,generated,proxies,thumbnails}/
  manifests/
```

## API

Every route except `GET /health` requires `Authorization: Bearer <token>`.
Responses carry an `x-seed-correlation-id` header matching the request's log
entries. Errors are `{"error": {"code", "message", "details?"}}` with `code`
drawn from the normalized `ErrorCode` set in `@seed-ae/domain`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, version, schema version. No auth. |
| GET | `/v1/ae/context` | Active comp/playhead context from the host adapter |
| POST | `/v1/ae/capture-frame` | Render the current frame, register it as an asset |
| POST | `/v1/ae/import` | Import an asset into the project, optionally at the playhead |
| POST | `/v1/assets` | Register existing media already inside the workspace |
| GET | `/v1/assets` | List assets (`limit`, `offset`, `kind`), newest first |
| GET | `/v1/assets/:id` | One asset with full provenance |
| GET | `/v1/assets/:id/file` | Asset bytes (`?variant=thumbnail` for the thumb) |
| GET | `/v1/assets/:id/lineage` | Ancestors and descendants as a graph |
| GET | `/v1/assets/:id/recipe` | The recipe that made it, ready to re-run as a branch |
| GET | `/v1/providers` | Registered providers and their capabilities |
| POST | `/v1/generations` | Start a generation. Returns `202` with a job. |
| GET | `/v1/generations` | Recent generations |
| GET | `/v1/generations/:id` | One generation with its inputs and outputs |
| GET | `/v1/jobs` | Recent jobs |
| GET | `/v1/jobs/:id` | Job status, its generation, and any output assets |
| POST | `/v1/jobs/:id/cancel` | Cancel an in-flight job |

### Example

```bash
TOKEN=... # printed at startup or set in .env
curl http://127.0.0.1:47831/health

curl -X POST http://127.0.0.1:47831/v1/ae/capture-frame \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"format":"png"}'
```

## Generation lifecycle

`POST /v1/generations` persists a job and its recipe, then returns `202`
immediately — the HTTP request never waits on a provider, even a synchronous
one. The background task materializes inputs, submits, polls, downloads,
registers the output as an asset with a thumbnail, and completes the generation
record. The panel polls `GET /v1/jobs/:id`.

Providers are registered only when usable: the mock image provider always,
Seedream when `ARK_API_KEY` and `SEEDREAM_MODEL_ID` are both set, the mock video
provider when a fixture is configured. Seedance is never registered — its API
contract is unverified, so it reports no capabilities and refuses to run.

## AE host adapter

The service talks to After Effects only through `AeHostAdapter`
(`@seed-ae/ae-host`). Today it runs `MockAeHostAdapter`, which renders a real
1920×1080 PNG so the whole loop is exercisable with no Adobe application
installed. Selecting a production adapter is blocked on verifying the current
official AE extension route — see `docs/research/ADOBE_INTEGRATION_NOTES.md`.
