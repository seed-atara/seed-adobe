/**
 * Measures the colour difference between two frames, and finds what fixes it.
 *
 * A generated clip does not match the plate it came from, and the eye cannot
 * say why. This says why: it reads both images, reports how each is tagged, and
 * tries the standard conversions that sit between a still and a video frame —
 * naming the one that gets them closest, with the numbers.
 *
 * Comparison is on per-channel percentiles rather than pixel by pixel, so two
 * frames that differ slightly in content can still be compared. A range or
 * gamma shift moves every percentile; a moving curtain does not.
 *
 *   npx tsx scripts/compare-frames.ts <plate.png> <generated.png>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodePng } from "@seed-ae/media";

const [plate, generated] = process.argv.slice(2);
if (!plate || !generated) {
  console.error("usage: npx tsx scripts/compare-frames.ts <a.png> <b.png>");
  process.exit(2);
}

const PRIMARIES: Record<number, string> = { 1: "BT.709", 9: "BT.2020", 12: "Display P3" };
const TRANSFER: Record<number, string> = {
  1: "BT.709", 4: "gamma 2.2", 8: "linear", 13: "sRGB", 16: "PQ", 18: "HLG",
};
const MATRIX: Record<number, string> = { 0: "RGB", 1: "BT.709", 5: "BT.601", 9: "BT.2020" };

/** How the file says it should be interpreted, if it says at all. */
function readCicp(bytes: Buffer): string {
  let off = 8;
  while (off + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(off);
    const type = bytes.toString("ascii", off + 4, off + 8);
    if (type === "cICP") {
      const d = bytes.subarray(off + 8, off + 8 + length);
      return (
        `primaries ${d[0]} (${PRIMARIES[d[0] as number] ?? "?"}), ` +
        `transfer ${d[1]} (${TRANSFER[d[1] as number] ?? "?"}), ` +
        `matrix ${d[2]} (${MATRIX[d[2] as number] ?? "?"}), ` +
        `${d[3] ? "full" : "limited"} range`
      );
    }
    if (type === "IEND") break;
    off += 12 + length;
  }
  return "untagged — the reader has to guess";
}

interface Channel {
  /** Value at each percentile, 0..255. */
  percentiles: number[];
  mean: number;
}

const POINTS = [1, 5, 25, 50, 75, 95, 99];

function measure(rgba: Uint8Array, channel: number): Channel {
  const histogram = new Uint32Array(256);
  let total = 0;
  let sum = 0;
  for (let at = channel; at < rgba.length; at += 4) {
    const value = rgba[at] as number;
    histogram[value] = (histogram[value] as number) + 1;
    total += 1;
    sum += value;
  }

  const percentiles: number[] = [];
  let seen = 0;
  let next = 0;
  for (let value = 0; value < 256 && next < POINTS.length; value += 1) {
    seen += histogram[value] as number;
    while (next < POINTS.length && seen >= (total * (POINTS[next] as number)) / 100) {
      percentiles.push(value);
      next += 1;
    }
  }
  while (percentiles.length < POINTS.length) percentiles.push(255);

  return { percentiles, mean: sum / total };
}

/** The conversions that plausibly sit between a still and a decoded video frame. */
const CONVERSIONS: Array<{ name: string; apply: (v: number) => number }> = [
  { name: "none", apply: (v) => v },
  {
    name: "limited→full (16–235 → 0–255)",
    apply: (v) => ((v - 16) * 255) / 219,
  },
  {
    name: "full→limited (0–255 → 16–235)",
    apply: (v) => (v * 219) / 255 + 16,
  },
  {
    name: "sRGB→BT.709 gamma",
    apply: (v) => {
      const n = v / 255;
      const linear = n <= 0.04045 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
      const encoded = linear < 0.018 ? linear * 4.5 : 1.099 * Math.pow(linear, 0.45) - 0.099;
      return encoded * 255;
    },
  },
  {
    name: "BT.709→sRGB gamma",
    apply: (v) => {
      const n = v / 255;
      const linear = n < 0.081 ? n / 4.5 : Math.pow((n + 0.099) / 1.099, 1 / 0.45);
      const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
      return encoded * 255;
    },
  },
];

const aBytes = readFileSync(plate);
const bBytes = readFileSync(generated);
const a = decodePng(aBytes);
const b = decodePng(bBytes);

console.log(`A  ${path.basename(plate)}  ${a.width}x${a.height}`);
console.log(`   ${readCicp(aBytes)}`);
console.log(`B  ${path.basename(generated)}  ${b.width}x${b.height}`);
console.log(`   ${readCicp(bBytes)}`);
console.log("");

const names = ["red", "green", "blue"];
const channelsA = names.map((_, i) => measure(a.rgba, i));
const channelsB = names.map((_, i) => measure(b.rgba, i));

console.log("percentiles          " + POINTS.map((p) => String(p).padStart(5) + "%").join(""));
for (let c = 0; c < 3; c += 1) {
  const one = channelsA[c] as Channel;
  const two = channelsB[c] as Channel;
  console.log(
    `  ${names[c]!.padEnd(6)} A       ` + one.percentiles.map((v) => String(v).padStart(6)).join(""),
  );
  console.log(
    `  ${names[c]!.padEnd(6)} B       ` + two.percentiles.map((v) => String(v).padStart(6)).join(""),
  );
  console.log(
    `  ${names[c]!.padEnd(6)} B-A     ` +
      two.percentiles.map((v, i) => String(v - (one.percentiles[i] as number)).padStart(6)).join(""),
  );
}
console.log("");

/** Mean absolute distance between the two sets of percentiles. */
function distance(convert: (v: number) => number): number {
  let total = 0;
  let count = 0;
  for (let c = 0; c < 3; c += 1) {
    const one = channelsA[c] as Channel;
    const two = channelsB[c] as Channel;
    for (let i = 0; i < POINTS.length; i += 1) {
      const wanted = one.percentiles[i] as number;
      const got = convert(two.percentiles[i] as number);
      total += Math.abs(got - wanted);
      count += 1;
    }
  }
  return total / count;
}

console.log("applying each conversion to B, and measuring the distance to A:");
const scored = CONVERSIONS.map((conversion) => ({
  name: conversion.name,
  distance: distance(conversion.apply),
})).sort((left, right) => left.distance - right.distance);

for (const entry of scored) {
  console.log(`  ${entry.distance.toFixed(2).padStart(7)}   ${entry.name}`);
}

// A per-channel gamma fitted to the midtones, which is what a Curves fix is.
console.log("\nbest-fit per-channel gamma (what a Curves correction is doing):");
for (let c = 0; c < 3; c += 1) {
  const one = channelsA[c] as Channel;
  const two = channelsB[c] as Channel;
  const mid = POINTS.indexOf(50);
  const from = (two.percentiles[mid] as number) / 255;
  const to = (one.percentiles[mid] as number) / 255;
  const gamma = from > 0 && to > 0 ? Math.log(to) / Math.log(from) : 1;
  console.log(`  ${names[c]!.padEnd(6)} ${gamma.toFixed(3)}`);
}

const best = scored[0];
console.log(
  `\n${best && best.distance < (scored.find((s) => s.name === "none")?.distance ?? Infinity)
    ? `"${best.name}" gets them closest.`
    : "No standard conversion helps — the difference is not a range or transfer mismatch."}`,
);
