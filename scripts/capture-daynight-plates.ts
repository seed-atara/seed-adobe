/**
 * Grabs the two end frames of the golden-hour-to-night transition from AE.
 *
 *   npx tsx scripts/capture-daynight-plates.ts [--layer Night_layer] [--dry]
 *   npx tsx scripts/capture-daynight-plates.ts --size 720p
 *
 * The artist's setup is the whole trick and it belongs to them: the golden-hour
 * elements are freeze-framed, and a night version of the same set sits on top
 * of them at zero opacity. So the start frame is simply what is on screen, and
 * the end frame is the same comp with that one layer turned up. Two captures of
 * one comp, in perfect register by construction, which is a far better
 * guarantee than two renders of two comps could give.
 *
 * ## What this changes in the project, and what it puts back
 *
 * Exactly one property: the night layer's opacity, up to 100 and back to
 * whatever it was. The restore runs in a `finally`, so a capture that throws
 * still puts the layer back — an opacity left at 100 would be a silently
 * wrecked comp, and the artist would find it rather than be told.
 *
 * `setTransform` refuses a property that is already keyframed or driven by an
 * expression unless it is told to replace it, and that refusal is not worked
 * around here. If the night layer's opacity is animated, that is somebody's
 * animation and this script stops rather than overwrite it.
 *
 * ## Why the plates come back resized
 *
 * Measured on the party-city wall, and the single largest effect found on this
 * project: of four regions, the only one that composited invisibly was the one
 * whose plate was already the generation's own output size. Over the feather
 * band its seam was mean 2.43 against 7.60, 15.57 and 17.64 for the three the
 * model had to resample, and re-sending one of those at exactly 1920x1080 took
 * it from 15.57 to 6.10. Upscaling a plate adds no information, but it hands
 * the model the grid it is going to work on, and a first frame it has to
 * resample is a first frame it has re-interpreted rather than held.
 *
 * It also keeps the request small enough to send. No R2 publisher is
 * configured on this box, so every reference travels as an inline base64 data
 * URI; a full-frame projection plate is tens of megabytes of JSON and five
 * generations died in transport before that was understood.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aspectFits } from "../packages/domain/src/animate.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const flag = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};
const layerName = flag("layer", "Night_layer");
const size = flag("size", "720p");

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

/** The pixel budget of each tier, which is what a generation actually spends. */
const TIER_PIXELS: Record<string, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
};

async function host(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw) as { ok?: boolean; error?: unknown; value?: unknown };
  // The host answers HTTP 200 for its own refusals too; checking only the
  // status is how an earlier script reported "placed" three times for nothing.
  if (parsed.ok === false) throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  return parsed.value ?? parsed;
}

async function api(route: string, body: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${route}: ${raw.slice(0, 400)}`);
  return JSON.parse(raw);
}

// ------------------------------------------------------------ the comp itself

const context = await host("getContext");
const compName = String(context.compName ?? context.comp?.name ?? "(unknown)");
const compWidth = Number(context.compWidth ?? context.comp?.width ?? 0);
const compHeight = Number(context.compHeight ?? context.comp?.height ?? 0);
const playhead = Number(context.timeSeconds ?? context.time ?? 0);

console.log(`comp "${compName}"  ${compWidth}x${compHeight}  playhead ${playhead.toFixed(3)}s`);

if (!compWidth || !compHeight) {
  console.log(JSON.stringify(context).slice(0, 800));
  throw new Error("could not read the comp's size from getContext");
}

/*
 * The shape question, before anything is spent. `adaptive` does not mean "the
 * plate's own shape" -- it means the nearest aspect Seedance returns, cropped
 * to. That cost $12 on the proscenium background, which is 2.04:1, was sent at
 * `adaptive`, and came back 16:9 with 370px taken off each side.
 */
const shape = aspectFits(compWidth, compHeight);
console.log(`  aspect ${shape.aspect}:1  nearest Seedance shape ${shape.crop.nearest}`);
if (shape.why) console.log(`  ! ${shape.why}`);
if (shape.warn) console.log(`  ! ${shape.warn}`);

// ------------------------------------------------- find the night layer

const tree = await host("compTree");
const layers: Array<{ index: number; name: string; enabled?: boolean }> = Array.isArray(tree.layers)
  ? tree.layers
  : Array.isArray(tree)
    ? tree
    : [];
if (!layers.length) {
  console.log(JSON.stringify(tree).slice(0, 1200));
  throw new Error("compTree returned no layers");
}
console.log(`\n${layers.length} layers:`);
for (const layer of layers.slice(0, 40)) {
  console.log(`  ${String(layer.index).padStart(3)}  ${layer.name}${layer.enabled === false ? "  (off)" : ""}`);
}

const night = layers.find((l) => l.name.toLowerCase() === layerName.toLowerCase());
if (!night) {
  throw new Error(
    `no layer called "${layerName}" in ${compName}. Pass --layer with the real name.`,
  );
}
console.log(`\nnight layer: ${night.index}  ${night.name}`);

if (dry) {
  console.log("\n--dry: nothing captured, nothing changed.");
  process.exit(0);
}

// --------------------------------------------------------------- the captures

/** Resize a capture onto the generation's own grid, 4:4:4 so no chroma loss. */
async function toGrid(from: string, to: string, w: number, h: number): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const run = spawn(
    ffmpeg,
    [
      "-v", "error", "-y", "-i", from,
      "-vf", `scale=${w}:${h}:flags=lanczos`,
      "-q:v", "2", "-pix_fmt", "yuvj444p",
      to,
    ],
    { windowsHide: true },
  );
  const errors: string[] = [];
  run.stderr.on("data", (c) => errors.push(String(c)));
  await new Promise<void>((done, fail) =>
    run.on("close", (code) =>
      code === 0 ? done() : fail(new Error(errors.join("").slice(0, 400) || `ffmpeg exit ${code}`)),
    ),
  );
}

const pixels = TIER_PIXELS[size.toLowerCase()];
if (!pixels) throw new Error(`${size} is not a tier this sends (480p, 720p, 1080p)`);
/*
 * The generation's own output size for this plate's shape, which is what the
 * plate is resized to. A tier is a pixel budget spent in the requested aspect,
 * so this is `sqrt` of the budget over the area, applied to both edges, rounded
 * to even numbers because every encoder in the chain wants them.
 */
const factor = Math.sqrt(pixels / (compWidth * compHeight));
const gridW = Math.round((compWidth * factor) / 2) * 2;
const gridH = Math.round((compHeight * factor) / 2) * 2;
console.log(
  `\nplates will be sent at ${gridW}x${gridH} ` +
    `(${size}'s ${pixels.toLocaleString()} pixels in this comp's shape, ${factor.toFixed(3)}x)`,
);

const work = path.join(root, ".work", "daynight");
let restored = false;

try {
  console.log("\n1/2  capturing the golden-hour set as it stands");
  const day = await host("captureFrame");
  const dayPath = String(day.asset?.storageUri ?? day.path ?? day.asset?.path ?? "");
  console.log(`     ${day.asset?.id ?? "(no id)"}  ${dayPath}`);
  if (day.warning) console.log(`     ! ${day.warning}`);

  console.log(`\n2/2  turning ${night.name} up to 100% and capturing the night set`);
  await host("setTransform", { layerIndex: night.index, property: "opacity", value: 100 });
  const nightCapture = await host("captureFrame");
  const nightPath = String(
    nightCapture.asset?.storageUri ?? nightCapture.path ?? nightCapture.asset?.path ?? "",
  );
  console.log(`     ${nightCapture.asset?.id ?? "(no id)"}  ${nightPath}`);
  if (nightCapture.warning) console.log(`     ! ${nightCapture.warning}`);

  // Put it back before anything else can fail.
  await host("setTransform", { layerIndex: night.index, property: "opacity", value: 0 });
  restored = true;
  console.log(`\n     ${night.name} back to 0% opacity`);

  console.log("\nresizing both onto the generation grid and adopting them");
  const out: Array<{ label: string; assetId: string; file: string }> = [];
  for (const [label, source] of [
    ["day", dayPath],
    ["night", nightPath],
  ] as const) {
    if (!source) throw new Error(`the ${label} capture did not report a path`);
    const file = path.join(work, `${label}_${gridW}x${gridH}.jpg`);
    await toGrid(source, file, gridW, gridH);
    const adopted = await api("/v1/assets/adopt", { path: file });
    const assetId = String(adopted.asset?.id ?? adopted.id ?? "");
    out.push({ label, assetId, file });
    console.log(`  ${label.padEnd(5)}  ${assetId}  ${path.basename(file)}`);
  }

  console.log(
    `\nready. generate with:\n  npx tsx scripts/animate-golden-to-night.ts ` +
      `--day ${out[0]!.assetId} --night ${out[1]!.assetId} --size ${size} --dry`,
  );
} finally {
  if (!restored) {
    /*
     * The capture failed somewhere after the opacity went up. Putting it back
     * matters more than the error that got us here, so this is attempted and
     * its own failure is reported loudly rather than thrown over the top of
     * the original.
     */
    try {
      await host("setTransform", { layerIndex: night.index, property: "opacity", value: 0 });
      console.error(`\n(${night.name} restored to 0% opacity after the failure above)`);
    } catch (error) {
      console.error(
        `\n!! ${night.name} IS STILL AT 100% OPACITY and could not be restored: ` +
          `${(error as Error).message}\n!! set it back by hand before saving the project.`,
      );
    }
  }
}
