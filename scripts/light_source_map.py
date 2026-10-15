"""False-colours every light source in a plate, as a guide image for the model.

    python -I scripts/light_source_map.py --plate party.png --out lightmap.png
    python -I scripts/light_source_map.py --plate party.png --out lights_only.png --mode keep

The party-city plate has ~300 separate light sources in it -- strings of small
bulbs, star-shaped paper lanterns, wall lamps, lit windows, the floodlit church
tower -- and the brief is that those lamps flicker on and the new scene arrives
with their light. A video model given the plate as a frame can see them, but it
has no reason to treat them as the subject. This marks them.

Two modes, because they fail differently and that matters more than which is
prettier:

- `false` paints each source in vivid magenta on black. The clearest possible
  "these are the lights" signal, and the worst failure mode: a model that
  decides the guide is artwork puts magenta blobs in the shot.
- `keep` paints each source in its own colour on black, so it reads as the
  plate's lights with everything else removed. A slightly weaker signal, and if
  the model does draw from it, what it draws is lights.

Sources are found the same way `light_spread_blend.py` finds them, so the two
agree about what a lamp is: the top few percent of luminance, then
`scipy.ndimage.label` for connected components. Each is drawn as its own blob
with a soft halo, because a bare mask of single-pixel bulbs survives neither the
downscale to the generation grid nor a video codec.
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--plate", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--mode", choices=["false", "keep"], default="false")
    p.add_argument("--percentile", type=float, default=97.0)
    p.add_argument("--halo", type=float, default=9.0, help="glow radius, in output pixels")
    p.add_argument("--width", type=int, default=0, help="resize the output's long edge")
    return p.parse_args()


def main():
    a = parse_args()
    plate = Image.open(a.plate).convert("RGB")
    W, H = plate.size
    rgb = np.asarray(plate, dtype=np.float32)
    lum = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]

    cut = float(np.percentile(lum, a.percentile))
    seed = lum >= cut
    labels, count = ndimage.label(seed)
    print(f"{W}x{H}: {count} light sources at luma >= {cut:.0f} ({100*seed.mean():.2f}% of frame)")

    if a.mode == "false":
        # One vivid colour, so the signal is "light source" and not "this hue".
        out = np.zeros_like(rgb)
        out[seed] = np.array([255.0, 0.0, 190.0], dtype=np.float32)
    else:
        out = np.zeros_like(rgb)
        out[seed] = rgb[seed]

    # A halo, so a single-pixel bulb survives the downscale to the generation
    # grid and the codec. Added rather than blended, so cores stay at full
    # strength and overlapping strings read as one brighter run.
    glow = Image.fromarray(out.clip(0, 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(radius=a.halo)
    )
    out = np.clip(out + np.asarray(glow, dtype=np.float32) * 1.15, 0, 255)

    image = Image.fromarray(out.astype(np.uint8))
    if a.width:
        image = image.resize((a.width, round(a.width * H / W / 2) * 2), Image.LANCZOS)
    image.save(a.out)
    print(f"wrote {a.out}  {os.path.getsize(a.out)/1e6:.1f} MB  {image.size}")


if __name__ == "__main__":
    main()
