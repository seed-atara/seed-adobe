# Future features

Things worth building, written down when they were noticed rather than when
there was time to do them. Each entry says what the problem actually is, not
just the feature name — the problem outlives the solution I had in mind.

Nothing here is scheduled. Ordered roughly by how much pain it removes.

---

## Region editing: stop destroying hand work

**The problem.** Every capture and every composite rebuilds the composite layer
(`SEED Region N (comp)`) in the plate comp: it resets Position, resets Scale to
100%, and deletes *all* masks before rebuilding one rectangular feathered mask.

So an edge shaped by hand on that layer is destroyed by the next SEED action,
without warning. The artist has no way to know which of their edits are durable
and which are on loan.

The sub-comp is already safe — capture only replaces layers named `SEED plate*`
— so the structure is right; it is only the composite layer that betrays it.

**Three changes, in order of value:**

1. **Name SEED's mask** (`SEED edge`) and rebuild only that one. Any mask the
   artist adds is left alone. This removes the trap entirely and is the smallest
   change of the three.
2. **Stop resetting the transform** on a composite that already exists. Nudging
   a composite a few pixels to hide a seam is a legitimate thing to want, and
   currently it silently reverts.
3. **A "detach" action** that renames the composite so SEED never touches it
   again — for a region that is finished and is being hand-finished.

Together these would make the composite layer as safe to edit as the sub-comp,
which is what an artist reasonably assumes it already is.

**Also worth doing:** re-capturing replaces the still layer inside the sub-comp
rather than updating it, so anything parented to it — or using it as a track
matte — loses its link. Replacing the *source* of the existing layer instead of
the layer itself would fix that.

---

---

## Better edges than a rectangle

Feather is currently a uniform rectangular inset. It hides a seam by blurring
it, which works on soft material (curtain, haze) and fails on detail (the
gilded arch).

Ideas, roughly increasing in ambition:

- **Per-edge feather** — a wide region often wants a soft left and right and a
  hard top and bottom.
- **Feather as a percentage** of the region, so it survives a rescale.
- **Edge along the plate's own geometry** — let the artist draw the boundary
  once inside the sub-comp and have SEED leave it alone (see above). A seam
  hidden behind a column is invisible; a blurred rectangle never quite is.
- **Automatic grade match** — sample the plate and the result at the boundary
  and generate a corrective Curves layer inside the sub-comp. The drift between
  a generated frame and its plate is the real reason a patch reads, more than
  the edge itself.

---

## Scrub library cards, not just the detail preview

The detail preview plays on hover, scrubs with horizontal movement, and rewinds
on the way out. The library grid does not: a video card is a still with a play
marker on it, so telling two takes apart means opening each one in turn.

Comparing takes is most of what the library is *for* — several variants of the
same shot sit side by side and the difference between them is motion, which a
frozen first frame cannot show. The behaviour should be the same gesture in
both places.

**The reason it is not already done:** the detail preview fetches the whole
video as a blob, which is fine for one clip and wrong for a grid — twenty-four
cards would mean twenty-four full downloads on mount, most never watched. It
needs to load on first hover and stay loaded after, so the grid costs nothing
until something is actually looked at.

Worth extracting the hover/scrub logic into one hook shared by both, rather
than a second copy that drifts.

---

## Video poster frames

Generated video registers with no thumbnail: `no decoder for these bytes`. The
library shows a placeholder, and image-to-video results borrow the poster of
the frame they came from, which is honest but not a real extract.

Extracting the first frame of an MP4 without a dependency is the blocker. An
`AeHostAdapter` route could render one through After Effects, which is already
open — but that only works while AE is running.

---

## `PublicUrlPublisher` and the `asset://` route

`ARK_REFERENCE_POLICY=inline` sends local frames as data URLs. It works, but
inline is the wrong route for recognisable real people (ADR 0005), and the
account's asset library exists precisely for this.

Needs a presigned-URL publisher (S3/R2/GCS). Once it exists,
`ARK_REFERENCE_POLICY=asset` becomes the default and references are registered
rather than embedded.

---

## Unverified provider behaviour

Each of these needs a real billable render, which is why none is answered:

- **Does a `reference_video` actually drive motion?** The shape is accepted —
  `video_url` + `role: reference_video` — but whether the model follows the
  camera move has never been run. This is the basis of "take the move from this
  plate, the characters from these stills", so it is worth one cheap test on
  2.0 mini.
- **Duration ranges per model.** 4–30s is verified for 2.5. The 2.0 variants
  may differ, and the free probe cannot tell: a request valid in every other
  respect creates a task.
- **Reference count in practice.** Validation accepted 64; the launch material
  says 30. Whether quality holds at high counts is unknown, and the offered
  maximum is configuration for that reason.

---

## Smaller things

- **`@mentions` reach the provider verbatim.** The director resolves a mention
  to a candidate but leaves the token in the prompt it writes, so the model
  receives a filename mid-sentence and has to ignore it. Strip resolved tokens
  from the description before composing — the mention list already says which
  candidate each one is.

- **`aeHost: "mock"` in the startup log** reads as though something fake is
  running. The service genuinely has no direct AE host — the panel drives AE —
  so `panel-driven` would say what is true.
- **Per-reference role notes.** With several references, the artist knows which
  is the character and which is the location; the director currently has to
  infer it from the picture. A short note per reference would feed straight
  into the prompt it writes.
- **Region presets.** A named region size and shape ("hero square", "banner")
  saved per project, so a plate that gets worked repeatedly does not need
  reframing each time.
- **Cancel should cancel at the provider.** Cancelling a job stops SEED
  polling, but the render continues and is billed. Ark's cancel endpoint
  refuses a running task (`InvalidAction.RunningTaskDeletion`), so this may not
  be possible — worth confirming rather than assuming.
