# Installing SEED / AE

**Written 2026-08-27.** Everything in the Windows section has been run on
Windows 11 with After Effects and verified. **The macOS section has not been
run end to end by anyone yet** — the code paths are cross-platform and the
installer knows the Mac locations, but no one has opened the panel inside After
Effects on a Mac. If you are the first, the last section tells you what to
write down.

---

## Two ways in

**If you just want to use SEED**, you want the installer — one download, no
terminal, no Node, no keys in a text file. Jump to
[Installing from the installer](#installing-from-the-installer).

**If you are working on SEED**, carry on reading. Everything below is the
from-source path, and it is still how the companion itself gets built.

---

## Installing from the installer

**Download:** <https://github.com/seed-atara/seed-adobe/releases/latest>

Take `SEED Setup <version>.exe` on Windows, the `-arm64` DMG on an Apple
Silicon Mac, or the plain `.dmg` on an Intel one. If you are not sure which Mac
you have:  → About This Mac. An arm64 build on an Intel Mac does not run
slowly, it does not run.

The version in the filename matches the release tag. When it does not, the
release was cut without bumping `apps/installer/package.json` — bump it first,
then tag.

The companion is a small application called **SEED**. It puts the panel where
After Effects looks for it, keeps the service running, and shows a light
saying whether it is up. It does not replace the panel — everything you
actually do, including entering your API keys, happens in the panel inside
After Effects.

### Windows

1. Download **SEED Setup *x.y.z*.exe**.
2. Run it. It is unsigned, so Windows warns once: **More info → Run anyway**.
3. SEED opens and asks one question — whether After Effects may load the
   panel. Say **Allow**; without it the panel will not appear.
4. Start After Effects, then **Window → Extensions → SEED / AE**.

The panel is already connected. There is no token to paste.

### macOS

**Not yet verified by anyone — see the note at the top of this file.**

1. Download **SEED-*x.y.z*-arm64.dmg** (or the x64 build on an Intel Mac).
2. Drag SEED to Applications.
3. Clear the quarantine flag — needed **once per version**, because the build
   is ad-hoc signed but not notarized:

   ```sh
   xattr -dr com.apple.quarantine /Applications/SEED.app
   ```

   Without it macOS blocks the first launch with *"Apple could not verify…"*,
   offering only **Done** and **Move to Bin**. There is no "Open Anyway" in
   that dialog, and Control-click → Open no longer works — Apple removed that
   bypass in Sequoia. The alternative is System Settings → Privacy & Security →
   **Open Anyway**, which only appears after a launch has been blocked.

4. Open SEED, say **Allow**, then start After Effects.

That one terminal command is the only one, and it goes away entirely with an
Apple Developer ID certificate.

### What the SEED window tells you

| Row | What it means |
| --- | --- |
| **SEED is running** | The service answered. The panel can reach it. |
| **Panel installed** | The panel is in Adobe's folder. |
| **After Effects permission** | Whether unsigned extensions are allowed. |

Three buttons cover almost every problem: **Restart the service**, **Reinstall
the panel**, and **Show panel folder**. Closing the window leaves SEED running
in the tray or menu bar; **Quit** stops the service.

### What the installer does not do yet

- **It does not start at login.** You open SEED like any other app, then open
  After Effects.
- **It does not update itself.** New versions are a new download.
- **On macOS it carries no native plugins.** `seed-film-look` and
  `seed-frequency-detailer` are Windows-only C++ builds.

---

## What SEED actually is

Two pieces, and knowing which is which makes every problem below diagnosable:

```
After Effects
  └── SEED / AE panel          a CEP extension: HTML + JS, installed into
      │                        Adobe's own extensions folder
      │  http://127.0.0.1:47831
      ▼
  SEED service                 a Node process you start yourself. Holds the
      │                        credentials; the panel never sees them.
      ▼
  Ark / BytePlus, Anthropic, fal, R2
```

The panel is a **copy**. `npm run install:extension` builds it and copies it
into Adobe's folder — editing the source changes nothing until you run that
again. This catches everyone at least once.

The service must be running for the panel to do anything. There is no
background daemon yet: you start it in a terminal and leave it there.

---

## Before you start — both platforms

| Need | Version | Check |
| --- | --- | --- |
| Node.js | **22.13 or newer** (24 is what this is developed on) | `node -v` |
| npm | ships with Node | `npm -v` |
| Git | any | `git --version` |
| After Effects | 22 or newer | Help → About |

You do **not** need an API key to install. The panel opens, the library works,
and the film-look provider (which reaches no network) generates. You need a key
to reach Seedream or Seedance, and you can add it from inside the panel later —
see [Keys](#keys).

---

## Windows

```powershell
git clone https://github.com/seed-atara/seed-adobe.git
cd seed-adobe
npm install
npm run install:extension
```

The installer prints where it put things and whether the last step is needed.

### Allow the unsigned extension

The bundle is not signed with an Adobe extension certificate, so CEP refuses to
load it until debug mode is on. The installer **reports** this and does not
change it — flipping a machine-wide "allow unsigned code" switch should be your
decision, not a side effect:

```powershell
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

### Start the service

```powershell
npm run dev
```

It prints the address it is listening on and — if you have not set a fixed
token — a **session token** for this process only:

```
SEED session token (this process only): 8f3aK9…
```

Copy it. Leave this terminal open.

### Open the panel

1. Restart After Effects (fully quit, not just close the project).
2. **Window → Extensions → SEED / AE**
3. Paste the session token.

The light in the status bar goes green. Tabs are *generate, items, library,
lineage*.

---

## macOS

Identical, with two platform differences. **Untested end to end — see the note
at the top.**

```sh
git clone https://github.com/seed-atara/seed-adobe.git
cd seed-adobe
npm install
npm run install:extension
```

This installs to `~/Library/Application Support/Adobe/CEP/extensions/ai.seedstudios.seedae`.

### Allow the unsigned extension

macOS keeps the same flag in a preferences domain rather than the registry:

```sh
defaults write com.adobe.CSXS.9 PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
killall cfprefsd
```

`killall cfprefsd` is not optional decoration. The preferences daemon caches
values and will happily keep serving After Effects the old one for minutes,
which looks exactly like the flag not having worked.

Then start the service and open the panel exactly as on Windows.

### What is missing on macOS

Be explicit about this rather than discovering it mid-demo:

- **The two native AE plugins do not exist for macOS.** `seed-film-look` and
  `seed-frequency-detailer` are C++ effects built by `.cmd` scripts against the
  Windows SDK. There is no Xcode project. Everything in the panel works
  without them; the *film look provider* inside the service is separate and
  does run.
- **Nothing else is known to be missing** — and "known" is doing real work in
  that sentence. The host scripts have no Windows-specific paths in them and
  the service is pure JavaScript on a Node runtime that ships for both, so
  there is no *reason* for anything else to fail. That is a prediction, not a
  measurement.

---

## Keys

There are now two places, and this is deliberate.

### From the panel (new, and the easy one)

Click the **gear** in the title bar. Twelve settings, grouped, each with a line
saying what breaks without it. Type a key, press Save — the service rebuilds
its providers immediately, and the dialog tells you what became available. No
restart, no text editor.

They are stored in `~/.seed-ae/credentials.json`, mode 0600, deliberately
**outside** the project folder — a workspace gets zipped and handed to other
people.

A key set here **overrides** `.env`, and every row says which of the two the
current value came from.

### From `.env` (for a machine set up by script)

```sh
npm run setup     # asks for each key, writes a git-ignored .env
```

`.env.example` documents every setting, including the long tail of tuning knobs
the panel deliberately does not offer.

### The minimum to generate anything

| Key | Without it |
| --- | --- |
| `ARK_API_KEY` | No image or video provider is registered at all |
| `SEEDREAM_MODEL_ID` | Ark has a key but no image model to call. Model ids differ per account — `npx tsx --env-file=.env scripts/ark-models.ts` lists yours |

Everything else is optional and its absence hides a button rather than breaking
one.

---

## The dev loop

For working on SEED rather than using it.

```sh
npm run dev          # service, restarts on save (tsx watch)
npm test             # 608 tests, ~10s
npm run typecheck    # service + scripts + panel
```

**Panel changes need a reinstall.** The panel After Effects loads is a copy:

```sh
npm run install:extension
```

then close and reopen the panel from the Window menu. A full After Effects
restart is only needed the first time, or after a manifest change.

To iterate on the panel *without* After Effects at all — much faster, and most
of the UI is testable this way:

```sh
npm run dev --workspace @seed-ae/panel   # Vite dev server, hot reload
```

It runs in a browser against the same service. The AE-specific parts (capture,
import, insert at playhead) fall back to the service's mock host adapter, so
everything except the Adobe bridge itself behaves normally.

To remove the extension: `npm run uninstall:extension`.

### Building the companion

```sh
npm run companion       # panel + service bundle + shell, no installer
npm run companion:win   # a real NSIS installer, in apps/installer/release
npm run companion:mac   # a DMG — macOS only; electron-builder cannot cross-build it
```

`npm run companion` is the fast one and is what CI runs on both platforms: it
catches a Windows-only path or a bundler failure without spending five minutes
packaging. The service is bundled to a single 1.4 MB file with esbuild and runs
on Electron's own Node — measured at 24.18.1, with `node:sqlite` — so there is
no vendored runtime and no native module anywhere in the companion.

---

## When it does not work

Diagnose in this order — it follows the diagram at the top, and each step
tells you which half is at fault.

**1. Is the service up?**

```sh
curl http://127.0.0.1:47831/health
```

A JSON body means the service is fine and the problem is the panel or the
token. Connection refused means the service is not running.

**2. Does the panel appear in the Window → Extensions menu at all?**

If not, it is the install or PlayerDebugMode — the two steps above. Check the
extension actually landed:

- Windows: `%APPDATA%\Adobe\CEP\extensions\ai.seedstudios.seedae`
- macOS: `~/Library/Application Support/Adobe/CEP/extensions/ai.seedstudios.seedae`

On macOS, if you set the flag and it still does not appear, you probably
skipped `killall cfprefsd`.

**3. Panel appears but the light is not green.**

The token is wrong or stale. The token changes every restart unless
`SEED_AE_SESSION_TOKEN` is set in `.env` — read the current one from the
service's terminal, or set a fixed one and stop thinking about it.

**4. Green, but no providers in the dropdown.**

No `ARK_API_KEY`, or an Ark key with no `SEEDREAM_MODEL_ID`. Open the gear: any
row reading *not set* is the answer, and the save tells you what came online.

**5. A change you made is not showing.**

You edited the panel source and did not re-run `npm run install:extension`. It
is nearly always this.

---

## If you are the first person to run this on macOS

Write down what actually happened, because right now nobody knows:

- Did `npm install` complete without a native build failure?
- Did the panel appear in Window → Extensions, and after which of the four
  `CSXS.*` domains?
- Did **Capture Frame** produce a file, and was it the right frame?
- Did **Import** land the result in the project?
- Any path that broke on a folder name with a space in it?

Put the answers in `docs/STATUS.md` under a dated heading. A confirmed "it
works" from a Mac is worth more to this project than the next feature.
