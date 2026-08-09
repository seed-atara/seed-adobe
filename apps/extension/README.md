# After Effects extension (CEP)

The dockable SEED / AE panel inside After Effects.

## Install

```powershell
pwsh -ExecutionPolicy Bypass -File scripts/install-extension.ps1
```

That builds the panel, enables `PlayerDebugMode` (this bundle is unsigned), and
copies the extension to `%APPDATA%\Adobe\CEP\extensions\ai.seedstudios.seedae`.

Then:

1. `npm run dev` — starts the local service and prints a session token.
2. Restart After Effects.
3. **Window → Extensions → SEED / AE**
4. Paste the session token.

`npm run uninstall:extension` removes it.

## Why CEP

UXP is not available for After Effects, and CEP 12 shipped with AE 25.0 as the
last major CEP version. See `docs/research/ADOBE_INTEGRATION_NOTES.md`. CEP is
maintenance-only, which is exactly why AE access is isolated behind one file.

## How it fits together

```
After Effects
  └── CEP panel  (apps/panel, built into ./panel)
        │  evalScript
        ├── jsx/seed-host.jsx        <- the ONLY code touching AE objects
        │  authenticated loopback HTTP
        └── SEED service (apps/service) -> providers, assets, lineage
```

In CEP the **panel** is the process with AE scripting access, not the service.
So the panel renders frames and imports media itself, then tells the service
about the result:

| Panel action | ExtendScript | Service |
| --- | --- | --- |
| Capture frame | `seedCaptureFrame(dir, name)` | `GET /v1/workspace`, then `POST /v1/ae/register-capture` |
| Import | `seedImport(path)` | `GET /v1/assets/:id/path` |
| Insert at playhead | `seedInsertAtPlayhead(itemId)` | — |
| Context readout | `seedGetContext()` | — |

The service stays host-agnostic and keeps `MockAeHostAdapter`, so every feature
remains testable with no Adobe application installed. The panel picks its route
at startup: `window.__adobe_cep__` present means drive AE directly, absent means
use the service's mock host.

## Host script notes

`jsx/seed-host.jsx` is ExtendScript (ES3) — no `JSON`, no `const`, no arrow
functions. Every function returns a JSON string via a hand-rolled serialiser,
in an `{ok, result}` / `{ok, error}` envelope, so the panel never parses
ExtendScript values.

Behaviour worth knowing:

- Capture uses `CompItem.saveFrameToPng`, which does not touch the render
  queue, so it neither disturbs the user's queue nor needs an output template.
- Captures never overwrite: the filename counter probes for a free name.
- Imported media lands in a `SEED` project folder.
- Insertion is wrapped in an undo group, so one Ctrl+Z removes the layer.

## Development

Iterating on the UI is faster in a browser — `cd apps/panel && npm run dev`
gives hot reload against the same service, with the mock AE host standing in.
Rebuild into the extension with:

```bash
npm run build --workspace @seed-ae/extension
```

### Reloading after a change

Rebuild and reinstall, then **reload the panel** — Ctrl+R in the DevTools at
http://localhost:8088, or close and reopen it from the Extensions menu.

```bash
npm run install:extension
```

One reload is enough for both the UI *and* the ExtendScript host. The
manifest's `ScriptPath` is evaluated once when the extension loads, so a page
reload would otherwise leave After Effects running the old `seed-host.jsx` and
make a host fix look like it did nothing. The panel therefore re-evaluates the
host itself on boot via `$.evalFile`, so restarting AE is not needed.

Restart After Effects only if the manifest changed.

## Debugging inside After Effects

`.debug` opens a CEF remote debugging port. With the panel loaded in AE, open
**http://localhost:8088** in Chrome for real DevTools — console, network,
elements.

This is the tool for the common failures:

| Symptom | Look for |
| --- | --- |
| Panel is blank | Console errors; usually a bad `MainPath` or a missing build |
| Not in the Extensions menu | PlayerDebugMode not set, or the folder is not in `%APPDATA%\Adobe\CEP\extensions` |
| "Cannot reach the SEED service" | The service is not running, or is on a different port |
| Capture does nothing | Console — ExtendScript errors come back as `{ok:false,error}` |
| `EvalScript error.` | `seed-host.jsx` failed to parse; check the console for the line |
