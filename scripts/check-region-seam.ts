/**
 * Will this clip composite into its plate invisibly, or read as a patch?
 *
 *   npx tsx scripts/check-region-seam.ts <plate.png> <clip.mp4> [--band 24]
 *
 * A region cut from a painted wall has no alpha: the generated rectangle
 * replaces that rectangle of the painting, and the only thing hiding the join
 * is the composite's feather. So the question is not "is the clip good" but "is
 * the clip the same as the plate *at the boundary*", every frame, because the
 * artwork outside the region never changes.
 *
 * This is the measurement that overturned a judgement. Four party-city clips
 * all looped cleanly, all held their geometry, and three of the four read as
 * acceptable on every other metric. Measured over the feather band they came
 * back at mean 2.33 / p99 14 (fine), 7.60 / 67, 15.57 / 88 and 17.63 / 135 —
 * and the worst of them was *worse at its edge than in its middle*, which is
 * the signature of a patch and is invisible in the clip on its own.
 *
 * The interior figure is printed beside it on purpose. A clip may legitimately
 * differ from its plate in the middle — that is the motion that was paid for.
 * What it may not do is differ at the edge, and comparing the two numbers is
 * what tells a moving picture from a misregistered one.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const bandAt = args.indexOf("--band");
const band = bandAt >= 0 ? Number(args[bandAt + 1]) : 24;
const [plate, clip] = positional;

if (!plate || !clip) {
  console.error("usage: check-region-seam.ts <plate.png> <clip.mp4> [--band 24]");
  process.exit(2);
}

/** Decode anything to raw grey at a given size. */
async function grey(file: string, width: number, height: number, oneFrame: boolean): Promise<Uint8Array[]> {
  const run = spawn(
    ffmpeg,
    [
      "-v", "error", "-i", file,
      "-vf", `scale=${width}:${height}`,
      ...(oneFrame ? ["-frames:v", "1"] : []),
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { windowsHide: true },
  );
  const frames: Uint8Array[] = [];
  const bytes = width * height;
  let buf = Buffer.alloc(0);
  run.stdout.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= bytes) {
      frames.push(new Uint8Array(buf.subarray(0, bytes)));
      buf = buf.subarray(bytes);
    }
  });
  await new Promise<void>((done, fail) => {
    run.on("close", (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exit ${code} on ${file}`))));
    run.on("error", fail);
  });
  return frames;
}

/** The plate's own size, which is the size the comparison happens at. */
const probe = spawn(ffmpeg, ["-i", plate], { windowsHide: true });
let info = "";
probe.stderr.on("data", (c) => (info += String(c)));
await new Promise<void>((done) => probe.on("close", () => done()));
const size = /, (\d{2,5})x(\d{2,5})/.exec(info);
if (!size) throw new Error(`could not read ${plate}`);
const W = Number(size[1]);
const H = Number(size[2]);

const [plateFrame] = await grey(plate, W, H, true);
if (!plateFrame) throw new Error(`no pixels from ${plate}`);
const frames = await grey(clip, W, H, false);
if (!frames.length) throw new Error(`no frames from ${clip}`);

/** True for the feather band: the outer `band` pixels on all four sides. */
const inBand = (i: number): boolean => {
  const y = Math.floor(i / W);
  const x = i % W;
  return y < band || y >= H - band || x < band || x >= W - band;
};

let seamSum = 0;
let seamN = 0;
let insideSum = 0;
let insideN = 0;
let worstFrame = 0;
const seamValues: number[] = [];

for (const frame of frames) {
  let frameSum = 0;
  let frameN = 0;
  for (let i = 0; i < frame.length; i++) {
    const d = Math.abs(frame[i]! - plateFrame[i]!);
    if (inBand(i)) {
      seamSum += d;
      seamN++;
      frameSum += d;
      frameN++;
      // Sampled, so the percentile does not need the whole clip in memory.
      if (i % 7 === 0) seamValues.push(d);
    } else {
      insideSum += d;
      insideN++;
    }
  }
  worstFrame = Math.max(worstFrame, frameN ? frameSum / frameN : 0);
}

seamValues.sort((a, b) => a - b);
const p99 = seamValues[Math.floor(seamValues.length * 0.99)] ?? 0;
const seamMean = seamN ? seamSum / seamN : 0;
const insideMean = insideN ? insideSum / insideN : 0;

console.log(`${path.basename(clip)}  vs  ${path.basename(plate)}   ${W}x${H}, ${frames.length} frames`);
console.log(`  seam (outer ${band}px):  mean ${seamMean.toFixed(2)}  p99 ${p99}  worst frame ${worstFrame.toFixed(2)}`);
console.log(`  interior:              mean ${insideMean.toFixed(2)}`);
console.log(
  seamMean > insideMean
    ? "  -> WORSE AT THE EDGE THAN IN THE MIDDLE. This reads as a patch; a feather will not hide it."
    : seamMean < 4
      ? "  -> registers with the plate; the feather has something to blend."
      : "  -> borderline; look at the boundary at 100% before placing it.",
);
