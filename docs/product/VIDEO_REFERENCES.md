# Video references — reskinning and re-animating a shot

A still tells a model what a shot *looks* like. A clip tells it what the shot
*does*: the camera move, the timing, the way a hand crosses frame. Seedance
takes both, and a clip is what makes "keep this move, change everything else"
a thing you can ask for.

This is the path from a timeline to a reference and back.

## What Seedance does with a clip

Attach a clip and the request stops being generation and becomes editing. Ark
says so in its own words when you get it wrong: *"Seedance identified your task
as video editing based on your prompt. For this task type, the output ratio and
duration follow the input video."*

That classification decides what you may set, and it is made from your text
after you press Generate — so the panel's rule is *silence follows the clip,
asking is allowed*:

- **Leave Duration and Aspect blank** and the result takes the clip's length
  and shape. SEED sends `duration: -1`, which is Ark's way of saying "follow
  the input", and that is accepted whichever way the prompt reads. This is what
  you want for a reskin.
- **Set them** and they are sent. Accepted when the prompt describes a new shot
  ("a lone figure walking across a salt flat"); refused when it describes a
  change to this one ("the same camera move, restyled"). The refusal costs
  about twenty seconds of a running task and says so plainly in the panel —
  clear Duration and generate again.
- **Size is always yours.** 720p from a 2663x1498 plate is fine.
- **The clip itself must be 4–30 seconds.** Shorter or longer is refused, so
  the panel checks before letting you press Generate.

To change the length of a reskin, capture a different work area — the clip's
length *is* the output length, by design.

## Getting a clip out of After Effects

### The button

**Capture work area as clip**, next to Capture current frame.

It renders the comp's work area to H.264 through the render queue, writes a
poster frame beside it, registers both as one video asset, and attaches it as a
reference. The render happens inside After Effects and blocks it, so a long
range is a long wait — set the work area to the few seconds that matter (**B**
and **N** set its start and end at the playhead).

Two things worth knowing about the render:

- It needs an **H.264 output module template**. Every modern After Effects has
  one; SEED searches the templates by name rather than assuming which. If none
  exists it says so and points you at the manual route below.
- Anything already queued is taken out of the queue for the duration and put
  back afterwards. SEED never renders someone else's overnight comp by
  accident.

### By hand, which is sometimes the right answer

The button renders the *comp*. When you want something else — a single layer,
a different codec, a range that is not the work area, a shot from another
application entirely — export it yourself:

1. **Composition → Add to Render Queue** (Ctrl+M).
2. Set the **output module** to H.264 and the **time span** to the range you
   want. (Or **File → Export → Add to Adobe Media Encoder Queue** if you prefer
   AME's presets — SEED does not care which produced the file.)
3. Render.
4. In the panel: **Add a clip or image from disk…**, and pick it.

The file is copied into the library, its dimensions and duration are read out
of the container, and it becomes a reference exactly like a captured one. This
is also the route for a reference that never came from a timeline at all —
plate footage, a reference film, a clip someone sent you.

### Premiere

**Capture in-to-out as clip**, the same button under a name that matches what
Premiere calls a range.

Mark in and out (**I** and **O**) around the span you want first. Without them
Premiere reports the whole sequence, and quietly encoding forty minutes because
nobody marked anything is not a favour — so it refuses and says so.

#### It needs a preset you exported yourself

Premiere has no direct video export in scripting; the route is
`exportAsMediaDirect` with an `.epr` preset, the same machinery as the still.

**Adobe's factory presets cannot be used**, even though they are the same file
extension and sit right there in the install. They are a different format —
they open with `<ExportXMPOptionKey>` and carry a localisation token where the
name should be, while an exported preset opens with `<PresetName>` and a
`<PresetComments>`. Handed a factory preset, `exportAsMediaDirect` answers
"Unable to initialize export!", which is Premiere's reply to a great many
objections and names none of them.

So make one, once, and it is there forever:

1. **File → Export → Media** on any sequence.
2. Format **H.264**, and a preset like **Match Source - High bitrate**.
3. Next to the preset dropdown, **Save Preset** — name it something like
   `SEED H264`.
4. Restart the service. It looks in `Documents/Adobe/Adobe Media Encoder` and
   `Documents/Adobe/Premiere Pro` and logs `ppro.video_preset_found`.

That is the same thing you already did for the PNG still preset.

**HEVC is a fallback, not a choice.** If there is no H.264 preset SEED will use
an HEVC one rather than refuse, and says so in the log — it is the same `.mp4`
container, but no provider has been shown to accept the codec, so treat a
failure there as expected rather than mysterious.

`SEED_PPRO_VIDEO_PRESET` overrides discovery with a path. And the manual route
always works: export the range yourself and use **Add a clip or image from
disk…**

## Where the clip goes

Nowhere public. The bucket SEED uploads to is private, and Ark is handed a
presigned link that grants read of that one object for an hour — the same trust
boundary as the data URLs images already travel by. Objects are keyed by
content hash, so referencing the same clip twice uploads it once. See
ADR 0009.

Without `SEED_R2_*` configured, images still work exactly as before and a video
reference is refused with a message naming the four settings it needs.

## The loop

```
work area → Capture work area as clip → library (with poster)
          → prompt: what should change
          → Generate → placeholder holds the cut at the clip's length
          → result swaps in, same length, same shape, lineage back to the clip
```

Everything after the capture is the loop that already existed. A clip is just
another kind of reference — which is the point.
