/**
 * Renders a clip through the same speed ramp After Effects is holding.
 *
 *   npx tsx scripts/apply-speed-ramp.ts <in.mov> <out.mp4> [--ramp 1.5] [--endSpeed 0.2]
 *
 * The ramp lives in the comp as a Time Remap, which is the right place for it:
 * exact, free, and adjustable without re-rendering anything. But a property
 * curve is not something anybody can judge, and "is the ramp too strong" is a
 * question about how the shot *feels*. So this produces the same result as a
 * file, from the same `sourceAt` the comp's keyframes came from, which makes it
 * both a preview and a check that the two agree.
 *
 * Frame-exact rather than interpolated, deliberately: After Effects with frame
 * blending off shows the nearest source frame, so showing the nearest source
 * frame is what matches the comp. A smoother optical-flow version would look
 * better than the thing it is supposed to be previewing, which is the one thing
 * a preview must not do.
 *
 * Written through the concat demuxer over extracted stills, because a ramp
 * reorders and repeats frames and no `setpts` expression does that; `select`
 * can drop frames but cannot hold one.
 */
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeRamp, sourceAt } from "../packages/domain/src/speedRamp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");
const argv = process.argv.slice(2);
const num = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? Number(argv[at + 1] ?? fallback) : fallback;
};
const positional = argv.filter(
  (a, at) => !a.startsWith("--") && !(at > 0 && argv[at - 1]!.startsWith("--")),
);
const [input, output] = positional;
const rampSeconds = num("ramp", 1.5);
const endSpeed = num("endSpeed", 0.2);

if (!input || !output) {
  console.error("usage: apply-speed-ramp.ts <in.mov> <out.mp4> [--ramp 1.5] [--endSpeed 0.2]");
  process.exit(2);
}

async function run(args: string[]): Promise<void> {
  const child = spawn(ffmpeg, args, { windowsHide: true });
  const errors: string[] = [];
  child.stderr.on("data", (c) => errors.push(String(c)));
  await new Promise<void>((done, fail) =>
    child.on("close", (code) =>
      code === 0 ? done() : fail(new Error(errors.join("").slice(0, 500) || `ffmpeg exit ${code}`)),
    ),
  );
}

const probe = spawn(ffmpeg, ["-i", input], { windowsHide: true });
let info = "";
probe.stderr.on("data", (c) => (info += String(c)));
await new Promise<void>((done) => probe.on("close", () => done()));
const rate = /([\d.]+) fps/.exec(info);
const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
if (!dur) throw new Error(`could not read a duration from ${input}`);
const fps = rate ? Number(rate[1]) : 24;
const seconds = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
const total = Math.round(seconds * fps);
/** The last addressable frame, which is what the comp's remap ends on. */
const durationSeconds = Math.round(((total - 1) / fps) * 1000) / 1000;

const request = { durationSeconds, rampSeconds, endSpeed };
const shape = describeRamp(request);
console.log(`${path.basename(input)}  ${total} frames @ ${fps}  ${durationSeconds}s`);
console.log(
  `ramp ${shape.rampSeconds}s at ${shape.endSpeed}x, ${shape.peak}x middle, ` +
    `${shape.slowestRatio}:1 slowest to fastest`,
);

const stills = path.join(root, ".work", "daynight", "_ramp_frames");
await rm(stills, { recursive: true, force: true });
await mkdir(stills, { recursive: true });
console.log("extracting frames...");
await run(["-v", "error", "-y", "-i", input, "-q:v", "2", path.join(stills, "f%05d.jpg")]);

/*
 * One entry per OUTPUT frame, naming the source frame the ramp asks for. The
 * clamp matters: `sourceAt` is exact at the endpoints, but rounding a time back
 * to a frame index can still reach `total`, which does not exist.
 */
const lines: string[] = [];
const held = new Map<number, number>();
for (let out = 0; out < total; out++) {
  const at = out / fps;
  const source = Math.min(total - 1, Math.max(0, Math.round(sourceAt(at, request) * fps)));
  held.set(source, (held.get(source) ?? 0) + 1);
  lines.push(`file 'f${String(source + 1).padStart(5, "0")}.jpg'`);
  lines.push(`duration ${(1 / fps).toFixed(6)}`);
}
// The concat demuxer ignores the final duration unless the last file repeats.
lines.push(lines[lines.length - 2]!);
const listFile = path.join(stills, "ramp.txt");
await writeFile(listFile, lines.join("\n"), "utf8");

const repeated = [...held.values()].filter((n) => n > 1).length;
console.log(
  `  ${total} output frames from ${held.size} distinct source frames ` +
    `(${repeated} held more than once, which is the slow ends)`,
);

console.log(`encoding -> ${path.basename(output)}`);
await run([
  "-v", "error", "-y",
  "-f", "concat", "-safe", "0", "-i", listFile,
  "-r", String(fps),
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
  output,
]);
await rm(stills, { recursive: true, force: true });
console.log("done");
