/**
 * Keys the four region clips and puts them back on the proscenium.
 *
 *   npx tsx scripts/finish-pros-regions.ts              measures, writes nothing
 *   npx tsx scripts/finish-pros-regions.ts --apply      keys, re-points, inserts
 *   npx tsx scripts/finish-pros-regions.ts --apply --only R3
 *
 * The regions were re-captured with `BG_waves_Sunset` switched off, so each
 * plate is `FG_Object` alone with its own alpha, stood on flat chroma-blue.
 * That is the better plate, and it changes the recipe: the clip is **keyed**
 * rather than clamped.
 *
 * The difference matters at exactly one place — the leaf tips. A clip cut from
 * the assembled plate is opaque, so the only alpha available is the one the
 * artwork already had, and a leaf swaying past its own silhouette gets cut off
 * precisely where the motion is largest. Keyed off a backing, the leaf takes
 * its own alpha with it and the animated sea shows through behind.
 *
 * `/v1/matte` does the key: a connected-region fill rather than a colour
 * threshold, so chroma subsampling costs edge softness instead of whole holes.
 *
 * ## Putting it back without switching composition
 *
 * R1, R2 and R4 already carry three layers each in their sub-comps from the
 * clamped round, at 0s, 10s and 20s, scaled to fill. Re-pointing those footage
 * items at the keyed clips reuses all of it — the keyed clip is the same frame
 * size, so the scale stays right — and avoids making a sub-comp active, which
 * would mean a full 5750x2818 render on the way back to the plate comp. R3 was
 * never inserted, so it goes in with `insertRegion` the normal way.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;

const FEATHER = 24;
const STARTS = [0, 10, 20];

interface Region {
  key: string;
  regionName: string;
  /** The generation that produced the clip on blue. */
  generationId: string;
  /** Footage items already placed in the sub-comp, to re-point. Empty = insert. */
  reuseItemIds: string[];
}

const REGIONS: Region[] = [
  {
    key: "R1",
    regionName: "SEED Region 1",
    generationId: "gen_199442cb-7c00-492e-a0c4-bc94e3edb003",
    reuseItemIds: ["1613", "1615", "1617"],
  },
  {
    key: "R2",
    regionName: "SEED Region 2",
    generationId: "gen_582b1a74-cabf-4375-b255-149aee5676e6",
    reuseItemIds: ["1619", "1621", "1623"],
  },
  {
    key: "R3",
    regionName: "SEED Region 3",
    generationId: "gen_34400f40-69bc-4312-8795-e00d556a8ed9",
    reuseItemIds: [],
  },
  {
    key: "R4",
    regionName: "SEED Region 4",
    generationId: "gen_561bb4d3-c1ae-4af9-8cf1-5d976accaf68",
    reuseItemIds: ["1625", "1627", "1629"],
  },
];

const env = Object.fromEntries(
  (await readFile(path.join(root, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);
const base = `http://${env.SEED_AE_HOST ?? "127.0.0.1"}:${env.SEED_AE_PORT ?? "47831"}`;
const token = env.SEED_AE_SESSION_TOKEN!;

async function api(method: string, route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${method} ${route}: ${JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

async function host(name: string, args: Record<string, unknown>): Promise<any> {
  const payload = await api("POST", "/v1/host/run", { name, args });
  if (!payload.ok) throw new Error(`${name}: ${payload.error}`);
  return payload.value;
}

/*
 * How much the clip actually moves, and whether it still looks like the plate.
 *
 * The three numbers that have decided every region so far: amplitude says
 * whether the motion is an idle or a performance, loop closure says whether
 * the last frame meets the first, and the leaf-area swing catches a plant
 * being re-drawn rather than moved — which is what the monstera did at 10s.
 */
const measure = `
import glob, json, os, sys
import numpy as np
from PIL import Image

frames = sorted(glob.glob(os.path.join(sys.argv[1], 'f*.png')))
ims = [np.asarray(Image.open(f).convert('RGBA'), np.float32) for f in frames]
lum = [0.2126*i[...,0] + 0.7152*i[...,1] + 0.0722*i[...,2] for i in ims]
alpha = [i[...,3] for i in ims]
stack = np.stack(lum)
keep = alpha[0] > 128
area = [float(((l < 95) & (a > 128)).sum()) for l, a in zip(lum, alpha)]
print(json.dumps({
    'frames': len(ims),
    'alphaKeptPercent': round(float((alpha[0] > 128).mean()) * 100, 1),
    'amplitude': round(float(stack.std(axis=0)[keep].mean()), 2),
    'loopClosure': round(float(np.abs(lum[-1] - lum[0])[keep].mean()), 2),
    'leafAreaPeakPercent': round(max(area) / area[0] * 100, 1),
    'leafAreaEndPercent': round(area[-1] / area[0] * 100, 1),
}))
`;

const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const work = path.join(root, ".work", "pros-state2");

async function run(exe: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.slice(0, 400) || `exit ${code}`)),
    );
  });
}

const chosen = only ? REGIONS.filter((r) => r.key === only) : REGIONS;

for (const region of chosen) {
  const { generation, outputs } = await api("GET", `/v1/generations/${region.generationId}`);
  if (generation.status !== "succeeded" || !outputs?.length) {
    console.log(`${region.key}  not ready (${generation.status})`);
    continue;
  }
  const clip = outputs[0];
  console.log(`\n${region.key}  ${region.regionName}`);
  console.log(`  clip   ${clip.filename}  ${clip.width}x${clip.height}`);

  if (!apply) continue;

  /*
   * Key the backing out, telling it the colour rather than letting it sample.
   *
   * The auto-sample is wrong for a region, and wrong in the way that hurts
   * most. It reads the frame edge, and a region cut out of a larger plate has
   * artwork running right to that edge — the planter wall, the columns — so
   * the sample came back [47,29,207] when the backing the model actually
   * rendered is [0,4,245]. Measured: the frame edge of the R4 clip has a
   * channel spread of (221,143,244), which is a sample of the artwork, not of
   * the backdrop.
   *
   * 47 off is *inside* the flood tolerance of 60, so everything connected to
   * the edge still keyed — and far outside the pocket tolerance of 16, so
   * every enclosed opening survived. The right-centre arch came back as a
   * sheet of blue. A plate we rendered ourselves has a backing we know, so
   * there is no reason to infer it.
   *
   * The pocket tolerance is then raised to match: the nearest artwork pixel is
   * 166-175 from blue, so 60 cannot reach the artwork, and `pocketMinArea: 0`
   * lets the small gaps between leaves key out along with the big openings.
   */
  const matted = await api("POST", "/v1/matte", {
    sourceAssetId: clip.id,
    backing: [0, 0, 255],
    /*
     * Both tolerances raised well past the default, which is safe here by
     * measurement rather than by nerve: the nearest artwork pixel to pure blue
     * is 138 across the four regions (R3's darkest shadowed leaf) and 175 at
     * best, so 85 and 100 cannot reach the artwork. At the defaults, 0.09% of
     * the finished frame still read as chroma blue — specks in the gaps
     * between leaves where a pixel is half leaf and half backing. Blue against
     * gold is the most visible error available, so it is worth the second pass,
     * and the pass is free.
     */
    tolerance: 85,
    pocketTolerance: 100,
    pocketMinArea: 0,
  });
  const keyed = matted.asset ?? matted;
  const { path: keyedPath } = await api("GET", `/v1/assets/${keyed.id}/path`);
  console.log(
    `  keyed  ${keyed.filename}  ${keyed.width}x${keyed.height}` +
      (matted.report?.backing ? `  backing ${JSON.stringify(matted.report.backing)}` : ""),
  );
  /*
   * Print what the route already worked out.
   *
   * `/v1/matte` computes a `keptMatches` rate precisely to catch backing left
   * behind the subject, and its own source comment says "before, it was in the
   * report and nobody read it". It was in the report again and I did not read
   * it again: the right-centre arch came back a sheet of blue and the number
   * that said so was sitting in the response. Anything a tool takes the
   * trouble to warn about gets printed where the operator is looking.
   */
  for (const warning of matted.warnings ?? []) console.log(`  WARNING ${warning}`);
  if (matted.report) {
    const r = matted.report;
    const rate = r.keptMatches / (r.frames * r.width * r.height);
    console.log(
      `  backing kept ${r.keptMatches} px (${(rate * 100).toFixed(4)}% of the clip)` +
        `  corner spread ${r.backingSpread}`,
    );
  }

  /* Measure before placing: a clip nobody looked at is a clip nobody trusts. */
  const dir = path.join(work, `${region.key}_keyed_frames`);
  await run(ffmpeg, [
    "-v", "error", "-y", "-i", keyedPath,
    "-vf", "fps=4,scale=480:-2", path.join(dir.replace(/\\$/, ""), "f%03d.png"),
  ]).catch(async () => {
    await run("cmd", ["/c", "mkdir", dir]).catch(() => {});
    return run(ffmpeg, [
      "-v", "error", "-y", "-i", keyedPath,
      "-vf", "fps=4,scale=480:-2", path.join(dir, "f%03d.png"),
    ]);
  });
  const scriptPath = path.join(work, "measure_keyed.py");
  await (await import("node:fs/promises")).writeFile(scriptPath, measure, "utf8");
  const report = JSON.parse((await run("python", ["-I", scriptPath, dir])).trim());
  console.log(
    `  alpha kept ${report.alphaKeptPercent}%  amplitude ${report.amplitude}  ` +
      `loop ${report.loopClosure}  leaf area peak ${report.leafAreaPeakPercent}% ` +
      `end ${report.leafAreaEndPercent}%`,
  );

  if (region.reuseItemIds.length) {
    /*
     * Re-point the layers that are already timed and scaled. Same frame size,
     * so the scale `insertRegion` worked out still holds.
     */
    for (const itemId of region.reuseItemIds) {
      await host("replaceFootage", { projectItemId: itemId, path: keyedPath });
    }
    console.log(`  re-pointed ${region.reuseItemIds.length} layers at the keyed clip`);
  } else {
    for (const startSeconds of STARTS) {
      const placed = await host("insertRegion", {
        assetId: keyed.id,
        regionName: region.regionName,
        featherPixels: FEATHER,
        startSeconds,
      });
      console.log(`  inserted at ${startSeconds}s into ${placed.compName}`);
    }
  }
}

if (!apply) console.log("\nNothing was written. Re-run with --apply.");
