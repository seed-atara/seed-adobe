# Recording script — SEED / AE

A 90-second screen recording. Shot list, actions, and what to say.

## Before you hit record

**The one thing that will ruin a take:** Seedance takes about 4 minutes. You
cannot wait for it on camera. So generate the hero clip *first*, then record —
and when you press Generate on camera, cut away before the wait.

Checklist:

- [ ] `npm run dev` running. Confirm `providers: mock-image, seedream, seedance`.
- [ ] **Region of Interest OFF** in the Composition viewer. It halves captures.
- [ ] Panel docked at roughly 420px wide, tall enough to show the Generate form.
- [ ] Hero comp open, playhead on the frame you want.
- [ ] **Pre-generate the hero clip** at 720p so it is already in the library:
      `npx tsx apps/panel/test/video.e2e.ts http://127.0.0.1:47831 <token> 10 720p`
- [ ] Clear the references row so you start clean.
- [ ] Hide the watchdog terminal. Keep AE and the panel only.

720p is the ceiling for this model in image-to-video. Frame the recording so
the clip plays in the panel and on the timeline rather than full-screen, and
it reads as intended — a shot inside the edit, not a delivery master.

---

## Shot 1 — the setup (0:00–0:10)

**Screen:** After Effects, hero comp, panel docked right. Nothing happening yet.

> "This is a normal After Effects project. Nothing exported, nothing round-tripped
> to a website. The panel on the right is part of the application."

Move the playhead a little. Point out the panel's status strip updating with the
comp name, resolution, frame rate and frame number.

> "It knows what I'm looking at."

---

## Shot 2 — capture (0:10–0:22)

**Action:** Park on the hero frame. Click **Capture current frame**.

> "One click takes the frame I'm looking at and registers it as a source asset."

**Screen:** Switch to the **library** tab. The frame is there with an `AE frame`
badge and a thumbnail. Click it.

> "It's not a screenshot in a folder. It carries where it came from — the project,
> the comp, the exact frame and timecode."

Let the detail pane's **after effects provenance** block sit on screen for a beat.

---

## Shot 3 — direction (0:22–0:38)

**Action:** Back on **generate**. The captured frame is already in references.
Set Provider to **Seedance 2.5 (Ark)**. Duration 10, resolution 720p.

Type the prompt live — short enough to read:

> `Image 1 is the reference. Hold the framing and push in slowly; dust drifts
> through the light.`

> "I describe the shot the way I'd describe it to an artist. Note that I refer to
> the reference by position — 'Image 1' — because that's how the model reads it."

**Action:** Press **Generate**. Show the job strip appear: status, progress.

> "That's a job, not a frozen panel. I can keep working."

**CUT HERE.** Do not film the wait.

---

## Shot 4 — the result (0:38–0:55)

**Screen:** Resume on the completed job — the clip is in the library with a
poster, marked as video. Click it; it plays in the detail pane.

> "Seedance 2.5, generated from that exact frame."

**Action:** Click **Insert at playhead**.

**Screen:** The clip lands as a layer in the comp, at the playhead. Scrub it.

> "And it's in the timeline. Not in a downloads folder — in the edit, at the
> playhead, ready to work with."

---

## Shot 5 — provenance (0:55–1:15)

**Action:** With the clip selected, click **Lineage**.

**Screen:** The chain — source frame at the top, the generated clip below it,
with the provider, operation and the prompt in quotes.

> "Every result remembers how it was made. The frame it came from, the model,
> the prompt, the seed."

**Action:** Click **Variation**. The recipe loads back into the form.

> "So I can reopen the recipe and branch from it. Change the prompt, change the
> seed — the original is untouched. This is version history for generation."

---

## Shot 6 — the line (1:15–1:30)

**Screen:** Pull back to the whole AE window: comp, timeline with the generated
layer, panel showing the lineage.

> "Seedance isn't outside the production pipeline anymore. It's inside the timeline."

---

## Notes for the edit

- If a take shows the partial-render warning, ROI was on. Reshoot the capture.
- The panel's job strip is the only moving element during generation; if you do
  show the wait, speed it up rather than cutting, so the status transitions read.
- Keep the AE render bar visible. It sells that this is a real project, not a mock.
- Do not zoom into the video full-screen. At 720p it will not hold up, and the
  point is the workflow, not the pixels.
