"""Says whether two plates are the same set under different light, or two different sets.

    python -I scripts/plate_pair_match.py A.png B.png [--label name] [--pair C.png D.png ...]

This is the question that decides whether a pair can be handed to a video model
at all. The golden-hour-to-night PROS pair is one building relit: every arch,
column and roofline is in the same place, so interpolating between them is a
lighting change and the model only has to light it. The night-to-party-city
pair is two different buildings, and asking for ten seconds between them is
asking for ten seconds of invented architecture -- which is what came back.

The measurement is the normalised gradient profile, the same one
`check-daynight-transition.ts` uses to find camera drift, for the same reason:
dividing each profile by its own energy makes it blind to the brightness and
colour change the transition is *for*, and leaves only where the edges are. Two
plates of the same set correlate high whatever the hour; two different sets do
not.

Calibration from this project, so a number has something to be read against:

    PROS golden -> night      0.59 - 0.79    worked, generated in one pass
    sides night -> party      0.359 / 0.336  invented a building

Print both axes. A pair can agree down the frame and disagree across it when
the horizon survives but the buildings do not.
"""

import argparse
import os

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("plates", nargs="*", help="pairs of plates, two at a time")
    p.add_argument("--pair", action="append", nargs=3, metavar=("LABEL", "A", "B"),
                   default=[], help="a labelled pair; repeatable")
    p.add_argument("--width", type=int, default=1400, help="working width")
    return p.parse_args()


def profiles(path, width):
    im = Image.open(path).convert("L")
    w, h = im.size
    im = im.resize((width, max(2, round(width * h / w))), Image.LANCZOS)
    g = np.asarray(im, dtype=np.float32)
    gx = np.abs(np.diff(g, axis=1)).mean(0)   # edge energy per column
    gy = np.abs(np.diff(g, axis=0)).mean(1)   # edge energy per row
    # Normalising by each profile's own energy is what makes this blind to the
    # lighting change and sensitive only to where the structure is.
    gx = (gx - gx.mean()) / max(gx.std(), 1e-6)
    gy = (gy - gy.mean()) / max(gy.std(), 1e-6)
    return gx, gy


def main():
    a = parse_args()
    pairs = list(a.pair)
    rest = a.plates
    for i in range(0, len(rest) - 1, 2):
        pairs.append((f"{os.path.basename(rest[i])} -> {os.path.basename(rest[i + 1])}",
                      rest[i], rest[i + 1]))
    if not pairs:
        raise SystemExit("give at least two plates, or --pair LABEL A B")

    print(f"{'pair':<34} {'across':>7} {'down':>7}  reading")
    for label, pa, pb in pairs:
        ax, ay = profiles(pa, a.width)
        bx, by = profiles(pb, a.width)
        n = min(len(ay), len(by))
        cx = float(np.corrcoef(ax, bx)[0, 1])
        cy = float(np.corrcoef(ay[:n], by[:n])[0, 1])
        worst = min(cx, cy)
        reading = ("the same set relit" if worst >= 0.55 else
                   "borderline" if worst >= 0.45 else
                   "DIFFERENT SETS -- do not ask a model to interpolate")
        print(f"{label[:34]:<34} {cx:7.3f} {cy:7.3f}  {reading}")


if __name__ == "__main__":
    main()
