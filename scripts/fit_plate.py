"""Fits a plate into a shape Seedance will actually return, and says how to undo it.

    python -I scripts/fit_plate.py --plate wall.png --out wall_fit.jpg --tier 480p
    python -I scripts/fit_plate.py --plate wall.png --out wall_fit.jpg --tier 1080p --mode pad

Seedance returns 21:9 at the widest. The GYG side walls are 6688x1912, which is
**3.4979:1**, so they cannot be sent as they are: `adaptive` crops into the
middle and throws a third of the wall away.

Three ways out, and the numbers decide between them. For a side wall at 1080p:

| | useful pixels | upscale back | cost |
|---|---|---|---|
| pad to 21:9 | 2198x628 | 3.0x | 33% of the frame is bars |
| **squeeze to 21:9** | **2198x942** | **2.5x** | the model sees a 1.5x anamorphic world |
| split in two | 1920x1080 each | 1.8x | a seam down the middle of the wall |

**Squeeze is the default here.** It beats padding outright -- same frame, no
pixels spent on bars, so 22% more linear resolution -- and it keeps the wall as
one piece. Splitting has the best resolution of the three and is still the
wrong answer for this job: two halves are two independent generations with two
different choreographies, and the brief is a wave of light travelling
*continuously* across a 270 degree environment. A seam is exactly where that
illusion dies.

The squeeze is a non-uniform scale: 6688x1912 goes to 2198x942, which compresses
horizontally by 0.329 and vertically by 0.493, a horizontal squeeze of 0.667 --
in other words a 1.5x anamorphic, which is a real lens and a shape these models
have seen. Undoing it is a non-uniform scale back, and `--out` prints the exact
ffmpeg filter to use.

Nothing here is lossless and the note says so: a squeeze then an unsqueeze costs
horizontal detail that was never generated. What it does not cost is *content*,
which is what cropping costs.
"""

import argparse
import math
import os

from PIL import Image

TIER_PIXELS = {"480p": 854 * 480, "720p": 1280 * 720, "1080p": 1920 * 1080, "4k": 3840 * 2160}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--plate", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--tier", default="1080p", choices=sorted(TIER_PIXELS))
    p.add_argument("--aspect", default="21:9")
    p.add_argument("--mode", default="squeeze", choices=["squeeze", "pad"])
    p.add_argument("--fill", default="smear", choices=["smear", "mirror", "black"],
                   help="pad mode only")
    return p.parse_args()


def main():
    a = parse_args()
    plate = Image.open(a.plate).convert("RGB")
    W, H = plate.size
    aw, ah = (int(x) for x in a.aspect.split(":"))
    target = aw / ah

    px = TIER_PIXELS[a.tier]
    gh = round(math.sqrt(px / target) / 2) * 2
    gw = round(gh * target / 2) * 2

    print(f"{os.path.basename(a.plate)}  {W}x{H} = {W/H:.4f}:1")
    print(f"{a.tier} at {a.aspect} = {gw}x{gh}")

    if a.mode == "squeeze":
        fitted = plate.resize((gw, gh), Image.LANCZOS)
        hsq = (gw / W) / (gh / H)
        oversample = math.sqrt(gw * gh / (W * H))
        print(f"squeeze: horizontal {hsq:.4f} of vertical (a {1/hsq:.2f}x anamorphic)")
        print(f"  every generated pixel is wall; {oversample:.3f}x of source "
              f"({1/oversample:.1f}x upscale on the way back)")
        print(f"  undo with:  -vf \"scale={W}:{H}:flags=lanczos\"")
    else:
        pad_h = round(W / target / 2) * 2
        pad_w = W
        if pad_h < H:
            pad_w, pad_h = round(H * target / 2) * 2, H
        canvas = Image.new("RGB", (pad_w, pad_h))
        ox, oy = (pad_w - W) // 2, (pad_h - H) // 2
        canvas.paste(plate, (ox, oy))
        if a.fill != "black":
            # Edge-replicate into the bars, so a hard black edge does not read
            # as part of the artwork and get animated.
            if oy > 0:
                top = plate.crop((0, 0, W, 1)).resize((W, oy), Image.NEAREST)
                canvas.paste(top, (ox, 0))
                bottom = plate.crop((0, H - 1, W, H)).resize((W, pad_h - oy - H), Image.NEAREST)
                canvas.paste(bottom, (ox, oy + H))
            if ox > 0:
                left = plate.crop((0, 0, 1, H)).resize((ox, H), Image.NEAREST)
                canvas.paste(left, (0, oy))
                right = plate.crop((W - 1, 0, W, H)).resize((pad_w - ox - W, H), Image.NEAREST)
                canvas.paste(right, (ox + W, oy))
        fitted = canvas.resize((gw, gh), Image.LANCZOS)
        keep_w = round(gw * W / pad_w)
        keep_h = round(gh * H / pad_h)
        oversample = math.sqrt(keep_w * keep_h / (W * H))
        print(f"pad: {W}x{H} into {pad_w}x{pad_h}, {100*(1-(W*H)/(pad_w*pad_h)):.0f}% bars")
        print(f"  useful {keep_w}x{keep_h}, {oversample:.3f}x of source "
              f"({1/oversample:.1f}x upscale)")
        print(f"  undo with:  -vf \"crop={keep_w}:{keep_h}:{(gw-keep_w)//2}:{(gh-keep_h)//2},"
              f"scale={W}:{H}:flags=lanczos\"")

    fitted.save(a.out, quality=95, subsampling=0)
    print(f"wrote {a.out}  {fitted.size}  {os.path.getsize(a.out)/1e6:.2f} MB")


if __name__ == "__main__":
    main()
