/**
 * Clamps the four region clips and composites them back onto the proscenium.
 *
 *   npx tsx scripts/finish-pros-state2.ts              prints the plan
 *   npx tsx scripts/finish-pros-state2.ts --apply      clamps, imports, inserts
 *   npx tsx scripts/finish-pros-state2.ts --apply --only R3
 *
 * Three steps per region, and the first is the one that matters.
 *
 * 1. **Clamp.** The clip is an opaque rectangle of the assembled plate, so it
 *    carries its own version of the sea and sky. Clamped to `FG_Object`'s alpha
 *    it carries only the foreground, and the background clip shows through the
 *    rest — which is what makes "nothing in the foreground moves but the leaves"
 *    true, and what stops four rectangles of frozen water appearing in an
 *    animated sea. Out as ProRes 4444 so After Effects reads the alpha with no
 *    effects on the layer.
 * 2. **Insert**, three times, at 0s, 10s and 20s. The clip is a 10s loop and the
 *    comp is 30s. Three inserts rather than `repeatToFill` because that works on
 *    the active composition, and making a sub-comp active means a full-frame
 *    render of a 5750x2818 plate on the way back.
 * 3. **Feather** is left at the capture's own 24px, which is also the width of
 *    the matte's falloff ring — the two edges are the same edge.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planClampAlpha } from "../packages/media/src/clampAlpha.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const apply = process.argv.includes("--apply");
const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;

const FEATHER = 24;
const STARTS = [0, 10, 20];

interface Region {
  key: string;
  regionName: string;
  clipAssetId: string;
  /** The clip's real frame size, read off the asset record. */
  width: number;
  height: number;
}

const REGIONS: Region[] = [
  {
    key: "R1",
    regionName: "SEED Region 1",
    clipAssetId: "ast_deb1bf1f-e5ee-45d0-8b06-2929491f3935",
    width: 1440,
    height: 1440,
  },
  {
    key: "R2",
    regionName: "SEED Region 2",
    clipAssetId: "ast_ac6de776-042f-4f82-b0a3-1f3097410036",
    width: 1440,
    height: 1440,
  },
  {
    key: "R3",
    regionName: "SEED Region 3",
    clipAssetId: "ast_47e888f9-e268-4651-a8e6-8764572fb8ba",
    width: 1080,
    height: 1920,
  },
  {
    key: "R4",
    regionName: "SEED Region 4",
    clipAssetId: "ast_445d7ca1-18ec-4eb0-a604-892b76950965",
    width: 1080,
    height: 1920,
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
  if (!response.ok) {
    throw new Error(`${method} ${route}: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload;
}

/** One host command, failing loudly rather than returning something unusable. */
async function host(name: string, args: Record<string, unknown>): Promise<any> {
  const payload = await api("POST", "/v1/host/run", { name, args });
  if (!payload.ok) throw new Error(`${name}: ${payload.error}`);
  return payload.value;
}

const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const work = path.join(root, ".work", "pros-state2");
const chosen = only ? REGIONS.filter((r) => r.key === only) : REGIONS;

for (const region of chosen) {
  const { path: clip } = await api("GET", `/v1/assets/${region.clipAssetId}/path`);
  const matte = path.join(work, `matte_${region.key}.png`);
  const output = path.join(work, `${region.key}_clamped.mov`);

  const plan = planClampAlpha({
    input: clip,
    matte,
    output,
    width: region.width,
    height: region.height,
  });

  console.log(
    `\n${region.key}  ${region.regionName}\n` +
      `  clip   ${path.basename(clip)}  ${region.width}x${region.height}\n` +
      `  matte  ${path.basename(matte)}\n` +
      `  out    ${path.relative(root, output)}  ProRes 4444 ${plan.width}x${plan.height}`,
  );
  if (!apply) continue;

  const code = await new Promise<number>((resolve) => {
    const run = spawn(ffmpeg, plan.args, { windowsHide: true });
    let err = "";
    run.stderr.on("data", (c) => (err += String(c)));
    run.on("close", (status) => {
      if (status !== 0) console.log(`  ffmpeg failed: ${err.slice(0, 400)}`);
      resolve(status ?? 1);
    });
  });
  if (code !== 0) continue;

  const { asset } = await api("POST", "/v1/assets/adopt", { path: output });
  console.log(`  adopted ${asset.id}  ${asset.width}x${asset.height}  ${asset.duration ?? "?"}s`);

  /*
   * Three inserts, one per loop pass. Each re-imports the same file, which
   * leaves duplicate project items behind — the tidy script files them, and
   * that is cheaper than making a sub-comp active to use `repeatToFill`.
   */
  for (const startSeconds of STARTS) {
    const placed = await host("insertRegion", {
      assetId: asset.id,
      regionName: region.regionName,
      featherPixels: FEATHER,
      startSeconds,
    });
    console.log(
      `  inserted at ${startSeconds}s into ${placed.compName}  ` +
        `${placed.sourceWidth}x${placed.sourceHeight} -> ${placed.width}x${placed.height}` +
        `  feather ${placed.featherPixels}px`,
    );
  }
}

if (!apply) console.log("\nNothing was written. Re-run with --apply.");
