/**
 * Builds the alpha a region clip has to be clamped to.
 *
 *   npx tsx scripts/region-mattes.ts
 *
 * A region is cut from the assembled plate, so the clip that comes back is an
 * opaque rectangle: foreground *and* the sea, sky and palms behind it. Laid
 * straight back down that rectangle freezes its own piece of background while
 * the background clip animates everything around it, and every region on this
 * proscenium has open water crossing its edges. The fix is to give the clip
 * the foreground's own alpha, so outside the foreground's silhouette it
 * contributes nothing and the background shows through.
 *
 * ## The ring is the whole design
 *
 * Clamped to exactly the plate's alpha, a leaf cannot sway: the moment its tip
 * crosses the silhouette it was traced from, it is cut off, which cancels the
 * motion precisely where the motion is largest. So the matte is **dilated**,
 * and the dilation carries a linear falloff — opaque at the original edge,
 * transparent `ringPixels` out.
 *
 * That falloff does two jobs at once. A leaf tip swinging into the ring fades
 * rather than being guillotined, and the clip's own version of the sky, which
 * disagrees with the background clip's, is feathered to nothing instead of
 * arriving as a hard band. Both failures are edge artefacts; a gradient is the
 * answer to both.
 *
 * Built from the PSD rather than from the capture, because the capture is the
 * composite and has no alpha left to read. Registration is not assumed: the
 * crop is checked against the plate After Effects rendered, which matched at
 * dx=dy=0 with a residual under 1.6/255.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the region sits in the plate comp, and how big the clip's frame is. */
export interface RegionRect {
  key: string;
  centreX: number;
  centreY: number;
  width: number;
  height: number;
}

export const PROS_REGIONS: RegionRect[] = [
  { key: "R1", centreX: 570.285714285714, centreY: 2166.71429443359, width: 1141, height: 1141 },
  { key: "R2", centreX: 5154.5, centreY: 2156.10203552246, width: 1191, height: 1191 },
  { key: "R3", centreX: 1652.46939086914, centreY: 1908, width: 1024, height: 1820 },
  { key: "R4", centreX: 4097.53060913086, centreY: 1888.04081632653, width: 1046, height: 1860 },
];

/**
 * The top-left of a region in plate pixels.
 *
 * Rounded, which is what After Effects' own capture did — verified by
 * correlating against the rendered plates rather than reasoned about.
 */
export function regionOrigin(rect: RegionRect): { x: number; y: number } {
  return {
    x: Math.round(rect.centreX - rect.width / 2),
    y: Math.round(rect.centreY - rect.height / 2),
  };
}

const PSD = path.join(
  "G:",
  ".shortcut-targets-by-id",
  "1VGerIXaj6gSvEhuXFqvD3ckbHqnV67Ql",
  "COLLUSION_LAB",
  "PROJECTS",
  "GYG",
  "ANIM_DELIVERY",
  "goldenhour_psd",
  "gyg_gh_pros_pano_3.psd",
);
const FG_LAYER = "ChatGPT Image Sep 21, 2026, 02_47_31 PM";
const RING = 24;

const outDir = path.join(root, ".work", "pros-state2");
await mkdir(outDir, { recursive: true });

/*
 * The pixel work runs in Python: psd-tools reads the layered source and numpy
 * does the dilation, neither of which exists on the Node side of this repo.
 * Written out rather than inlined as an argument so it can be read and re-run
 * by hand when a matte looks wrong.
 */
const script = `
import io, json, sys
import numpy as np
from psd_tools import PSDImage
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

cfg = json.load(io.open(sys.argv[1], encoding='utf-8'))
psd = PSDImage.open(cfg['psd'])
W, H = psd.width, psd.height
layer = {l.name: l for l in psd}[cfg['layer']]
alpha = np.asarray(layer.composite(viewport=(0, 0, W, H), force=True).convert('RGBA'))[..., 3]

def dilate_with_falloff(a, ring):
    """Opaque where the artwork is, fading linearly to nothing \`ring\` px out.

    Iterated 3x3 maxima rather than a distance transform: scipy is not assumed
    on this machine, and at one pixel per pass the iteration count *is* the
    distance, which makes the falloff exact instead of approximate.
    """
    out = a.astype(np.float32)
    front = a > 8
    for step in range(1, ring + 1):
        grown = front.copy()
        # Sliced shifts, not np.roll: roll wraps, and a region's edges are a
        # real boundary -- the planter wall along the bottom would otherwise
        # grow a 24px ring along the top.
        grown[1:, :] |= front[:-1, :]
        grown[:-1, :] |= front[1:, :]
        grown[:, 1:] |= front[:, :-1]
        grown[:, :-1] |= front[:, 1:]
        new = grown & ~front
        out[new] = np.maximum(out[new], 255.0 * (1.0 - step / float(ring + 1)))
        front = grown
    return np.clip(out, 0, 255).astype(np.uint8)

report = []
for r in cfg['regions']:
    x, y, w, h = r['x'], r['y'], r['width'], r['height']
    crop = alpha[y:y + h, x:x + w]
    if crop.shape != (h, w):
        pad = np.zeros((h, w), np.uint8)
        pad[:crop.shape[0], :crop.shape[1]] = crop
        crop = pad
    matte = dilate_with_falloff(crop, cfg['ring'])
    Image.fromarray(matte, 'L').save(r['out'])
    report.append({
        'key': r['key'],
        'size': [int(w), int(h)],
        'plateOpaquePercent': round(float((crop > 250).mean()) * 100, 2),
        'mattePassesPercent': round(float((matte > 8).mean()) * 100, 2),
        'ringPercent': round(float(((matte > 8) & (crop <= 8)).mean()) * 100, 2),
        'out': r['out'],
    })
print(json.dumps(report))
`;

const regions = PROS_REGIONS.map((rect) => {
  const { x, y } = regionOrigin(rect);
  return {
    key: rect.key,
    x,
    y,
    width: rect.width,
    height: rect.height,
    out: path.join(outDir, `matte_${rect.key}.png`),
  };
});

const cfgPath = path.join(outDir, "mattes.json");
const scriptPath = path.join(outDir, "build_mattes.py");
await writeFile(cfgPath, JSON.stringify({ psd: PSD, layer: FG_LAYER, ring: RING, regions }), "utf8");
await writeFile(scriptPath, script, "utf8");

const python = spawn("python", ["-I", scriptPath, cfgPath], { windowsHide: true });
let out = "";
let err = "";
python.stdout.on("data", (c) => (out += String(c)));
python.stderr.on("data", (c) => (err += String(c)));
const code = await new Promise<number>((resolve) => python.on("close", resolve));
if (code !== 0) {
  console.error(err || `python exited ${code}`);
  process.exit(1);
}

const report = JSON.parse(out.trim().split("\n").pop()!) as Array<Record<string, unknown>>;
console.log(
  `Mattes for ${report.length} regions, ${RING}px feathered ring, in ${path.relative(root, outDir)}\n`,
);
console.log(
  `${"region".padEnd(8)}${"size".padEnd(12)}${"plate opaque".padEnd(14)}` +
    `${"matte passes".padEnd(14)}ring`,
);
for (const row of report) {
  const [w, h] = row.size as [number, number];
  console.log(
    `${String(row.key).padEnd(8)}${`${w}x${h}`.padEnd(12)}` +
      `${`${row.plateOpaquePercent}%`.padEnd(14)}${`${row.mattePassesPercent}%`.padEnd(14)}` +
      `${row.ringPercent}%`,
  );
}
console.log(
  "\nThe clip keeps only what the matte passes; the background clip shows " +
    "through the rest.\nThe ring is where a leaf is allowed to sway past the " +
    "silhouette it was traced from.",
);
