/**
 * Grades a captured frame or clip against the test chart.
 *
 *   npx tsx scripts/check-capture.ts captured.png
 *   npx tsx scripts/check-capture.ts captured.mov
 *
 * Answers the questions that are otherwise a matter of opinion:
 *
 *   - did full range survive, or was it squeezed into 16–235?
 *   - did the one-pixel chroma comb survive, or was it averaged into mud?
 *   - is the shadow gradient smooth, or banded into 8-bit steps?
 *
 * A clip is decoded with ffprobe/ffmpeg first, so the same check works on a
 * capture and on a generated result.
 */
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { decodeJpegPreview, decodePng, type RasterImage } from "@seed-ae/media";

const run = promisify(execFile);

const input = process.argv[2];
if (!input) {
  console.error("usage: npx tsx scripts/check-capture.ts <file.png|file.mov|file.mp4>");
  process.exit(2);
}

/** Frame fractions, matching make-test-chart.ts. */
const REGIONS = {
  ramp: 0.08,
  patches: 0.22,
  comb: 0.4,
  shadow: 0.62,
} as const;
const EXPECTED_PATCHES = [0, 16, 128, 235, 255];

async function loadFrame(file: string): Promise<RasterImage> {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".png" || extension === ".jpg" || extension === ".jpeg") {
    const bytes = await readFile(file);
    const image = decodePng(bytes) ?? decodeJpegPreview(bytes);
    if (!image) throw new Error(`could not decode ${file}`);
    return image;
  }

  /*
   * A clip is decoded to PNG through ffmpeg, and deliberately *without*
   * asking for a range conversion: the point is to see what is in the file,
   * not what a player would show. `-color_range` is left alone for the same
   * reason.
   */
  const temporary = path.join(path.dirname(file), `.seed-check-${Date.now()}.png`);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file,
    "-frames:v", "1", "-pix_fmt", "rgb24", "-y", temporary]);
  try {
    const image = decodePng(await readFile(temporary));
    if (!image) throw new Error("ffmpeg produced a PNG that could not be decoded");
    return image;
  } finally {
    await rm(temporary, { force: true });
  }
}

function luma(image: RasterImage, x: number, y: number): number {
  const at = (Math.round(y) * image.width + Math.round(x)) * 4;
  const r = image.rgba[at] ?? 0;
  const g = image.rgba[at + 1] ?? 0;
  const b = image.rgba[at + 2] ?? 0;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rowMiddle(image: RasterImage, fraction: number): number {
  return Math.round(fraction * image.height + image.height * 0.04);
}

const image = await loadFrame(input);
console.log(`${path.basename(input)} — ${image.width}x${image.height}\n`);

let failures = 0;
const verdict = (ok: boolean, label: string, detail: string) => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(28)} ${detail}`);
};

/* -------------------------------------------------- range ---------------- */

const rampRow = rowMiddle(image, REGIONS.ramp);
let rampMin = 255;
let rampMax = 0;
for (let x = 0; x < image.width; x += 1) {
  const value = luma(image, x, rampRow);
  rampMin = Math.min(rampMin, value);
  rampMax = Math.max(rampMax, value);
}
verdict(
  rampMin <= 4 && rampMax >= 251,
  "full range survived",
  `ramp spans ${rampMin.toFixed(0)}..${rampMax.toFixed(0)} (want ~0..255; ` +
    `16..235 means it was squeezed to legal range)`,
);

const patchRow = rowMiddle(image, REGIONS.patches);
const measured = EXPECTED_PATCHES.map((_, index) => {
  const centre = ((index + 0.5) / EXPECTED_PATCHES.length) * image.width;
  return luma(image, centre, patchRow);
});
const patchDrift = measured.map((value, index) =>
  Math.abs(value - (EXPECTED_PATCHES[index] as number)),
);
verdict(
  Math.max(...patchDrift) <= 6,
  "known patches unmoved",
  measured.map((v, i) => `${EXPECTED_PATCHES[i]}→${v.toFixed(0)}`).join("  "),
);

/* -------------------------------------------------- chroma --------------- */

const combRow = rowMiddle(image, REGIONS.comb);
let separation = 0;
let samples = 0;
for (let x = 2; x < image.width - 2; x += 2) {
  const at = (combRow * image.width + x) * 4;
  const next = (combRow * image.width + x + 1) * 4;
  // Red column against blue column: 4:4:4 keeps them apart, 4:2:0 blends them.
  const redHere = (image.rgba[at] ?? 0) - (image.rgba[at + 2] ?? 0);
  const blueNext = (image.rgba[next + 2] ?? 0) - (image.rgba[next] ?? 0);
  separation += redHere + blueNext;
  samples += 2;
}
const meanSeparation = samples > 0 ? separation / samples : 0;
verdict(
  meanSeparation > 120,
  "1px chroma comb survived",
  `mean R/B separation ${meanSeparation.toFixed(0)} of 255 ` +
    `(4:2:0 collapses toward 0; 4:4:4 stays high)`,
);

/* -------------------------------------------------- banding -------------- */

const shadowRow = rowMiddle(image, REGIONS.shadow);
const steps = new Set<number>();
for (let x = 0; x < image.width; x += 1) {
  steps.add(Math.round(luma(image, x, shadowRow)));
}
verdict(
  steps.size >= 30,
  "shadow gradient not banded",
  `${steps.size} distinct levels across 0..32 ` +
    `(8-bit gives ~33; far fewer means it was quantised on the way)`,
);

console.log(
  failures === 0
    ? "\nEverything the chart can see came through intact."
    : `\n${failures} check(s) failed — see docs/product/QUALITY_TEST.md for what each means.`,
);
process.exit(failures === 0 ? 0 : 1);
