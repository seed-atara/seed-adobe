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
| POST | `/v1/assets` | Register existing media already inside the workspace |
| GET | `/v1/assets` | List assets (`limit`, `offset`, `kind`), newest first |
| GET | `/v1/assets/:id` | One asset with full provenance |
| GET | `/v1/assets/:id/file` | Asset bytes; marks the asset `missing` if gone |

### Example

```bash
TOKEN=... # printed at startup or set in .env
curl http://127.0.0.1:47831/health

curl -X POST http://127.0.0.1:47831/v1/ae/capture-frame \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" -d '{"format":"png"}'
```

## AE host adapter

The service talks to After Effects only through `AeHostAdapter`
(`@seed-ae/ae-host`). Today it runs `MockAeHostAdapter`, which renders a real
1920×1080 PNG so the whole loop is exercisable with no Adobe application
installed. Selecting a production adapter is blocked on verifying the current
official AE extension route — see `docs/research/ADOBE_INTEGRATION_NOTES.md`.
