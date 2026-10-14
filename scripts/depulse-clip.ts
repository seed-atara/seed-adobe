/**
 * Takes a global exposure pulse out of a clip, leaving the lamps flickering.
 *
 *   npx tsx scripts/depulse-clip.ts <in.mp4> <out.mov>
 *
 * Asked for lanterns that flicker gently, Seedance sometimes dims and
 * brightens the whole picture instead. On region 6 of the GYG party-city wall
 * that was a 35% swing with the lit pixels and the mid-tone walls correlated at
 * **+0.99** — the hillside breathing as one, which is not what a flickering
 * lamp looks like and is very obviously wrong on a projection.
 *
 * Two prompt attempts failed to stop it, and the second was a clean
 * single-variable test: the same plate, the same everything, only the beats
 * rewritten to name individual lamps taking turns, and the result was 35.4%
 * against 35.7%. Identical. The wording is not the lever.
 *
 * ## So fix it arithmetically, where it is actually tractable
 *
 * A global pulse is a near-uniform gain on every pixel, and a gain is
 * invertible. For each frame, measure the mean of the **mid-tones** — the walls
 * and the stone, above the crushed blacks and below the lamps — and scale the
 * frame so that mean returns to the first frame's. The walls are what must hold
 * still, so they are what the correction is anchored to.
 *
 * Anchoring on the mid-tones rather than the whole frame is the entire trick.
 * The lit pixels are ~3% of a night plate, so normalising the overall mean
 * would mostly work too, but normalising the *walls* specifically means a lamp
 * that genuinely brightens against a steady wall survives the correction, which
 * is the thing being rescued. The global component cancels; the per-lamp
 * residual is what is left.
 *
 * This cannot invent a flicker that was never generated. If the clip's lamps
 * only ever moved with the rest of the picture, the result is a steady clip
 * rather than a flickering one — which is still better than a pulsing one, and
 * `check-partycity-loops.ts` will say which happened.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

if (!input || !output) {
  console.error("usage: depulse-clip.ts <in.mp4> <out.mov>");
  process.exit(2);
}

const probe = spawn(ffmpeg, ["-i", input], { windowsHide: true });
let info = "";
probe.stderr.on("data", (c) => (info += String(c)));
await new Promise<void>((done) => probe.on("close", () => done()));
const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
const rate = /([\d.]+) fps/.exec(info);
if (!size) throw new Error(`could not read ${input}`);
const W = Number(size[1]);
const H = Number(size[2]);
const fps = rate ? Number(rate[1]) : 24;
const frameBytes = W * H * 3;

console.log(`${path.basename(input)}  ${W}x${H} @ ${fps}`);

const decode = spawn(
  ffmpeg,
  ["-v", "error", "-i", input, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
  { windowsHide: true },
);
const encode = spawn(
  ffmpeg,
  [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${W}x${H}`, "-r", String(fps),
    "-i", "-",
    // ProRes rather than H.264: this clip goes into a comp, and re-encoding a
    // correction through a lossy codec gives back some of what was corrected.
    "-c:v", "prores_ks", "-profile:v", "3", "-qscale:v", "9", "-an",
    output,
  ],
  { windowsHide: true },
);

const frame = Buffer.alloc(frameBytes);
let filled = 0;
let frames = 0;
/** The mid-tone mask and target, both taken from the first frame. */
let mask: Uint8Array | undefined;
let target = 0;
const gains: number[] = [];
const errors: string[] = [];
encode.stderr.on("data", (c) => errors.push(String(c)));
decode.stderr.on("data", (c) => errors.push(String(c)));
encode.stdin.on("error", () => {
  // The encoder's exit code carries the real reason; EPIPE here would hide it.
});

function luma(buf: Buffer, p: number): number {
  return 0.2126 * buf[p]! + 0.7152 * buf[p + 1]! + 0.0722 * buf[p + 2]!;
}

await new Promise<void>((resolve, reject) => {
  const fail = (cause: unknown): void =>
    reject(cause instanceof Error ? cause : new Error(String(cause)));
  decode.on("error", fail);
  encode.on("error", fail);

  decode.stdout.on("data", (chunk: Buffer) => {
    let at = 0;
    while (at < chunk.length) {
      const take = Math.min(frameBytes - filled, chunk.length - at);
      chunk.copy(frame, filled, at, at + take);
      filled += take;
      at += take;
      if (filled !== frameBytes) continue;

      if (!mask) {
        // Percentiles of the first frame decide what counts as a wall.
        const all: number[] = [];
        for (let p = 0; p < frameBytes; p += 3) all.push(luma(frame, p));
        const sorted = [...all].sort((a, b) => a - b);
        const lo = sorted[Math.floor(sorted.length * 0.3)]!;
        const hi = sorted[Math.floor(sorted.length * 0.85)]!;
        mask = new Uint8Array(all.length);
        let sum = 0;
        let n = 0;
        for (let i = 0; i < all.length; i++) {
          if (all[i]! > lo && all[i]! < hi) {
            mask[i] = 1;
            sum += all[i]!;
            n++;
          }
        }
        target = n ? sum / n : 1;
        console.log(`  anchored on ${n} mid-tone pixels at mean ${target.toFixed(2)}`);
      }

      let sum = 0;
      let n = 0;
      for (let i = 0, p = 0; p < frameBytes; i++, p += 3) {
        if (mask[i] === 1) {
          sum += luma(frame, p);
          n++;
        }
      }
      const mean = n ? sum / n : target;
      const gain = mean > 0.5 ? target / mean : 1;
      gains.push(gain);

      if (Math.abs(gain - 1) > 0.0005) {
        for (let p = 0; p < frameBytes; p++) {
          const v = frame[p]! * gain;
          frame[p] = v > 255 ? 255 : v < 0 ? 0 : Math.round(v);
        }
      }

      frames++;
      encode.stdin.write(Buffer.from(frame));
      filled = 0;
    }
  });

  decode.stdout.on("end", () => encode.stdin.end());
  encode.on("close", (code) =>
    code === 0
      ? resolve()
      : fail(new Error(errors.join("").slice(0, 500) || `exit ${code}`)),
  );
});

const lo = Math.min(...gains);
const hi = Math.max(...gains);
console.log(
  `  ${frames} frames, gain ${lo.toFixed(3)}-${hi.toFixed(3)} ` +
    `(the pulse this removed was ${((hi / lo - 1) * 100).toFixed(1)}% of wall brightness)`,
);
