/**
 * Does each party-city loop actually hold, and does it actually flicker?
 *
 *   npx tsx scripts/check-partycity-loops.ts <clip.mp4> [more.mp4 ...]
 *
 * Three numbers, because this brief has three ways to fail and they are not
 * the same failure:
 *
 * - **Loop closure** — the last frame against the first. Three passes tile the
 *   30s comp, so a clip that does not come back to its opening state shows a
 *   jump twice, at 10s and 20s.
 * - **Flicker** — whether the lamps did anything at all. The standard prompt
 *   tail used to end "no stuttering or flickering", which on a street of
 *   lanterns reads as a ban on the brief, so "did the lights move" is a thing
 *   to measure and not assume. Measured only on the pixels that are *already
 *   bright*, because that is where a flame is.
 * - **Stillness** — whether the masonry stayed put. The risk with a brightness
 * - **Correlation** - and this is the one that caught region 6. A brightness
 *   swing measured only on lit pixels looks identical whether one lamp
 *   flickered or the whole picture dimmed. The sign of the correlation between
 *   the lit pixels and the mid-tone walls tells them apart: the three clips
 *   that read correctly came back at -0.79 to -0.86, lamps brightening while
 *   the stone around them did not, and the one that was a global exposure
 *   pulse came back at +0.96. Measured, because the first version of this
 *   script could not see it and passed the clip.
 *   licence is that the model applies it to the whole frame, and a wall that
 *   breathes is worse than a wall that does nothing.
 *
 * Decode to raw grey at a reduced width; nothing here needs full resolution and
 * a 4K decode of four clips is minutes of nothing.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const clips = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!clips.length) {
  console.error("usage: check-partycity-loops.ts <clip.mp4> [more.mp4 ...]");
  process.exit(2);
}

/** Working width. Big enough to see a lantern, small enough to be free. */
const W = 480;

async function greyFrames(file: string): Promise<{ frames: Uint8Array[]; h: number }> {
  // Height follows the clip's own aspect; -2 keeps it even for the scaler.
  const probe = spawn(ffmpeg, ["-i", file], { windowsHide: true });
  let info = "";
  probe.stderr.on("data", (c) => (info += String(c)));
  await new Promise<void>((done) => probe.on("close", () => done()));
  const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
  if (!size) throw new Error(`could not read ${file}`);
  const h = Math.max(2, Math.round((W * Number(size[2])) / Number(size[1])) & ~1);

  const decode = spawn(
    ffmpeg,
    ["-v", "error", "-i", file, "-vf", `scale=${W}:${h}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
    { windowsHide: true },
  );
  const frames: Uint8Array[] = [];
  const bytes = W * h;
  let buf = Buffer.alloc(0);
  decode.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= bytes) {
      frames.push(new Uint8Array(buf.subarray(0, bytes)));
      buf = buf.subarray(bytes);
    }
  });
  await new Promise<void>((done, fail) => {
    decode.on("close", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exit ${code}`))));
    decode.on("error", fail);
  });
  return { frames, h };
}

function meanAbs(a: Uint8Array, b: Uint8Array, mask?: (i: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask(i)) continue;
    sum += Math.abs(a[i]! - b[i]!);
    n++;
  }
  return n ? sum / n : 0;
}

console.log(
  `${"clip".padEnd(28)} ${"frames".padStart(6)} ${"closure".padStart(8)} ` +
    `${"flicker".padStart(8)} ${"still".padStart(7)} ${"swing".padStart(7)} ` +
    `${"corr".padStart(6)}  reading`,
);

for (const clip of clips) {
  const { frames } = await greyFrames(clip);
  if (frames.length < 3) {
    console.log(`${path.basename(clip).padEnd(28)} ${String(frames.length).padStart(6)}  too short`);
    continue;
  }
  const first = frames[0]!;
  const last = frames[frames.length - 1]!;

  // Where the lamps are: bright in the opening frame. The flames and the pools
  // of light they cast are the top few percent of a night plate.
  const sorted = Uint8Array.from(first).sort();
  const brightAt = sorted[Math.floor(sorted.length * 0.97)]!;
  const isBright = (i: number): boolean => first[i]! >= brightAt;
  const isDark = (i: number): boolean => first[i]! < brightAt;

  /*
   * Closure is measured over the bright pixels too. A night plate is mostly
   * dark, so a whole-frame average is dominated by sky that never changes and
   * reads as a perfect loop whatever the lamps did.
   */
  const closure = meanAbs(first, last, isBright);

  // Flicker: mean frame-to-frame change on the lit pixels across the clip.
  let flicker = 0;
  let still = 0;
  for (let f = 1; f < frames.length; f++) {
    flicker += meanAbs(frames[f - 1]!, frames[f]!, isBright);
    still += meanAbs(frames[f - 1]!, frames[f]!, isDark);
  }
  flicker /= frames.length - 1;
  still /= frames.length - 1;

  /*
   * Lit against mid-tone, over the whole clip. The mid-tones are the wall and
   * the stone: above the crushed blacks, below the lamps. If they rise and
   * fall *with* the lamps, the model dimmed the picture instead of the lamps.
   */
  const lo = sorted[Math.floor(sorted.length * 0.3)]!;
  const hi = sorted[Math.floor(sorted.length * 0.85)]!;
  const isMid = (i: number): boolean => first[i]! > lo && first[i]! < hi;
  const litSeries = frames.map((f) => mean(f, isBright));
  const midSeries = frames.map((f) => mean(f, isMid));
  const corr = correlation(litSeries, midSeries);
  const share = (xs: number[]): number =>
    (100 * (Math.max(...xs) - Math.min(...xs))) / (xs.reduce((a, b) => a + b, 0) / xs.length);
  const swing = share(litSeries);
  const reading =
    corr > 0.8 && share(midSeries) > swing * 0.4 ? "GLOBAL EXPOSURE PULSE" : "per-lamp";

  console.log(
    `${path.basename(clip).padEnd(28)} ${String(frames.length).padStart(6)} ` +
      `${closure.toFixed(2).padStart(8)} ${flicker.toFixed(2).padStart(8)} ` +
      `${still.toFixed(2).padStart(7)} ${`${swing.toFixed(1)}%`.padStart(7)} ` +
      `${corr.toFixed(2).padStart(6)}  ${reading}`,
  );
}

function mean(frame: Uint8Array, keep: (i: number) => boolean): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frame.length; i++) {
    if (!keep(i)) continue;
    sum += frame[i]!;
    n++;
  }
  return n ? sum / n : 0;
}

function correlation(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

console.log(
  "\nclosure: last frame vs first, on lit pixels — under ~2 tiles without a seen jump." +
    "\nflicker: mean frame-to-frame change on lit pixels — near 0 means the lamps never moved." +
    "\nstill:   the same on everything else — well under flicker, or the whole wall is breathing." +
    "\nswing:   peak-to-trough lamp brightness as a share of its mean. GENTLE is a few percent." +
    "\ncorr:    lit pixels against the mid-tone walls. NEGATIVE is right — lamps brighten" +
    "\n         while the stone does not. Positive and large means the picture dimmed, not the lamps.",
);
