/**
 * Did the 20s golden-hour-to-night transition actually do what was asked?
 *
 *   npx tsx scripts/check-daynight-transition.ts <clip> --first <day.png> --last <night.png>
 *
 * This is not a loop and none of the loop measurements apply. A transition has
 * its own list of ways to fail, and they are nearly all invisible in a
 * thumbnail and expensive to discover in the comp:
 *
 * 1. **The ends.** The clip is spliced between artwork holding the golden-hour
 *    frame and artwork holding the night frame. If its first frame is not the
 *    one and its last frame the other, there is a jump on a join. Measured in
 *    RGB, per channel, because a night that is the right brightness and the
 *    wrong hue is still wrong and grey cannot see it.
 * 2. **The camera.** Twenty seconds is a long time to ask a model to hold a
 *    lock-off, and a background that drifts two pixels is a background that
 *    cannot be cut against the static set either side of it. Measured as a
 *    translation in pixels, from gradient profiles normalised per frame so
 *    that the brightness change the shot is *for* does not read as movement.
 * 3. **The direction of time.** A timelapse that gets lighter again in the
 *    middle is the commonest way these come back wrong, and it reads as a
 *    cloud passing rather than an error unless it is counted.
 * 4. **The moon.** Asked to rise and leave frame. Whether it did is a
 *    trajectory, not a yes or no, so the trajectory is what gets printed.
 * 5. **The last second.** This is the one worth the whole script. A model
 *    given a last frame to hit will often *freeze* into it, easing to a dead
 *    hold for the final half second, which is exactly what the brief forbids
 *    ("natural wave movement only"). A frozen tail and a clean landing look
 *    identical on every other measurement here.
 * 6. **Its own pacing.** Whether the model ramped the speed itself, which
 *    decides how much of a ramp `setTimeRemap` should add on top. Printed per
 *    second rather than averaged, because an average is exactly the thing that
 *    cannot see a ramp.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);

function isFlagValue(at: number): boolean {
  return at > 0 && (argv[at - 1] ?? "").startsWith("--");
}
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};
const clip = argv.find((a, at) => !a.startsWith("--") && !isFlagValue(at));
const firstPlate = flag("first");
const lastPlate = flag("last");

if (!clip) {
  console.error(
    "usage: check-daynight-transition.ts <clip> [--first day.png] [--last night.png]",
  );
  process.exit(2);
}

/** Working width. A moon is tens of pixels across at this size; enough. */
const W = 640;

async function probe(
  file: string,
): Promise<{ w: number; h: number; fps: number }> {
  const run = spawn(ffmpeg, ["-i", file], { windowsHide: true });
  let info = "";
  run.stderr.on("data", (c) => (info += String(c)));
  await new Promise<void>((done) => run.on("close", () => done()));
  const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
  if (!size) throw new Error(`could not read ${file}`);
  const rate = /([\d.]+) fps/.exec(info);
  return {
    w: Number(size[1]),
    h: Number(size[2]),
    fps: rate ? Number(rate[1]) : 24,
  };
}

/** Decode to raw RGB at a fixed size. One frame for a still, all for a clip. */
async function rgb(
  file: string,
  w: number,
  h: number,
  oneFrame: boolean,
): Promise<Uint8Array[]> {
  const run = spawn(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      file,
      "-vf",
      `scale=${w}:${h}:flags=area`,
      ...(oneFrame ? ["-frames:v", "1"] : []),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { windowsHide: true },
  );
  const frames: Uint8Array[] = [];
  const bytes = w * h * 3;
  let buf = Buffer.alloc(0);
  run.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= bytes) {
      frames.push(new Uint8Array(buf.subarray(0, bytes)));
      buf = buf.subarray(bytes);
    }
  });
  await new Promise<void>((done, fail) => {
    run.on("close", (code) =>
      code === 0 ? done() : fail(new Error(`ffmpeg exit ${code} on ${file}`)),
    );
    run.on("error", fail);
  });
  return frames;
}

const meta = await probe(clip);
const H = Math.max(2, Math.round((W * meta.h) / meta.w) & ~1);
const frames = await rgb(clip, W, H, false);
if (frames.length < 8)
  throw new Error(`only ${frames.length} frames from ${clip}`);
const fps = meta.fps;
const seconds = frames.length / fps;

console.log(
  `${path.basename(clip)}   ${meta.w}x${meta.h} @ ${fps}fps   ` +
    `${frames.length} frames = ${seconds.toFixed(2)}s`,
);

/** Rec.709 luma of pixel `i` (pixel index, not byte offset). */
const luma = (f: Uint8Array, i: number): number =>
  0.2126 * f[i * 3]! + 0.7152 * f[i * 3 + 1]! + 0.0722 * f[i * 3 + 2]!;

function greyOf(f: Uint8Array): Float32Array {
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = luma(f, i);
  return g;
}

// ---------------------------------------------------------------- 1. the ends

/** Per-channel mean absolute error between a frame and a plate. */
function channelError(
  a: Uint8Array,
  b: Uint8Array,
): { r: number; g: number; b: number; all: number; p99: number } {
  let r = 0;
  let g = 0;
  let bl = 0;
  const sample: number[] = [];
  const n = W * H;
  for (let i = 0; i < n; i++) {
    const dr = Math.abs(a[i * 3]! - b[i * 3]!);
    const dg = Math.abs(a[i * 3 + 1]! - b[i * 3 + 1]!);
    const db = Math.abs(a[i * 3 + 2]! - b[i * 3 + 2]!);
    r += dr;
    g += dg;
    bl += db;
    if (i % 5 === 0) sample.push((dr + dg + db) / 3);
  }
  sample.sort((x, y) => x - y);
  return {
    r: r / n,
    g: g / n,
    b: bl / n,
    all: (r + g + bl) / (3 * n),
    p99: sample[Math.floor(sample.length * 0.99)] ?? 0,
  };
}

console.log(
  "\n-- the ends: does it start and finish on the artwork either side --",
);
for (const [label, plate, frame] of [
  ["first frame vs day plate  ", firstPlate, frames[0]!],
  ["last frame  vs night plate", lastPlate, frames[frames.length - 1]!],
] as const) {
  if (!plate) {
    console.log(`  ${label}  (not given)`);
    continue;
  }
  const [still] = await rgb(plate, W, H, true);
  if (!still) throw new Error(`no pixels from ${plate}`);
  const e = channelError(frame, still);
  const reading =
    e.all < 6
      ? "lands on it"
      : e.all < 14
        ? "close; look at the join at 100%"
        : "DOES NOT LAND - there will be a jump on this join";
  console.log(
    `  ${label}  mean ${e.all.toFixed(2)}  (R ${e.r.toFixed(1)} G ${e.g.toFixed(1)} ` +
      `B ${e.b.toFixed(1)})  p99 ${e.p99.toFixed(0)}  -> ${reading}`,
  );
}

// ------------------------------------------------------------- 2. the camera

/**
 * Normalised gradient profiles, which is what makes this brightness-proof.
 *
 * Summing |dI/dx| down each column gives a signature of where the vertical
 * structure is. Normalising it to zero mean and unit norm removes any global
 * gain, so the sunset dimming by two stops does not register as a move.
 */
function normalise(v: Float32Array): Float32Array {
  let mean = 0;
  for (const value of v) mean += value;
  mean /= v.length;
  let norm = 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i]! - mean;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

function profiles(g: Float32Array): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(W);
  const y = new Float32Array(H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W - 1; col++) {
      const d = Math.abs(g[row * W + col + 1]! - g[row * W + col]!);
      x[col] = x[col]! + d;
      y[row] = y[row]! + d;
    }
  }
  return { x: normalise(x), y: normalise(y) };
}

/** Best integer shift of `b` against `a`, and how well it then matches. */
function bestShift(
  a: Float32Array,
  b: Float32Array,
  limit: number,
): { shift: number; peak: number } {
  let shift = 0;
  let peak = -Infinity;
  for (let s = -limit; s <= limit; s++) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + s;
      if (j < 0 || j >= b.length) continue;
      dot += a[i]! * b[j]!;
    }
    if (dot > peak) {
      peak = dot;
      shift = s;
    }
  }
  return { shift, peak };
}

const base = profiles(greyOf(frames[0]!));
const limit = 16;
let worstDx = 0;
let worstDy = 0;
let worstPeak = 1;
const drift: Array<{ at: number; dx: number; dy: number }> = [];
for (let f = 0; f < frames.length; f += Math.max(1, Math.round(fps / 2))) {
  const p = profiles(greyOf(frames[f]!));
  const x = bestShift(base.x, p.x, limit);
  const y = bestShift(base.y, p.y, limit);
  drift.push({ at: f / fps, dx: x.shift, dy: y.shift });
  if (Math.abs(x.shift) > Math.abs(worstDx)) worstDx = x.shift;
  if (Math.abs(y.shift) > Math.abs(worstDy)) worstDy = y.shift;
  worstPeak = Math.min(worstPeak, Math.min(x.peak, y.peak));
}
/** Back to the clip's own pixels, since the measurement happened at W wide. */
const scale = meta.w / W;
console.log("\n-- the camera: is it actually locked off for twenty seconds --");
console.log(
  `  worst drift  x ${(worstDx * scale).toFixed(1)}px  y ${(worstDy * scale).toFixed(1)}px ` +
    `(of ${meta.w}x${meta.h})`,
);
console.log(
  `  structure match at worst  ${worstPeak.toFixed(3)}  (1.0 = identical layout)`,
);
const moved = Math.abs(worstDx * scale) > 2 || Math.abs(worstDy * scale) > 2;
console.log(
  moved
    ? "  -> THE CAMERA MOVED. This cannot be cut against a static set."
    : worstPeak < 0.6
      ? "  -> no translation, but the layout changed: suspect a zoom or a redraw."
      : "  -> locked off.",
);
if (moved) {
  console.log(
    `     ${drift
      .filter((d) => d.dx || d.dy)
      .slice(0, 8)
      .map((d) => `${d.at.toFixed(1)}s:${d.dx},${d.dy}`)
      .join("  ")}`,
  );
}

// ------------------------------------------------- 3. the direction of time

const brightness = frames.map((f) => {
  let sum = 0;
  for (let i = 0; i < W * H; i++) sum += luma(f, i);
  return sum / (W * H);
});
let reversals = 0;
let worstBack = 0;
/** Smoothed, because frame-to-frame noise is not a change of direction. */
const smooth = brightness.map((_, i) => {
  const from = Math.max(0, i - 2);
  const to = Math.min(brightness.length, i + 3);
  return brightness.slice(from, to).reduce((a, b) => a + b, 0) / (to - from);
});
for (let i = 1; i < smooth.length; i++) {
  const step = smooth[i]! - smooth[i - 1]!;
  if (step > 0.05) {
    reversals++;
    worstBack = Math.max(worstBack, step);
  }
}
console.log("\n-- the direction of time: does it only ever get darker --");
console.log(
  `  brightness ${brightness[0]!.toFixed(1)} -> ${brightness[brightness.length - 1]!.toFixed(1)} ` +
    `(${(100 * (1 - brightness[brightness.length - 1]! / brightness[0]!)).toFixed(0)}% darker)`,
);
console.log(
  `  frames that got lighter  ${reversals} of ${frames.length}  worst step ${worstBack.toFixed(2)}`,
);
console.log(
  reversals > frames.length * 0.12
    ? "  -> it brightens back up repeatedly; this is not one sunset."
    : "  -> monotonic enough to read as a single sunset.",
);

// ---------------------------------------------------------------- 4. the moon

/**
 * The brightest compact thing in the upper part of frame, per second.
 *
 * Reported as a trajectory with a size, not as a yes/no: a tight blob that
 * climbs and then leaves is a moon, and a wide low-contrast one that sits
 * still is the sky itself or a lamp, and the difference is the spread.
 */
console.log("\n-- the moon: did it rise, cross, and leave --");
const skyRows = Math.round(H * 0.6);
const track: Array<{
  at: number;
  x: number;
  y: number;
  n: number;
  spread: number;
  peak: number;
}> = [];
for (let f = 0; f < frames.length; f += Math.round(fps)) {
  const frame = frames[f]!;
  const values: number[] = [];
  for (let i = 0; i < skyRows * W; i++) values.push(luma(frame, i));
  const sorted = [...values].sort((a, b) => b - a);
  const cut = sorted[Math.max(0, Math.floor(sorted.length * 0.0005))]!;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < skyRows * W; i++) {
    if (values[i]! < cut) continue;
    sx += i % W;
    sy += Math.floor(i / W);
    n++;
  }
  if (!n) continue;
  const cx = sx / n;
  const cy = sy / n;
  let spread = 0;
  for (let i = 0; i < skyRows * W; i++) {
    if (values[i]! < cut) continue;
    const dx = (i % W) - cx;
    const dy = Math.floor(i / W) - cy;
    spread += Math.sqrt(dx * dx + dy * dy);
  }
  track.push({
    at: f / fps,
    x: Math.round((100 * cx) / W),
    y: Math.round((100 * cy) / skyRows),
    n,
    spread: Math.round(spread / n),
    peak: Math.round(sorted[0]!),
  });
}
for (const t of track) {
  console.log(
    `  ${String(t.at.toFixed(0)).padStart(3)}s  at ${String(t.x).padStart(3)}% across, ` +
      `${String(t.y).padStart(3)}% down the sky   peak ${String(t.peak).padStart(3)}  ` +
      `spread ${String(t.spread).padStart(4)}px  ${t.spread < 40 ? "compact" : "diffuse"}`,
  );
}
const compact = track.filter((t) => t.spread < 40);
console.log(
  compact.length < 3
    ? "  -> no compact bright disc for most of the shot; read as no moon, or a diffuse glow."
    : `  -> a compact source for ${compact.length} of ${track.length} samples; it travelled ` +
        `${Math.abs((compact[compact.length - 1]?.x ?? 0) - (compact[0]?.x ?? 0))}% across and ` +
        `${Math.abs((compact[compact.length - 1]?.y ?? 0) - (compact[0]?.y ?? 0))}% down.`,
);

// --------------------------------------------- 5 & 6. pacing, and the tail

/**
 * How much changes from frame to frame, per second.
 *
 * Two questions off one series. Its shape says whether the model ramped the
 * speed itself; its last value says whether the shot is still alive at the end
 * or has frozen into the last frame it was told to hit.
 */
const change: number[] = [];
for (let f = 1; f < frames.length; f++) {
  const a = frames[f - 1]!;
  const b = frames[f]!;
  let sum = 0;
  for (let i = 0; i < W * H; i++) sum += Math.abs(luma(b, i) - luma(a, i));
  change.push(sum / (W * H));
}
const perSecond: number[] = [];
for (let s = 0; s * fps < change.length; s++) {
  const slice = change.slice(Math.round(s * fps), Math.round((s + 1) * fps));
  if (slice.length)
    perSecond.push(slice.reduce((a, b) => a + b, 0) / slice.length);
}
console.log("\n-- pacing: how fast it moves, second by second --");
const peakChange = Math.max(...perSecond);
for (let s = 0; s < perSecond.length; s++) {
  const bar = "#".repeat(
    Math.max(1, Math.round((28 * perSecond[s]!) / peakChange)),
  );
  console.log(
    `  ${String(s).padStart(2)}-${String(s + 1).padStart(2)}s  ` +
      `${perSecond[s]!.toFixed(2).padStart(6)}  ${bar}`,
  );
}

const tailFrames = Math.max(2, Math.round(fps));
const tail = change.slice(-tailFrames);
const tailMean = tail.reduce((a, b) => a + b, 0) / tail.length;
const middle = change.slice(
  Math.round(change.length * 0.4),
  Math.round(change.length * 0.6),
);
const middleMean = middle.reduce((a, b) => a + b, 0) / middle.length;
const lastTen = change.slice(-10);
const stillest = Math.min(...lastTen);
console.log("\n-- the last second: is the shot still alive when it lands --");
console.log(
  `  change in the final second ${tailMean.toFixed(3)}  against ${middleMean.toFixed(3)} ` +
    `mid-shot (${((100 * tailMean) / middleMean).toFixed(0)}%)`,
);
console.log(`  quietest of the last ten frames ${stillest.toFixed(3)}`);
console.log(
  stillest < 0.08
    ? "  -> IT FREEZES. The tail holds a dead frame, which the brief forbids; either " +
        "re-roll, or trim the hold and let the wave loop carry the landing."
    : tailMean < middleMean * 0.08
      ? "  -> very nearly frozen; check the waves at 100% before approving."
      : "  -> still moving at the landing.",
);

const ramped =
  perSecond[0]! < peakChange * 0.6 &&
  perSecond[perSecond.length - 1]! < peakChange * 0.6;
console.log(
  `\n-- its own ramp --\n  ${
    ramped
      ? "the model ramped the speed itself; add less in After Effects."
      : "flat or front-loaded pacing; the ramp has to come from setTimeRemap."
  }`,
);
