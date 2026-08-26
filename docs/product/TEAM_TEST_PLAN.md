# SEED / AE — the test pass, and what to record

**For the team. Written 2026-08-27.**

Twelve tests, about forty minutes. Each one is a thing that has broken before
or has never been run on your platform. Record the screen for all of it — one
continuous take is more useful than twelve clips, because the interesting
failures are the ones that only show up in sequence.

## Why record

This project has twice written a feature up as working from component
measurements and then had it fall over the first time it was opened inside
After Effects. A recording is the difference between "it didn't work" and a
fixable report: it captures the order you did things in, the state the panel
was in, and the thing you did half a second before it broke — which is
routinely the actual cause.

## Before you start

- Install per [`docs/INSTALL.md`](../INSTALL.md).
- Have the service terminal **visible in the recording** if you can fit it. Its
  log lines are timestamped and are half the diagnosis.
- Use a real project, not a blank comp: a comp with several layers, a camera
  move, and a folder name **with a space in it**. Path handling with spaces is
  a recurring source of bugs and a blank comp will not find them.
- Say what you are about to do out loud before you do it. Thirty seconds of
  narration saves an hour of guessing.

Write down at the top: **OS, After Effects version, Node version, and today's
commit** (`git rev-parse --short HEAD`).

---

## A. It is alive

### 1. The panel opens

Window → Extensions → SEED / AE.

**Pass:** it appears and the status light goes green after you paste the token.
**Record:** the Window menu itself, so we can see whether it was listed.

### 2. It knows what you have open

Look at the strip under the title bar.

**Pass:** it names your comp, its size, and the current frame — and the frame
number changes when you move the playhead.
**Known:** the panel reads this on demand, so it can lag a moment.

### 3. The gear takes a key

Click the gear. Set `ARK_API_KEY` and `SEEDREAM_MODEL_ID`, press Save.

**Pass:** the dialog reports what became available, and the Provider dropdown
in *generate* now has Seedream in it **without restarting anything.**
**Record:** the row badges before and after — they should flip from *not set*
to *set here*.
**This is new and has never been used by anyone but its author.**

---

## B. The loop that matters

This is the product. If only one section gets recorded, make it this one.

### 4. Capture the frame you are looking at

Park the playhead on a frame with something in it. Press **Capture**.

**Pass:** a new asset appears in *library* whose thumbnail is the frame you
were on — not the first frame, not black.
**Watch for:** a frame that is one off, or a comp with effects where the
capture shows the un-effected version.

### 5. Generate from it

In *generate*: the captured frame as a reference, a short prompt in your own
words, press **Generate**.

**Pass:** a job appears, moves through its states, and a result lands in the
library as a child of the captured frame.
**Record the whole wait.** How long it takes is data, and a job that appears
stuck is a different bug from one that fails.

### 6. Get it back into After Effects

Select the result → **Import**, then **Insert at playhead**.

**Pass:** the file lands in the project panel and a layer appears in the comp
at the playhead.
**Watch for:** wrong folder, wrong start time, a layer whose size does not
match the comp.

### 7. Reopen the recipe

Select the result → **Recipe**.

**Pass:** the exact prompt, provider, model, seed and references come back —
enough to reproduce it.

### 8. Vary it

From the same result, press **Variation**, change one thing, generate.

**Pass:** a new result that is a *sibling*, not a replacement. The original is
still there.
**This is the promise of the whole product** — history is never overwritten. If
anything here destroys a previous result, stop and report it immediately.

### 9. The lineage

*lineage* tab, with the variation selected.

**Pass:** the tree shows captured frame → result → variation.

---

## C. Direction and looks

### 10. Direct

Needs `ANTHROPIC_API_KEY` in the gear. Describe a shot in a sentence, press
**Direct**.

**Pass:** the form fills in with a prompt, references, and a rationale — and
nothing has been generated yet. You press Generate.
**Look at the prompt it wrote.** For a *video* it should come back as timecoded
beats, not a paragraph; for a still, a paragraph. This changed on 2026-08-27
and has **not been compared against the old behaviour** — your read on whether
the results are better is the measurement we do not have. Say so on the
recording.

### 11. The film look

Select any frame → **Treat**.

**Pass:** a graded child asset. Needs no key and reaches no network, so this
one should work on any machine.

### 12. A folder with a space in it

Do steps 4–6 again with the project saved somewhere like
`D:\Client Work\Big Job\`.

**Pass:** identical behaviour.
**This is deliberately last** because it is the one most likely to fail, and by
now everything else is on the recording.

---

## What we already know is missing

Do not report these — they are known and deliberate:

- **No Expand.** Aspect expansion was withdrawn on 2026-08-24 after failing on
  real footage. It exists only as `scripts/expand-shot.ts`, offline.
- **No ROO tab.** Scene switching and relighting are built and tested behind
  `/v1/switch`, but the tab is unmounted while the panel stays narrow.
- **No native plugins on macOS.** `seed-film-look` and
  `seed-frequency-detailer` are Windows-only C++ builds. The film-look
  *provider* in step 11 is separate and does work.
- **The service is not a background app.** You start it in a terminal and leave
  it there.

## Reporting

For each failure: **step number, what you expected, what happened, timestamp in
the recording.** Attach the service terminal output for that window of time.

The single most valuable thing you can send back is a numbered failure with a
timestamp. The second most valuable is a confirmed pass on macOS, which nobody
has yet.
