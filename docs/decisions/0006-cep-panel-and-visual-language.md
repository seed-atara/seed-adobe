# ADR 0006 — CEP panel, host split, and the Windows 95 visual language

Status: Accepted (2026-08-09)

## 1. The panel drives After Effects, not the service

In CEP the panel is the process with AE scripting access; the service is a
separate Node process with none. So capture and import happen in the panel,
which then tells the service:

- `GET /v1/workspace` — where to render
- `POST /v1/ae/register-capture` — here is the frame I rendered
- `GET /v1/assets/:id/path` — what should I hand to `importFile`

The service keeps `AeHostAdapter` and `MockAeHostAdapter`, so the whole product
stays runnable and testable with no Adobe application. The panel picks its
route at startup from `window.__adobe_cep__`.

The alternative — an out-of-process bridge letting the service call back into
the panel — buys a tidier diagram and costs a socket protocol, a reconnect
story, and a new failure mode. Not worth it while one panel talks to one
service on loopback.

## 2. No vendored CSInterface.js

The only capability needed is `evalScript`, which `window.__adobe_cep__`
exposes directly. A 20-line wrapper is easier to audit than a third-party
bundle in a process that holds a session token.

## 3. All AE contact in one ExtendScript file

`jsx/seed-host.jsx` is the only code that touches AE objects. It returns
`{ok, result}` / `{ok, error}` JSON envelopes through a hand-rolled serialiser,
because ExtendScript is ES3 and has no `JSON`. When AE eventually moves to UXP,
this file and the manifest are the migration.

## 4. Images are fetched, not `<img src>`-ed

Every asset image is fetched with the session token and shown as an object URL.

An `<img src>` cannot carry an `Authorization` header, so the obvious
implementation silently 401s — which is exactly what shipped and what a browser
test caught. The tempting fix, a `?token=` query parameter, puts a credential
into URLs, logs and history. Fetch-and-blob keeps the token in the header where
it belongs, and object URLs are revoked on unmount.

## 5. Windows 95 as the visual language

Requested by the user, and a better fit than it first sounds for a docked tool
panel:

- **Bevels encode affordance in the pixels.** Raised means press me, sunken
  means data lives here. No hover state required to discover what is
  interactive — which matters in a panel that is often only 320px wide and
  read at a glance beside a timeline.
- **Group boxes carry structure without whitespace.** A 90s dialog packs
  labelled sections into very little room; a modern airy layout would need
  three times the height for the same controls.
- **It survives at any size.** 1px borders and 11px type do not need a
  breakpoint strategy.

Concretely: `#c0c0c0` face, `#008080` desktop, navy-to-blue title gradient,
`MS Sans Serif` with a `Lucida Console` mono for ids and timestamps, buttons
whose bevel inverts and whose label nudges 1px on `:active`, a segmented
progress bar rather than a smooth fill, and message-box styling for notices.

Font smoothing is disabled on purpose — the period look depends on hard pixel
edges, and the stack is system-only because a CEP panel may be launched with no
network and a failed webfont is worse than a considered fallback.
