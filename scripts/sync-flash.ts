/**
 * Finds the flash in each surface's clip and retimes them to fire together.
 *
 *   npx tsx scripts/sync-flash.ts PROS=a.mov LEFT=b.mov RIGHT=c.mov
 *   npx tsx scripts/sync-flash.ts PROS=a.mov LEFT=b.mov --at 11.5 --apply
 *
 * The art direction asks for "a spectacular, synchronised cascade of festoon
 * lights illuminating the entire panoramic environment" that "must work
 * cohesively across the entire 270 degree projection environment". Each surface
 * is a separate generation, so each invents its own moment for that cascade and
 * nothing in a prompt can make three of them agree. Measured on the approved
 * drafts, they were nearly two seconds apart:
 *
 *   PROS   steepest rise +12.75/frame at 10.75s
 *   RIGHT  steepest rise +18.86/frame at 12.58s
 *   LEFT   steepest rise  +3.11/frame at 12.92s   <- barely a flash at all
 *
 * Two seconds apart on a 270 degree wrap is not a cascade, it is three separate
 * events. So the sync is done here, arithmetically, where it is exact.
 *
 * ## How the flash is found
 *
 * Mean frame luminance, lightly smoothed, then the largest frame-to-frame rise.
 * That is deliberately crude and it is the right crudeness: the flash is by
 * definition the moment the whole picture gets much brighter at once, so the
 * biggest jump in whole-frame brightness is the flash, and nothing subtler is
 * needed. The size of that jump is printed alongside, because it is also the
 * measurement that says whether a clip HAS a flash — the 1080p render that lost
 * it came back at +1.71 against its own draft's +12.75, which is how the loss
 * was caught.
 *
 * ## How they are made to agree
 *
 * Two straight segments per clip, pinned at three points: the clip's own start,
 * its flash, and its end.
 *
 *     comp 0        -> source 0
 *     comp target   -> source flash
 *     comp duration -> source duration
 *
 * Both ends therefore stay exact, which matters for the same reason it mattered
 * on the day-to-night shot: the first frame has to match the night plate the
 * show is holding and the last has to match the approved party artwork. Only
 * the interior is retimed, and only enough to move the flash. The printed
 * before/after speeds say how hard each clip is being pushed; past about 1.3x
 * the retime starts to show in the motion and the honest answer is a re-roll
 * rather than a bigger stretch.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const atFlag = argv.indexOf("--at");
const wantedAt = atFlag >= 0 ? Number(argv[atFlag + 1]) : undefined;
const pairs = argv.filter((a) => a.includes("=") && !a.startsWith("--"));

if (!pairs.length) {
  console.error(
    "usage: sync-flash.ts NAME=clip.mov [NAME=clip.mov ...] [--at 11.5] [--apply]",
  );
  process.exit(2);
}

const token = process.env.SEED_AE_SESSION_TOKEN;
const base = `http://${process.env.SEED_AE_HOST ?? "127.0.0.1"}:${process.env.SEED_AE_PORT ?? "47831"}`;

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
  if (!response.ok) throw new Error(`${name}: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(raw) as {
    ok?: boolean;
    error?: unknown;
    value?: unknown;
  };
  if (parsed.ok === false)
    throw new Error(`${name}: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  return parsed.value ?? parsed;
}

/** Whole-frame mean luminance per frame, at a width nothing needs to exceed. */
async function luminance(
  file: string,
): Promise<{ series: number[]; fps: number }> {
  const probe = spawn(ffmpeg, ["-i", file], { windowsHide: true });
  let info = "";
  probe.stderr.on("data", (c) => (info += String(c)));
  await new Promise<void>((done) => probe.on("close", () => done()));
  const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
  if (!size) throw new Error(`could not read ${file}`);
  const fps = Number((/([\d.]+) fps/.exec(info) ?? ["", "24"])[1]);
  const W = 320;
  const H = Math.max(
    2,
    Math.round((W * Number(size[2])) / Number(size[1])) & ~1,
  );

  const decode = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${W}:${H}`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { windowsHide: true },
  );
  const series: number[] = [];
  let buf = Buffer.alloc(0);
  decode.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= W * H) {
      const frame = buf.subarray(0, W * H);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i]!;
      series.push(sum / frame.length);
      buf = buf.subarray(W * H);
    }
  });
  await new Promise<void>((done, fail) =>
    decode.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exit ${code}`)),
    ),
  );
  return { series, fps };
}

interface Surface {
  name: string;
  file: string;
  fps: number;
  frames: number;
  duration: number;
  flashAt: number;
  rise: number;
}

const surfaces: Surface[] = [];
for (const pair of pairs) {
  const at = pair.indexOf("=");
  const name = pair.slice(0, at);
  const file = pair.slice(at + 1);
  const { series, fps } = await luminance(file);
  if (series.length < 8)
    throw new Error(`only ${series.length} frames from ${file}`);
  // Smoothed, because a codec's frame-to-frame noise is not a flash.
  const smooth = series.map((_, i) => {
    const from = Math.max(0, i - 2);
    const to = Math.min(series.length, i + 3);
    return series.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
  });
  let rise = 0;
  let riseAt = 0;
  for (let i = 1; i < smooth.length; i++) {
    const step = smooth[i]! - smooth[i - 1]!;
    if (step > rise) {
      rise = step;
      riseAt = i;
    }
  }
  const frames = series.length;
  surfaces.push({
    name,
    file,
    fps,
    frames,
    // The last addressable frame, which is what a time remap ends on.
    duration: Math.round(((frames - 1) / fps) * 1000) / 1000,
    flashAt: Math.round((riseAt / fps) * 1000) / 1000,
    rise: Math.round(rise * 100) / 100,
  });
}

console.log(
  `${"surface".padEnd(8)} ${"frames".padStart(6)} ${"flash".padStart(8)} ${"rise".padStart(8)}  reading`,
);
for (const s of surfaces) {
  const reading =
    s.rise > 8
      ? "a real flash"
      : s.rise > 3.5
        ? "weak"
        : "NO FLASH — this clip has nothing to sync";
  console.log(
    `${s.name.padEnd(8)} ${String(s.frames).padStart(6)} ${`${s.flashAt}s`.padStart(8)} ` +
      `${`+${s.rise}`.padStart(8)}  ${reading}`,
  );
}

/*
 * ## Offsetting beats retiming, and the numbers said so
 *
 * The first version of this retimed each clip to put its flash on a shared
 * beat. On these three that meant stretching the tail after the flash by up to
 * 1.46x, because the tail is only two to four seconds long and the flashes were
 * nearly two apart. A 1.46x stretch shows in the motion.
 *
 * Offsetting costs nothing instead. Every one of these clips opens on a held
 * night plate -- the first beat of the art direction is explicitly "the
 * coastal night held exactly as it is" -- so delaying a surface's start just
 * holds that night a moment longer, which is what the surface would be showing
 * anyway. No frame is retimed and no motion is distorted; the slot simply gets
 * longer by the spread between the flashes.
 *
 * So offsets are what this prints. `--retime` asks for the old behaviour, for
 * the case where the slot length is fixed and cannot grow.
 */
const target =
  wantedAt ??
  Math.round(
    (surfaces.reduce((a, s) => a + s.flashAt, 0) / surfaces.length) * 100,
  ) / 100;
console.log(
  `\nflashes fire together at ${target}s${wantedAt === undefined ? " (the mean)" : ""}`,
);

const retime = argv.includes("--retime");

if (!retime) {
  // The latest flash sets the beat; everyone else waits on their night plate.
  const beat = Math.max(...surfaces.map((s) => s.flashAt));
  const slot = Math.max(...surfaces.map((s) => beat - s.flashAt + s.duration));
  console.log(`
no retiming: hold each surface's night plate until its flash lines up`);
  console.log(
    `  the cascade fires at ${Math.round(beat * 100) / 100}s on every surface`,
  );
  console.log(`  the slot runs ${Math.round(slot * 100) / 100}s, from the earliest start to the latest end
`);
  console.log(
    `${"surface".padEnd(8)} ${"start at".padStart(9)} ${"flash".padStart(8)} ${"ends".padStart(8)}`,
  );
  for (const s of surfaces) {
    const offset = Math.round((beat - s.flashAt) * 1000) / 1000;
    console.log(
      `${s.name.padEnd(8)} ${`${offset}s`.padStart(9)} ${`${Math.round(beat * 100) / 100}s`.padStart(8)} ` +
        `${`${Math.round((offset + s.duration) * 100) / 100}s`.padStart(8)}`,
    );
  }
  console.log(
    `
Place each clip at its own start time; nothing is retimed, so no motion is
` + `touched. --retime instead if the slot length cannot grow.`,
  );
  process.exit(0);
}

for (const s of surfaces) {
  const before = s.flashAt / target;
  const after = (s.duration - s.flashAt) / (s.duration - target);
  const keys: Array<[number, number]> = [
    [0, 0],
    [target, s.flashAt],
    [s.duration, s.duration],
  ];
  const hard = Math.max(before, after, 1 / before, 1 / after) > 1.3;
  console.log(
    `\n${s.name}: ${s.flashAt}s -> ${target}s  ` +
      `(${before.toFixed(2)}x then ${after.toFixed(2)}x)${hard ? "  <- pushed hard; consider a re-roll" : ""}`,
  );
  console.log(`  keys ${JSON.stringify(keys)}`);

  if (!apply) continue;
  if (!token) throw new Error("SEED_AE_SESSION_TOKEN is not set");
  const tree = await host("compTree");
  const layer = (tree.layers ?? []).find((l: { name: string }) =>
    l.name.toLowerCase().includes(s.name.toLowerCase()),
  );
  if (!layer) {
    console.log(
      `  no layer in ${tree.comp?.name} whose name contains "${s.name}" — skipped`,
    );
    continue;
  }
  const result = await host("setTimeRemap", { layerIndex: layer.index, keys });
  console.log(
    `  applied to layer ${layer.index} "${layer.name}", ${result.keysApplied} keys`,
  );
}

if (!apply) {
  console.log(
    "\n--apply to write these onto the matching layers in the active comp.",
  );
}
