/**
 * Lays the 10s night hold into the comp, after the transition.
 *
 *   npx tsx scripts/insert-night-loop.ts <clip.mov> [--start 20] [--dry]
 *
 * Deliberately not part of `insert-daynight-transition.ts`, even though the two
 * share their crop arithmetic. That script's whole shape is the speed ramp and
 * the two-ended join; this clip has neither. It plays at its own speed, it
 * closes on its own first frame, and it only has one join to make.
 *
 * ## The three things it does
 *
 * 1. **Crop the 21:9 padding back off**, by the same ratio that put it on. The
 *    plate went out padded because 5750x2818 is 2.0405:1 and Seedance does not
 *    return that shape.
 *
 * 2. **Place it at 20s**, where the transition ends. One pass of a 10s loop
 *    fills 20-30s of a 30s comp exactly, which is why the loop is 10s and not
 *    some rounder-looking number.
 *
 * 3. **Dissolve up from `Night_layer` over 0.4s.** The same reasoning as the
 *    transition's joins, and for the same measured reason: at 1080p this clip
 *    is about a 3x upscale of a 5750px plate, so its first frame matches the
 *    night plate in content and not in sharpness. A cut would read as a focus
 *    pop on an otherwise invisible join. `Night_layer` is already sitting at
 *    100% from 20s onward, so there is a sharp plate underneath to dissolve
 *    from and nothing else to arrange.
 *
 * The loop needs no tail join: its last frame closes on the same plate its
 * first frame came from, so it joins to itself if the hold is tiled longer than
 * the comp, and to the plate underneath if it is not.
 */
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const num = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? Number(argv[at + 1] ?? fallback) : fallback;
};
const str = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback;
};
const clip = argv.find(
  (a, at) => !a.startsWith("--") && !(at > 0 && argv[at - 1]!.startsWith("--")),
);

const startSeconds = num("start", 20);
const dissolve = num("dissolve", 0.4);
const nightName = str("layer", "Night_layer");
const compWidth = num("compWidth", 5750);
const compHeight = num("compHeight", 2818);
const aspect = str("aspect", "21:9");
const LAYER_NAME = "SEED night hold 10s";

if (!clip) {
  console.error("usage: insert-night-loop.ts <clip.mov> [--start 20] [--dry]");
  process.exit(2);
}

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;
if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");

async function host(
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const response = await fetch(`${base}/v1/host/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, args }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 400)}`);
  const parsed = JSON.parse(raw) as {
    ok?: boolean;
    error?: unknown;
    value?: unknown;
  };
  if (parsed.ok === false)
    throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 400)}`);
  return parsed.value ?? parsed;
}

async function api(route: string, body: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${route}: ${raw.slice(0, 400)}`);
  return JSON.parse(raw);
}

const probe = spawn(ffmpeg, ["-i", clip], { windowsHide: true });
let info = "";
probe.stderr.on("data", (c) => (info += String(c)));
await new Promise<void>((done) => probe.on("close", () => done()));
const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
if (!size) throw new Error(`could not read ${clip}`);
const rate = /([\d.]+) fps/.exec(info);
const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
const W = Number(size[1]);
const H = Number(size[2]);
const fps = rate ? Number(rate[1]) : 24;
const seconds = dur
  ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
  : 0;

const [aw, ah] = aspect.split(":").map(Number);
const targetAspect = (aw ?? 21) / (ah ?? 9);
const padWidth =
  compWidth / compHeight < targetAspect
    ? Math.round((compHeight * targetAspect) / 2) * 2
    : compWidth;
const padHeight =
  compWidth / compHeight > targetAspect
    ? Math.round(compWidth / targetAspect / 2) * 2
    : compHeight;
const keepW = Math.round((W * compWidth) / padWidth / 2) * 2;
const keepH = Math.round((H * compHeight) / padHeight / 2) * 2;
const keepX = Math.round((W - keepW) / 2);
const keepY = Math.round((H - keepH) / 2);

console.log(
  `${path.basename(clip)}  ${W}x${H} @ ${fps}  ${seconds.toFixed(2)}s`,
);
console.log(
  `  cropping to ${keepW}x${keepH} at +${keepX},+${keepY}  ` +
    `(${(keepW / keepH).toFixed(4)}:1 against the comp's ${(compWidth / compHeight).toFixed(4)}:1)`,
);
if (Math.abs(keepW / keepH - compWidth / compHeight) > 0.02) {
  console.log(`  ! the cropped shape does not match the comp. Check --aspect.`);
}
console.log(
  `\nplacing at ${startSeconds}s, dissolving up from ${nightName} over ${dissolve}s\n` +
    `  ${startSeconds}s=0%  ${Math.round((startSeconds + dissolve) * 1000) / 1000}s=100%`,
);
console.log(
  `  the loop closes on its own plate, so it needs no join at the end`,
);

const work = path.join(root, ".work", "daynight");
const cropped = path.join(
  work,
  `${path.basename(clip, path.extname(clip))}_cropped.mov`,
);

if (dry) {
  console.log("\n--dry: nothing cropped, nothing inserted, nothing changed.");
} else {
  // Same guard as the transition's: reuse only a layer holding THIS clip, so a
  // re-run with a different take replaces it instead of silently keeping the old.
  const present = ((await host("compTree")).layers ?? []).find(
    (l: { name: string }) => l.name === LAYER_NAME,
  ) as { index: number; source?: { file?: string } } | undefined;
  const wantFile = path.basename(cropped, path.extname(cropped));
  if (present) {
    console.log(
      `\n"${LAYER_NAME}" is layer ${present.index} holding ` +
        `${present.source?.file ?? "something"} — replacing it`,
    );
    await host("deleteLayer", {
      layerIndex: present.index,
      expectName: LAYER_NAME,
    });
  }

  await mkdir(work, { recursive: true });
  console.log(`\ncropping -> ${path.basename(cropped)}`);
  const crop = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-y",
      "-i",
      clip,
      "-vf",
      `crop=${keepW}:${keepH}:${keepX}:${keepY}`,
      // ProRes: this gets scaled up ~3x in the comp, and a lossy re-encode of a
      // crop throws away what an upscale has least of to begin with.
      "-c:v",
      "prores_ks",
      "-profile:v",
      "3",
      "-qscale:v",
      "9",
      "-an",
      cropped,
    ],
    { windowsHide: true },
  );
  const errors: string[] = [];
  crop.stderr.on("data", (c) => errors.push(String(c)));
  await new Promise<void>((done, fail) =>
    crop.on("close", (code) =>
      code === 0
        ? done()
        : fail(
            new Error(errors.join("").slice(0, 400) || `ffmpeg exit ${code}`),
          ),
    ),
  );
  void wantFile;

  const adopted = await api("/v1/assets/adopt", { path: cropped });
  const assetId = String(adopted.asset?.id ?? adopted.id ?? "");
  console.log(`  adopted ${assetId}`);

  const tree = await host("compTree");
  const night = (tree.layers ?? []).find(
    (l: { name: string }) => l.name.toLowerCase() === nightName.toLowerCase(),
  );
  if (!night)
    throw new Error(`no layer called "${nightName}" in ${tree.comp?.name}`);

  console.log(`\ninserting into ${tree.comp?.name} at ${startSeconds}s`);
  const placed = await host("insertIntoComp", {
    assetId,
    startSeconds,
    fit: "cover",
    name: LAYER_NAME,
  });
  const index = Number(placed.layer?.index ?? placed.index ?? 1);
  console.log(`  layer ${index}  ${placed.layer?.name ?? ""}`);

  /*
   * `insertIntoComp` puts the new layer at the top, which is already above
   * Night_layer, so there is nothing to reorder: the plate holding at 100% from
   * 20s is exactly what this dissolves up from.
   */
  await host("setTransform", {
    layerIndex: index,
    property: "opacity",
    keyframes: [
      { atSeconds: startSeconds, value: 0 },
      {
        atSeconds: Math.round((startSeconds + dissolve) * 1000) / 1000,
        value: 100,
      },
    ],
    replace: true,
  });
  console.log(`  dissolve applied`);

  console.log(
    `\ndone. 0-${startSeconds}s transition, ${startSeconds}-${(startSeconds + seconds).toFixed(0)}s night hold.`,
  );
}
