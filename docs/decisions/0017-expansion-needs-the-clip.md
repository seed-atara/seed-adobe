# 0017 — Expanding a shot needs the shot, not a frame of it

**Status:** `ReframeProvider` restored 2026-08-24
**Date:** 2026-08-24
**Reverses:** ADR 0016's removal of Luma Reframe

## What was wrong

ADR 0016 said SEED's own expansion replaced Luma Reframe, and compared them on
cost, aspect freedom, length and coverage reporting. Ours won on all of those.

It compared the wrong thing. The two do not produce the same *kind* of artefact:

- **Reframe is video-to-video.** It takes the clip, keeps its frames unchanged,
  and paints the surrounding canvas. The result matches the source because it
  *is* the source, widened.
- **Ours was still-to-video.** It took one frame, placed it in a wider canvas,
  and asked a generator to make a clip from it. The generator invents its own
  camera move. Composite the original back over that and the margins drift
  against the middle — the thing the whole feature exists to avoid.

An expansion whose edges swim is not a cheaper expansion. It is not one.

## Why Seedance cannot close the gap

Both of these are measured, and both are recorded in
`docs/research/MODEL_API_NOTES.md`:

- **A first frame and a reference video are mutually exclusive.** *"first/last
  frame content cannot be mixed with reference media content."* So a wide plate
  and the source clip cannot be sent together.
- **A reference video dictates the output shape.** *"the output ratio and
  duration follow the input video selected by the model for editing."* Send the
  square clip as a reference and a square clip comes back.

There is no arrangement of Seedance's inputs that widens a shot while following
it. That is not a gap in the adapter; it is what the API does.

## Where each tool belongs

| the shot | the tool | why |
| --- | --- | --- |
| pans or tilts far enough | **SEED recovery** | the margins were photographed. Free, exact, temporally perfect by construction — no model involved |
| anything else that moves | **Luma Reframe** | video-native outpainting; the source frames survive, so it matches |
| a still, or a locked-off frame with no continuation | Seedance from a first frame | there is no motion to match |

The rule is unchanged from ADR 0016 — *measure when the answer is in the
footage, generate when it genuinely is not* — but "generate" has to mean a
generator that takes the clip.

## What this costs

`FAL_KEY` is needed again, and Reframe bills per started source second
(~$0.06/s at 540p, $0.12/s at 720p, $0.36/s at 1080p), capped at 30 seconds and
six fixed aspects. That is the price of an expansion that actually matches, and
the coverage measurement still runs first and free — where it comes back high,
recovery does the job for nothing and Reframe is not needed at all.

## The lesson worth keeping

Removing a working tool because a home-built one scored better on a table of
attributes, without checking that the two produce the same kind of result. The
comparison in ADR 0016 was real; it was measuring the wrong axis. A capability
table cannot tell you that one column is load-bearing and the rest are not.
