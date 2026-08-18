/**
 * Whether a clip is *really* 10-bit, or 8-bit wearing a 10-bit container.
 *
 *   npx tsx scripts/check-depth.ts clip.mov
 *   npx tsx scripts/check-depth.ts clip.mov --region 0.1,0.05,0.4,0.35
 *
 * `ffprobe` reports the pixel format, which says what the file *claims*. That
 * is necessary and not sufficient: an 8-bit source encoded into a 10-bit
 * container reports `yuv444p10le` and still only ever contains 256 distinct
 * values, spaced four apart. The claim and the content are different
 * questions.
 *
 * So this extracts the frame at 16 bits and counts what is actually there. A
 * genuinely 10-bit gradient lands on values that are not multiples of four;
 * an upscaled 8-bit one cannot.
 *
 * A screenshot cannot answer this, which is why the script takes a file. PNG
 * screen captures are 8-bit by construction, so banding seen in one may belong
 * to the capture rather than the clip.
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const input = process.argv[2];
if (!input) {
  console.error("usage: npx tsx scripts/check-depth.ts <clip> [--region x,y,w,h]");
  process.exit(2);
}

/** Fractions of the frame. Defaults to the upper-left, usually sky or wall. */
const regionArg = process.argv.includes("--region")
  ? (process.argv[process.argv.indexOf("--region") + 1] as string)
  : "0.05,0.05,0.4,0.35";
const [rx, ry, rw, rh] = regionArg.split(",").map(Number) as [
  number, number, number, number,
];

async function probe(): Promise<Record<string, string>> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries",
    "stream=pix_fmt,bits_per_raw_sample,codec_name,profile,color_range,width,height",
    "-of", "json", input as string,
  ]);
  const stream = (JSON.parse(stdout).streams ?? [{}])[0] as Record<string, string>;
  return stream;
}

const stream = await probe();
const width = Number(stream.width ?? 0);
const height = Number(stream.height ?? 0);
const claimed = /10|12|16/.test(stream.pix_fmt ?? "") ? "more than 8-bit" : "8-bit";

console.log(`${path.basename(input)}`);
console.log(`  codec      ${stream.codec_name ?? "?"} ${stream.profile ?? ""}`);
console.log(`  pix_fmt    ${stream.pix_fmt ?? "?"}   (claims ${claimed})`);
console.log(`  range      ${stream.color_range ?? "unset"}`);
console.log(`  size       ${width}x${height}`);

const cropW = Math.max(2, Math.round(width * rw));
const cropH = Math.max(2, Math.round(height * rh));
const cropX = Math.round(width * rx);
const cropY = Math.round(height * ry);

/*
 * Extracted as 16-bit greyscale so nothing is quantised on the way out. Asking
 * ffmpeg for 8-bit here would destroy the very evidence being looked for.
 */
const raw = path.join(path.dirname(input as string), `.seed-depth-${Date.now()}.raw`);
await run("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-i", input as string,
  "-frames:v", "1",
  "-vf", `crop=${cropW}:${cropH}:${cropX}:${cropY},format=gray16le`,
  "-f", "rawvideo", "-y", raw,
]);

let values: number[];
try {
  const bytes = await readFile(raw);
  values = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) values.push(bytes.readUInt16LE(i));
} finally {
  await rm(raw, { force: true });
}

const distinct = new Set(values);
// Looped rather than spread: a 1080p region is a million samples, and
// Math.min(...values) overflows the call stack long before it overflows
// anything else.
let min = Infinity;
let max = -Infinity;
for (const value of values) {
  if (value < min) min = value;
  if (value > max) max = value;
}

/*
 * The tell. 16-bit extraction scales everything up, so what matters is the
 * spacing between neighbouring distinct values. True 10-bit content lands on a
 * fine lattice; 8-bit content promoted to 10 leaves gaps four times as wide,
 * whatever the container says.
 */
const sorted = [...distinct].sort((a, b) => a - b);
const gaps: number[] = [];
for (let i = 1; i < sorted.length; i += 1) gaps.push((sorted[i] as number) - (sorted[i - 1] as number));
gaps.sort((a, b) => a - b);
const medianGap = gaps.length ? (gaps[Math.floor(gaps.length / 2)] as number) : 0;

// 16-bit steps per code value at each depth.
const stepFor = (bits: number) => 65535 / (Math.pow(2, bits) - 1);
const effectiveBits = medianGap > 0 ? Math.log2(65535 / medianGap + 1) : 16;

console.log(`\n  region     ${cropW}x${cropH} at ${cropX},${cropY}`);
console.log(`  distinct   ${distinct.size} levels, ${min}..${max} (16-bit scale)`);
console.log(`  median gap ${medianGap}  (8-bit would be ~${stepFor(8).toFixed(0)}, 10-bit ~${stepFor(10).toFixed(0)})`);
console.log(`  effective  ~${effectiveBits.toFixed(1)} bits`);

const genuinely10 = medianGap > 0 && medianGap < stepFor(8) * 0.6;
console.log(
  `\n${genuinely10 ? "PASS" : "FAIL"}  ${
    genuinely10
      ? "finer than 8-bit — the extra depth carries real values"
      : "spacing matches 8-bit content, whatever the container claims"
  }`,
);
process.exit(genuinely10 ? 0 : 1);
