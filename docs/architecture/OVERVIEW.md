# Architecture Overview

## Runtime components

### 1. After Effects host
Owns:
- active project/comp context
- playhead
- current-frame capture
- media import
- timeline insertion/replacement

All AE calls pass through `AeHostAdapter`.

### 2. Panel
Owns:
- Generate UX
- Asset browser
- lineage/history UI
- job state presentation
- recipe reopening

Panel does not own provider credentials.

### 3. Local SEED service
Owns:
- asset registry
- generation records
- jobs
- provider routing
- secrets
- downloads/uploads/input materialization
- SQLite
- thumbnails
- filesystem organization

### 4. Providers
Adapters translate normalized requests to concrete APIs.

## Data flow

```
AE Host ----context/capture----> Panel/Bridge
                                 |
                                 v
                           Local Service
                    +------------+------------+
                    |            |            |
                  Assets        Jobs       Providers
                    |                         |
                 SQLite                  Ark / future
                    |
                 Filesystem
```

## Local project storage proposal

```
<project-root>/
  .seed-ae/
    seed-ae.sqlite
    assets/
      originals/
      generated/
      proxies/
      thumbnails/
    manifests/
```

If the `.aep` project cannot safely determine a project root, use an application data location keyed by a project fingerprint.

## Boundary rule

No Adobe scripting object escapes the host adapter.
No provider-specific object escapes a provider adapter.
