# Reply to ByteDance — after the `output_format` answer

Draft, 2026-08-18. Their answer resolved the parameter question; this asks the
next set, which is about colour rather than containers.

---

Mittul — this is exactly what we needed, thank you. Two things in it we would
not have found ourselves: that `resolution` selects the codec, and that
`output_format` is acted on at execution rather than at submit. That second one
explains every negative result we had — our probes deliberately fail validation
so nothing bills, so a parameter the validator never touches was invisible to
us by construction.

We are moving to **1080p + `mov`** as our default. `yuv444p10le`, 10-bit, no
subsampling, and fully tagged — that closes two problems we had written down as
uncorrectable.

A few follow-ups, roughly in order of how much they would change our pipeline.

### 1. Full range

Everything comes back limited range (`tv`), including the 1080p output that is
otherwise properly tagged. What we send is full-range sRGB out of After
Effects, so there is a range conversion on the way in and another on the way
out, and the second one is lossy in the shadows and highlights specifically.

Is there any way to get **full-range (`pc`) output**, or a `color_range`
parameter? For a VFX pipeline this matters more than the chroma did — 16–235 in
8-bit throws away real code values, and a plate that goes round the loop several
times accumulates it.

Relatedly: what does the model **natively produce**, before encoding? If it is
RGB or full-range internally, then limited-range delivery is a lossy step added
at the end rather than something inherent, and it would be worth a flag.

### 2. Colour signalling at 480p and 720p

At those resolutions nothing is signalled at all — `color_range`,
`color_primaries`, `color_transfer` and `color_space` are all unset — so every
consumer guesses, and they guess BT.709 limited. 1080p is tagged correctly.

Could the 480p/720p outputs carry the same tags? Untagged video is not a
smaller problem than wrongly tagged video; it is the same problem with nobody
to blame. This looks like a one-line encoder change rather than a feature.

### 3. Explicit output control

Right now `resolution` implies the codec — 720p is 8-bit H.264, 1080p is 10-bit
HEVC — and `output_format` independently controls chroma. That coupling is
surprising, and it means asking for 10-bit requires asking for 1080p even when
the shot does not need the pixels.

Would you consider separating them: codec, bit depth, chroma and container as
their own parameters, with `resolution` meaning only resolution? Even if the
combinations remain restricted, being able to *state* the intent and get a clear
refusal beats inferring it from a table.

### 4. Anything above 4:4:4 10-bit

For finishing work the next steps up would be:

- **ProRes 4444 or 422 HQ**, which our hosts ingest natively
- **higher bitrate** than `high` gives — at 1080p mov we measure ~23 Mb/s, which
  is generous for delivery and thin for a plate that will be regraded
- **an alpha channel**, if the model can produce one. For motion graphics over a
  comp this is the single most valuable thing on this list, ahead of everything
  above.

### 5. Which models

You mentioned 2.0 and 2.0-fast reject `output_format` at submit. Is that
permanent, or is 2.5 simply ahead? We are also seeing `bitrate_mode` unread on
`dreamina-seedance-2-0-mini-260615` — nonsense values pass there — which we have
assumed means unsupported.

---

Happy to share our ffprobe results if useful; we ran the same matrix
independently and can send the table.
