/**
 * Writes a test chart that makes range, chroma and bit depth visible.
 *
 *   npx tsx scripts/make-test-chart.ts
 *   npx tsx scripts/make-test-chart.ts --out D:/tests --size 1920x1080
 *
 * The chart is designed so a *machine* can grade it, not only an eye. Every
 * patch sits at a known coordinate with a known value, and `check-capture.ts`
 * reads exactly those coordinates back out of whatever came home. That matters
 * because the failures here are quiet: a range conversion looks like "slightly
 * milky", chroma subsampling looks like "a bit soft", and 8-bit banding in a
 * gradient looks like nothing at all until it is on a projector.
 *
 * What each region is for:
 *
 * 1. **Luma ramp, full width.** 0 to 255 across the frame. A limited-range
 *    round trip crushes both ends flat; the checker reports where it starts
 *    and stops changing.
 * 2. **Marked patches** at 0, 16, 128, 235 and 255. 0 and 255 are the ones that
 *    disappear when something clamps to legal range. 16 and 235 are the legal
 *    limits themselves — if those move, a range conversion has happened.
 * 3. **1px chroma comb**, alternating pure red and pure blue columns. 4:2:0
 *    averages these into mud; 4:4:4 keeps them separate. This is the single
 *    most sensitive test in the chart and it needs no instrument.
 * 4. **Coloured text edges** — the same failure in a form you recognise
 *    instantly, because everyone knows what red text on blue should look like.
 * 5. **Shadow gradient**, 0 to 32 over a wide band. 8 bits gives 32 visible
 *    steps here; 10 bits gives 128 and reads smooth.
 * 6. **Saturated primaries.** Fully saturated red and blue are where chroma
 *    subsampling and limited-range clamping do their worst.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodePng } from "@seed-ae/media";

const args = process.argv.slice(2);
const outDir = args.includes("--out") ? (args[args.indexOf("--out") + 1] as string) : ".";
const sizeArg = args.includes("--size")
  ? (args[args.indexOf("--size") + 1] as string)
  : "1920x1080";
const [WIDTH, HEIGHT] = sizeArg.split("x").map(Number) as [number, number];

/** Where the checker looks. Fractions of the frame, so any size works. */
export const REGIONS = {
  ramp: { y: 0.08 },
  patches: { y: 0.22, values: [0, 16, 128, 235, 255] },
  comb: { y: 0.4 },
  shadow: { y: 0.62 },
  primaries: { y: 0.82 },
} as const;

const rgba = new Uint8Array(WIDTH * HEIGHT * 4);

function set(x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const at = (y * WIDTH + x) * 4;
  rgba[at] = r;
  rgba[at + 1] = g;
  rgba[at + 2] = b;
  rgba[at + 3] = 255;
}

function band(yFraction: number, height: number, paint: (x: number, y: number) => void) {
  const top = Math.round(yFraction * HEIGHT);
  for (let y = top; y < Math.min(HEIGHT, top + height); y += 1) {
    for (let x = 0; x < WIDTH; x += 1) paint(x, y);
  }
}

// Mid grey everywhere, so an unpainted area is obvious rather than black.
for (let i = 0; i < rgba.length; i += 4) {
  rgba[i] = 64;
  rgba[i + 1] = 64;
  rgba[i + 2] = 64;
  rgba[i + 3] = 255;
}

const bandHeight = Math.round(HEIGHT * 0.11);

// 1. Full-range luma ramp.
band(REGIONS.ramp.y, bandHeight, (x, y) => {
  const value = Math.round((x / (WIDTH - 1)) * 255);
  set(x, y, value, value, value);
});

// 2. Known patches, evenly spaced, each one flat.
band(REGIONS.patches.y, bandHeight, (x, y) => {
  const slot = Math.floor((x / WIDTH) * REGIONS.patches.values.length);
  const value = REGIONS.patches.values[
    Math.min(slot, REGIONS.patches.values.length - 1)
  ] as number;
  set(x, y, value, value, value);
});

// 3. One-pixel red/blue comb — the chroma test.
band(REGIONS.comb.y, bandHeight, (x, y) => {
  if (x % 2 === 0) set(x, y, 255, 0, 0);
  else set(x, y, 0, 0, 255);
});

// 4. Shadow gradient, 0..32, for banding.
band(REGIONS.shadow.y, bandHeight, (x, y) => {
  const value = Math.round((x / (WIDTH - 1)) * 32);
  set(x, y, value, value, value);
});

// 5. Saturated primaries and secondaries.
const swatches: Array<[number, number, number]> = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [0, 255, 255],
  [255, 0, 255],
  [255, 255, 0],
];
band(REGIONS.primaries.y, bandHeight, (x, y) => {
  const slot = Math.min(Math.floor((x / WIDTH) * swatches.length), swatches.length - 1);
  const [r, g, b] = swatches[slot] as [number, number, number];
  set(x, y, r, g, b);
});

await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `seed-test-chart_${WIDTH}x${HEIGHT}.png`);
await writeFile(file, encodePng(WIDTH, HEIGHT, rgba));

console.log(`wrote ${file}`);
console.log(`\nRegions, as fractions of frame height:`);
for (const [name, region] of Object.entries(REGIONS)) {
  console.log(`  ${name.padEnd(10)} y=${region.y}`);
}
console.log(
  "\nThis is a full-range sRGB PNG: 0 and 255 are both present, and both are\n" +
    "outside legal video range. That is deliberate — it is what makes a range\n" +
    "conversion visible instead of merely suspected.",
);
