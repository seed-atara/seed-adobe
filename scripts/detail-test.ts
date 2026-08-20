/**
 * Test kit for SEED Frequency Detailer.
 *
 *   npx tsx scripts/detail-test.ts make --out D:/tests
 *   npx tsx scripts/detail-test.ts check D:/tests <ae-export.png>
 *
 * The core is covered by its own tests. What is not covered, and cannot be
 * from a test runner, is the After Effects glue: the world-to-float
 * conversion, the parameter reading, the second layer's checkout, the
 * premultiply round trip. So this grades an export from After Effects against
 * the core's own answer for the same input — if they differ, the glue is
 * wrong, and the difference says by how much.
 *
 * The pair is built so the right answer is knowable: `soft.png` is `plate.png`
 * blurred by a known amount, so "did detail come back" is a measurement rather
 * than an impression.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { decodePng, encodePng, type RasterImage } from "@seed-ae/media";

const run = promisify(execFile);

const mode = process.argv[2];
const WIDTH = 768;
const HEIGHT = 768;

/** The separation radius the test uses, as the effect's percentage. */
const RADIUS_PERCENT = 0.4;
/** The blur that fakes a soft render, in pixels. */
const SOFT_SIGMA = 2.5;

/* ------------------------------------------------------------------ make -- */

function plateImage(): RasterImage {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);

  /*
   * Three things a detail transfer has to cope with, side by side:
   *
   *   - fine texture on a smooth ramp, which is the thing being carried
   *   - a hard edge, where a ratio haloes if it is going to
   *   - a near-black patch, where the divide explodes if it is going to
   */
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 4;

      // A smooth vertical ramp, so detail is tested at every brightness.
      let base = 0.08 + 0.85 * (y / (HEIGHT - 1));

      // The left third is deliberately near black.
      if (x < WIDTH / 3) base = Math.min(base, 0.02);

      // A hard vertical edge two thirds across.
      if (x > (WIDTH * 2) / 3) base = Math.min(1, base + 0.35);

      // Fine texture everywhere, multiplicative so its contrast is relative.
      const checker = ((x >> 1) + (y >> 1)) % 2 === 0 ? 1.12 : 0.88;
      const speckle = ((x * 7 + y * 13) % 11) / 11 > 0.7 ? 1.06 : 1.0;
      const value = Math.max(0, Math.min(1, base * checker * speckle));

      const byte = Math.round(value * 255);
      rgba[at] = byte;
      rgba[at + 1] = byte;
      rgba[at + 2] = byte;
      rgba[at + 3] = 255;
    }
  }
  return { width: WIDTH, height: HEIGHT, rgba };
}

/** A separable box blur, three passes — the same shape the plugin's is. */
function blur(image: RasterImage, sigma: number): RasterImage {
  const boxes = boxSizes(sigma, 3);
  let current = image;
  for (const width of boxes) {
    current = boxPass(current, (width - 1) / 2, true);
    current = boxPass(current, (width - 1) / 2, false);
  }
  return current;
}

function boxSizes(sigma: number, passes: number): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / passes + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower -= 1;
  const upper = lower + 2;
  const mIdeal =
    (12 * sigma * sigma - passes * lower * lower - 4 * passes * lower - 3 * passes) /
    (-4 * lower - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: passes }, (_, i) => (i < m ? lower : upper));
}

function boxPass(src: RasterImage, radius: number, horizontal: boolean): RasterImage {
  if (radius < 1) return src;
  const out = new Uint8Array(src.rgba.length);
  const outer = horizontal ? src.height : src.width;
  const inner = horizontal ? src.width : src.height;
  const at = (a: number, b: number) =>
    (horizontal ? b * src.width + a : a * src.width + b) * 4;

  for (let o = 0; o < outer; o += 1) {
    for (let c = 0; c < 4; c += 1) {
      let sum = 0;
      for (let i = -radius; i <= radius; i += 1) {
        sum += src.rgba[at(Math.max(0, Math.min(inner - 1, i)), o) + c] ?? 0;
      }
      const span = radius * 2 + 1;
      for (let i = 0; i < inner; i += 1) {
        out[at(i, o) + c] = Math.round(sum / span);
        const drop = src.rgba[at(Math.max(0, i - radius), o) + c] ?? 0;
        const add = src.rgba[at(Math.min(inner - 1, i + radius + 1), o) + c] ?? 0;
        sum += add - drop;
      }
    }
  }
  return { width: src.width, height: src.height, rgba: out };
}

async function make(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const plate = plateImage();
  const soft = blur(plate, SOFT_SIGMA);

  await writeFile(path.join(outDir, "detail-plate.png"), encodePng(WIDTH, HEIGHT, plate.rgba));
  await writeFile(path.join(outDir, "detail-soft.png"), encodePng(WIDTH, HEIGHT, soft.rgba));
  await writeFile(path.join(outDir, "detail-plate.raw"), Buffer.from(plate.rgba));
  await writeFile(path.join(outDir, "detail-soft.raw"), Buffer.from(soft.rgba));

  console.log(`wrote ${outDir}`);
  console.log("  detail-plate.png   the sharp plate — the detail source");
  console.log(`  detail-soft.png    the same image blurred by sigma ${SOFT_SIGMA}`);
  console.log("  (.raw copies alongside, for the reference render)\n");
  console.log(`Both ${WIDTH}x${HEIGHT}. See docs/product/DETAILER_TEST.md.`);
}

/* ----------------------------------------------------------------- check -- */

function meanAbsDiff(a: RasterImage, b: RasterImage): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      sum += Math.abs((a.rgba[i + c] ?? 0) - (b.rgba[i + c] ?? 0));
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

function worstDiff(a: RasterImage, b: RasterImage): number {
  let worst = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      worst = Math.max(worst, Math.abs((a.rgba[i + c] ?? 0) - (b.rgba[i + c] ?? 0)));
    }
  }
  return worst;
}

/**
 * How much fine detail a frame carries.
 *
 * The mean absolute difference from its own blur — high for a sharp image,
 * near zero for a soft one. It is the quantity the whole effect exists to put
 * back, so it is the one to report.
 */
function detailEnergy(image: RasterImage): number {
  const soft = blur(image, 2.0);
  return meanAbsDiff(image, soft);
}

async function check(dir: string, exportPath: string): Promise<void> {
  const plate = decodePng(await readFile(path.join(dir, "detail-plate.png")));
  const soft = decodePng(await readFile(path.join(dir, "detail-soft.png")));
  const actual = decodePng(await readFile(exportPath));
  if (!plate || !soft || !actual) throw new Error("could not decode the inputs");

  if (actual.width !== WIDTH || actual.height !== HEIGHT) {
    throw new Error(
      `the export is ${actual.width}x${actual.height}; it must be ${WIDTH}x${HEIGHT} ` +
        "— render the comp at full resolution, no scaling",
    );
  }

  // The core's answer for the same pair, at the documented settings.
  const reference = path.join(dir, "detail-reference.raw");
  const exe = path.resolve(
    "plugins/seed-frequency-detailer/build/detailref.exe",
  );
  await run(exe, [
    path.join(dir, "detail-plate.raw"),
    path.join(dir, "detail-soft.raw"),
    reference,
    String(WIDTH),
    String(HEIGHT),
    `radius=${RADIUS_PERCENT / 100}`,
    "gain=1",
    "replace=0.7",
    "luma=1",
    "linear=1",
    "shadow=0.02",
    "highlight=0.3",
    "limit=4",
    "guard=0",
    "tolerance=0.3",
    "mix=1",
  ]);
  const expected: RasterImage = {
    width: WIDTH,
    height: HEIGHT,
    rgba: new Uint8Array(await readFile(reference)),
  };

  let failures = 0;
  const verdict = (ok: boolean, label: string, detail: string) => {
    if (!ok) failures += 1;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(30)} ${detail}`);
  };

  const plateDetail = detailEnergy(plate);
  const softDetail = detailEnergy(soft);
  const actualDetail = detailEnergy(actual);
  const recovered =
    plateDetail > softDetail
      ? (actualDetail - softDetail) / (plateDetail - softDetail)
      : 0;

  console.log(`${path.basename(exportPath)} — ${actual.width}x${actual.height}\n`);
  console.log(
    `detail energy: plate ${plateDetail.toFixed(2)}, soft ${softDetail.toFixed(2)}, ` +
      `yours ${actualDetail.toFixed(2)}\n`,
  );

  verdict(
    recovered > 0.4,
    "detail came back",
    `${(recovered * 100).toFixed(0)}% of what the blur removed ` +
      `(0% means nothing happened; the source layer is the usual cause)`,
  );

  const mean = meanAbsDiff(actual, expected);
  const worst = worstDiff(actual, expected);
  verdict(
    mean < 3,
    "matches the core",
    `mean ${mean.toFixed(2)}, worst ${worst} code values ` +
      `(a large mean means the plugin is not computing what the core does)`,
  );

  verdict(
    meanAbsDiff(actual, soft) > 1,
    "the effect did something",
    `mean difference from the untouched soft plate ${meanAbsDiff(actual, soft).toFixed(2)}`,
  );

  console.log(
    failures === 0
      ? "\nThe plugin computes what the core computes."
      : `\n${failures} check(s) failed — see docs/product/DETAILER_TEST.md.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ main -- */

if (mode === "make") {
  const outIndex = process.argv.indexOf("--out");
  await make(outIndex > 0 ? (process.argv[outIndex + 1] as string) : ".");
} else if (mode === "check") {
  const dir = process.argv[3];
  const exportPath = process.argv[4];
  if (!dir || !exportPath) {
    console.error("usage: detail-test.ts check <dir> <ae-export.png>");
    process.exit(2);
  }
  await check(dir, exportPath);
} else {
  console.error(
    "usage:\n" +
      "  npx tsx scripts/detail-test.ts make --out D:/tests\n" +
      "  npx tsx scripts/detail-test.ts check D:/tests <ae-export.png>",
  );
  process.exit(2);
}
