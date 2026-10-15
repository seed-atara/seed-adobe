"""Blends two plates by letting the destination's own lamps flicker on and creep outward.

    python -I scripts/light_spread_blend.py --from night.png --to party.png --out blend.mov
    python -I scripts/light_spread_blend.py ... --preview          # 1286px H.264, for judging
    python -I scripts/light_spread_blend.py ... --organic 0.9 --flicker-seconds 0.8

The GYG show goes coastal night -> party-city square, and those two plates are
not one set under two lights: matched on their gradient profiles they come back
at 0.359 across and 0.336 down, where the golden-hour-to-night shot's own two
ends scored 0.59-0.79. Different architecture, different materials, different
palette. Asking a video model to interpolate between them is asking it to invent
ten seconds of building.

The director's idea is what makes it tractable, and it is a compositing idea
rather than a generative one: the change is *led by the light*. Only ~3% of the
party plate is lit -- strings of small bulbs, star lanterns, wall lamps, lit
windows -- so those pixels are the sources, each one flickers on, and the new
artwork creeps outward from it.

## The two things the first version got wrong

It faded up smoothly and it spread in circles, and the note back was exact:
"more like flickering on", "like lights turning on that looks like mold
growing". Both of those are structural, not a matter of tuning:

**A Gaussian pool cannot grow like mold.** Blurring a seed mask and sweeping a
threshold down it gives a front whose speed falls off with distance, so every
pool is a soft circle that slows as it widens. Mold creeps at roughly *constant*
speed and its edge is ragged. That is a **distance field**, not a blur: the
front advances one pixel of distance per unit time whatever the shape, and
adding noise to the distance makes it lobe and branch. `scipy`'s exact Euclidean
transform gives the distance and, in the same pass, the index of the nearest
source -- which is what lets every pixel know which lamp owns it.

**A smooth fade cannot flicker.** Flicker is per-lamp and discontinuous, so the
lamps have to be individuals: `label` finds the connected components of the seed
mask, each gets its own ignition time and its own pseudo-random stutter, and
`return_indices` propagates that identity out through the lamp's territory so
the whole pool blinks with its lamp rather than pixel by pixel.

## What makes the order organic rather than a wipe

A lamp's ignition time is read from a low-frequency noise field sampled at the
lamp's position, so neighbouring lamps tend to come on together and the lit
region appears in blotches that then join -- rather than sweeping left to right.
Each pixel's arrival is then a mix of its lamp's ignition time and its own
noise-warped distance from that lamp, which is the growth.

## Why this is Python, in a TypeScript repo

16.2 million pixels times 240 frames, plus an exact Euclidean distance
transform. This is vectorised array work and numpy/scipy do it in seconds;
`scripts/` already carries `.jsx` and `.mjs` alongside the `.ts`.

Everything geometric is computed at quarter resolution and scaled up. The fields
are smooth and the saving is large: an exact distance transform with indices on
a full 5750x2818 frame allocates several hundred megabytes, and this box has
already had one background job killed for memory pressure. Frames then go to
ffmpeg down a pipe in horizontal bands, so peak memory stays near one band.

## What it guarantees

The first frame IS the source plate and the last frame IS the destination plate.
Arrival times are normalised into `[hold, 1]` and every lamp's stutter window
closes well before the end, so at t=0 nothing is revealed and at t=1 everything
is, with no blinking left running. Measured on the 1286px preview of the first
version: 2.53 and 3.08 mean absolute error against the two plates, which is JPEG
and resampling error and nothing else.
"""

import argparse
import os
import subprocess
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FFMPEG = os.path.join(ROOT, "node_modules", "ffmpeg-static", "ffmpeg.exe")


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="src", required=True, help="the plate it starts on")
    p.add_argument("--to", dest="dst", required=True, help="the plate it ends on")
    p.add_argument("--out", required=True, help="output .mov (ProRes) or .mp4")
    p.add_argument("--seconds", type=float, default=10.0)
    p.add_argument("--fps", type=float, default=24.0)
    p.add_argument("--hold", type=float, default=0.10,
                   help="fraction of the clip held on the source before anything lights")
    p.add_argument("--percentile", type=float, default=97.0,
                   help="luminance percentile of the destination that counts as a lamp")
    p.add_argument("--organic", type=float, default=0.75,
                   help="how far the growth front is warped off a circle, 0 = circles")
    p.add_argument("--spread", type=float, default=0.45,
                   help="share of the timing given to creeping outward vs lamps igniting")
    p.add_argument("--flicker-seconds", dest="flicker", type=float, default=0.7,
                   help="how long each lamp stutters before it settles")
    p.add_argument("--blinks", type=int, default=9, help="stutter steps per lamp")
    p.add_argument("--pace", type=float, default=0.65,
                   help="0 = raw growth (bunches up), 1 = equal area revealed per frame")
    p.add_argument("--settle", type=float, default=0.08,
                   help="fraction of the clip left fully arrived at the tail")
    p.add_argument("--edge", type=float, default=0.035,
                   help="softness of the creeping edge, as a fraction of the clip")
    p.add_argument("--bloom", type=float, default=1.0, help="0 turns the warm edge glow off")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--width", type=int, default=0, help="override output width")
    p.add_argument("--preview", action="store_true", help="1286px wide, H.264, for judging")
    return p.parse_args()


def value_noise(shape, octaves, rng):
    """Multi-octave value noise in [-1, 1]. Upsampled random grids, summed."""
    h, w = shape
    out = np.zeros(shape, dtype=np.float32)
    amplitude = 1.0
    total = 0.0
    for octave in range(octaves):
        cells = 2 ** (octave + 2)
        grid = rng.random((max(2, cells), max(2, int(cells * w / h) or 2))).astype(np.float32)
        up = np.asarray(
            Image.fromarray((grid * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC),
            dtype=np.float32,
        ) / 255.0
        out += amplitude * (up - 0.5) * 2.0
        total += amplitude
        amplitude *= 0.55
    return out / max(total, 1e-6)


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

    src = np.asarray(src_im, dtype=np.uint8)
    dst = np.asarray(dst_im, dtype=np.uint8)
    total = int(round(a.seconds * a.fps))
    rng = np.random.default_rng(a.seed)
    print(f"{W}x{H}, {total} frames at {a.fps}fps")

    # ---- geometry, at quarter resolution ---------------------------------
    gw, gh = max(96, W // 4), max(96, H // 4)
    lum = np.asarray(dst_im.resize((gw, gh), Image.LANCZOS).convert("L"), dtype=np.float32)
    cut = float(np.percentile(lum, a.percentile))
    seed = lum >= cut
    print(f"seed: {100 * seed.mean():.2f}% of frame lit at luma >= {cut:.0f}")

    labels, lamps = ndimage.label(seed)
    print(f"lamps: {lamps} connected sources")
    if lamps == 0:
        sys.exit("no lit pixels found; lower --percentile")

    # Distance to the nearest lamp, and which lamp that is. One pass gives both.
    dist, (iy, ix) = ndimage.distance_transform_edt(~seed, return_indices=True)
    owner = labels[iy, ix]                       # lamp id owning every pixel
    del iy, ix

    # When each lamp comes on: read off a low-frequency noise field at its own
    # position, so neighbouring lamps tend to ignite together and the lit area
    # appears in blotches that join, rather than sweeping across the frame.
    order_field = value_noise((gh, gw), 3, rng)
    centres = ndimage.center_of_mass(seed, labels, range(1, lamps + 1))
    ignite = np.zeros(lamps + 1, dtype=np.float32)
    for n, (cy, cx) in enumerate(centres, start=1):
        ignite[n] = order_field[int(np.clip(cy, 0, gh - 1)), int(np.clip(cx, 0, gw - 1))]
    lo, hi = float(ignite[1:].min()), float(ignite[1:].max())
    ignite[1:] = (ignite[1:] - lo) / max(hi - lo, 1e-6)
    # Some lamps light a bigger territory faster than others.
    vigour = rng.uniform(0.65, 1.45, size=lamps + 1).astype(np.float32)

    # The growth: distance warped by noise so the front lobes and branches
    # instead of staying a circle, and divided by each lamp's own vigour.
    warp = value_noise((gh, gw), 5, rng)
    span = float(np.percentile(dist, 99.0)) or 1.0
    creep = dist / span + a.organic * warp * 0.55
    creep = np.clip(creep / np.maximum(vigour[owner], 0.1), 0.0, None)
    creep /= max(float(np.percentile(creep, 99.5)), 1e-6)

    arrive = (1.0 - a.spread) * ignite[owner] + a.spread * creep
    arrive -= arrive.min()
    arrive /= max(float(arrive.max()), 1e-6)

    """Pace it.

    Raw arrival times bunch: most of the frame is close to some lamp, so most
    of it arrives in the middle third and the growth was visibly over by 7.5s of
    10, leaving a dead tail. Ranking the arrival times and mixing that back in
    spreads them towards equal area revealed per frame. Mixed rather than
    replaced, because full equalisation paces the growth so evenly that it stops
    looking like something spreading and starts looking like a meter filling.
    """
    flat = arrive.ravel()
    order = np.argsort(flat)
    ranks = np.empty(flat.size, dtype=np.float32)
    ranks[order] = np.arange(flat.size, dtype=np.float32) / max(flat.size - 1, 1)
    arrive = (1.0 - a.pace) * arrive + a.pace * ranks.reshape(arrive.shape)
    arrive -= arrive.min()
    arrive /= max(float(arrive.max()), 1e-6)

    # Into clip time: the hold at the head, a settled beat at the tail.
    usable = max(1.0 - a.hold - a.settle, 1e-6)
    arrive_t = a.hold + arrive * usable
    lamp_t = a.hold + (1.0 - a.spread) * ignite * usable
    phase = rng.random(lamps + 1).astype(np.float32) * 97.0

    def up(arr, mode):
        return np.asarray(
            Image.fromarray(arr.astype(np.float32), mode="F").resize((W, H), mode),
            dtype=np.float32,
        )

    arrive_full = up(arrive_t, Image.BILINEAR)
    lamp_t_full = up(lamp_t[owner], Image.NEAREST)
    phase_full = up(phase[owner], Image.NEAREST)
    seed_full = up(seed.astype(np.float32), Image.BILINEAR)
    del dist, owner, labels, warp, creep, arrive, arrive_t, order_field
    print(f"arrival spans {arrive_full.min():.2f}-{arrive_full.max():.2f} of the clip")

    flick_t = a.flicker / a.seconds          # stutter window, in clip fractions
    print(f"each lamp stutters for {a.flicker}s ({a.blinks} steps) then settles")

    # ---- encode ----------------------------------------------------------
    if a.preview or a.out.lower().endswith(".mp4"):
        codec = ["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p"]
    else:
        # ProRes 422 HQ: a projection master made of two native plates, with no
        # upscale anywhere in it, so nothing is thrown away here.
        codec = ["-c:v", "prores_ks", "-profile:v", "3", "-qscale:v", "9"]

    enc = subprocess.Popen(
        [FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{W}x{H}", "-r", str(a.fps), "-i", "-", *codec, "-an", a.out],
        stdin=subprocess.PIPE,
    )

    BAND = 256
    warm = np.array([52.0, 28.0, 7.0], dtype=np.float32) * a.bloom
    for n in range(total):
        t = n / (total - 1) if total > 1 else 1.0
        for y0 in range(0, H, BAND):
            y1 = min(H, y0 + BAND)
            # How far past its arrival this pixel is, as a soft 0..1 edge.
            reveal = np.clip((t - arrive_full[y0:y1]) / a.edge, 0.0, 1.0)
            reveal = reveal * reveal * (3.0 - 2.0 * reveal)

            # The lamp's stutter: a pseudo-random on/off whose duty rises
            # across the window, which is what a tube coming on looks like.
            k = (t - lamp_t_full[y0:y1]) / max(flick_t, 1e-6)
            step = np.floor(np.clip(k, 0.0, 1.0) * a.blinks)
            hashed = np.sin(step * 12.9898 + phase_full[y0:y1] * 78.233) * 43758.5453
            on = (hashed - np.floor(hashed)) < np.clip(k, 0.0, 1.0)
            blink = np.where(k >= 1.0, 1.0, np.where(k <= 0.0, 0.0, on)).astype(np.float32)

            alpha = reveal * blink
            a3 = alpha[:, :, None]
            out = (src[y0:y1].astype(np.float32) * (1.0 - a3)
                   + dst[y0:y1].astype(np.float32) * a3)
            if a.bloom:
                # Brightest where the edge is halfway, so light reads as
                # arriving; doubled on the lamps themselves as they strike.
                edge = (alpha * (1.0 - alpha) * 4.0)[:, :, None]
                strike = (blink * np.clip(1.0 - np.abs(k - 0.5) * 2.0, 0.0, 1.0))[:, :, None]
                out += edge * warm * (0.3 + 0.7 * seed_full[y0:y1][:, :, None])
                out += strike * warm * 0.8 * seed_full[y0:y1][:, :, None]
            enc.stdin.write(np.clip(out, 0, 255).astype(np.uint8).tobytes())
        if n % 48 == 0:
            print(f"  frame {n}/{total}", flush=True)

    enc.stdin.close()
    if enc.wait() != 0:
        sys.exit(f"ffmpeg exited {enc.returncode}")
    print(f"wrote {a.out}  {os.path.getsize(a.out) / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
