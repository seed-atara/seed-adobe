"""Fades one plate to another on a named beat, and nothing else.

    python -I scripts/timed_fade.py --from night.png --to party.png \
        --out floor.mov --beat 12.583 --seconds 16.83
    python -I scripts/timed_fade.py ... --preview          # 1286px H.264, for judging
    python -I scripts/timed_fade.py ... --lift 0.35        # warm transient on the beat

## Why a fade is the right answer here, for the floor

The generated floor draft failed in a way worth recording: given a top-down
plate with no horizon, Seedance read it as an elevation and built a two-storey
courtyard facade over the middle eight seconds, then dived back to the paving
for the landing. Measured as progress toward the last frame it went to **-52%**
-- further from the destination than the first frame was -- which is what
inventing a building looks like in one number.

The floor is also the surface with the least to gain from generation: it is a
flat texture seen top-down, there is no parallax to discover, and during the
reveal nobody is looking at it. So the floor does not need ten seconds of
invented motion. It needs to change at the same instant the walls do.

## The curve

Everything is pinned to one number, the beat -- 12.583s, where the three wall
clips' cascade fires, measured by `sync-flash.ts`. Around it:

    hold          the source plate, untouched, exactly as the show is holding it
    core          70% of the change, over `--fade` seconds centred on the beat
    settle        the last 30%, easing out over `--settle` seconds after it

Two segments rather than one because a single smooth ramp long enough to not
feel like a cut is also too slow to feel like lights coming on. Splitting it
puts the steepest moment exactly on the beat and still lets the picture arrive
gently. The first frame IS the source plate and the last frame IS the
destination plate, which is the same guarantee the generated clips are held to.

## --lift, and why it is offered rather than chosen

The floor is the one surface that gets *darker* across this transition: pale
moonlit limestone at luma 69.8 becomes warm cobble at 50.2. So a straight fade
means that at the moment the walls blaze, the floor dims. `--lift` adds a warm
transient peaking on the beat -- the floor catching the light before it settles
to its darker warm -- weighted to amber (R 1.0, G 0.75, B 0.35) so it reads as
lantern light rather than exposure. It is an art call, not a correctness one,
so it defaults to off and both versions are cheap to look at.
"""

import argparse
import os
import subprocess

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="src", required=True, help="the plate it starts on")
    p.add_argument("--to", dest="dst", required=True, help="the plate it ends on")
    p.add_argument("--out", required=True, help="output .mov (ProRes) or .mp4")
    p.add_argument("--seconds", type=float, default=16.83, help="slot length")
    p.add_argument("--fps", type=float, default=24.0)
    p.add_argument("--beat", type=float, default=12.583,
                   help="when the change lands; the walls' cascade is at 12.583s")
    p.add_argument("--fade", type=float, default=0.6,
                   help="seconds the core of the change takes, centred on the beat")
    p.add_argument("--settle", type=float, default=1.2,
                   help="seconds the last 30%% eases out over, after the core")
    p.add_argument("--lift", type=float, default=0.0,
                   help="warm transient on the beat, 0 = off, 0.35 = a visible catch")
    p.add_argument("--lift-seconds", dest="lift_s", type=float, default=0.45)
    p.add_argument("--width", type=int, default=0, help="override output width")
    p.add_argument("--preview", action="store_true", help="1286px wide, H.264, for judging")
    return p.parse_args()


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def main():
    a = parse_args()
    src_im = Image.open(a.src).convert("RGB")
    dst_im = Image.open(a.dst).convert("RGB")
    if src_im.size != dst_im.size:
        print(f"! {src_im.size} and {dst_im.size} differ; resizing the destination to match")
        dst_im = dst_im.resize(src_im.size, Image.LANCZOS)

    W, H = src_im.size
    if a.preview:
        W, H = 1286, round(1286 * H / W / 2) * 2
    elif a.width:
        W, H = a.width, round(a.width * H / W / 2) * 2
    if (W, H) != src_im.size:
        src_im = src_im.resize((W, H), Image.LANCZOS)
        dst_im = dst_im.resize((W, H), Image.LANCZOS)

    src = np.asarray(src_im, dtype=np.float32)
    dst = np.asarray(dst_im, dtype=np.float32)
    total = int(round(a.seconds * a.fps))
    t = np.arange(total, dtype=np.float32) / a.fps

    core_start = a.beat - a.fade / 2.0
    core_end = a.beat + a.fade / 2.0
    w = (0.70 * smoothstep(core_start, core_end, t)
         + 0.30 * smoothstep(core_end, core_end + a.settle, t))
    # The ends are exact, whatever the beat and the slot length do.
    w[0] = 0.0
    w[-1] = 1.0
    lift = a.lift * np.exp(-(((t - a.beat) / max(a.lift_s, 1e-6)) ** 2))
    tint = np.array([1.0, 0.75, 0.35], dtype=np.float32)

    print(f"{W}x{H}, {total} frames at {a.fps}fps = {(total - 1) / a.fps:.3f}s")
    print(f"beat {a.beat}s: holds to {core_start:.2f}s, 70% by {core_end:.2f}s, "
          f"arrived by {min(core_end + a.settle, (total - 1) / a.fps):.2f}s")
    print(f"luma {src.mean():.2f} -> {dst.mean():.2f}"
          + (f", warm transient +{a.lift:.2f} peaking on the beat" if a.lift else ""))

    prores = a.out.lower().endswith(".mov")
    codec = (["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
             if prores else
             ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
    proc = subprocess.Popen(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(a.fps), "-i", "-", *codec, a.out],
        stdin=subprocess.PIPE,
    )
    for i in range(total):
        frame = src + (dst - src) * w[i]
        if lift[i] > 1e-4:
            frame = frame * (1.0 + lift[i] * tint)
        proc.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed")
    print(f"wrote {a.out}  {os.path.getsize(a.out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
