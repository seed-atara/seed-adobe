/**
 * Takes the backing out of a keyed clip's edges, frame by frame.
 *
 *   npx tsx scripts/unspill-clip.ts <in.mov> <out.mov> --ratio 0.55
 *
 * `floodMatte` softens only the pixels touching the region it filled — one
 * pixel of a band that is two or three wide once the plate's own anti-aliasing,
 * the model's rendering of it and 4:2:0 chroma have all had a go. The rest stay
 * fully opaque with the backing still in them, which on the GYG proscenium read
 * as a violet rim around every leaf.
 *
 * Decode to raw RGBA, solve each pixel for how much backing it holds, encode
 * ProRes 4444 — the same pipe shape `floodMatte` itself uses, for the same
 * reason: a filter graph cannot do arithmetic that couples colour to alpha.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unspillFrame } from "../packages/media/src/unspill.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ratioAt = process.argv.indexOf("--ratio");
const ratio = ratioAt >= 0 ? Number(process.argv[ratioAt + 1]) : 0.55;

if (!input || !output) {
  console.error("usage: unspill-clip.ts <in.mov> <out.mov> [--ratio 0.55]");
  process.exit(2);
}

const ffmpeg = path.join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe");

/** Frame size and rate, read rather than assumed. */
const probed = await new Promise<{ width: number; height: number; fps: number }>(
  (resolve, reject) => {
    const run = spawn(ffmpeg, ["-v", "error", "-i", input, "-f", "null", "-"], {
      windowsHide: true,
    });
    let err = "";
    run.stderr.on("data", (c) => (err += String(c)));
    run.on("close", () => {
      const size = /(\d{2,5})x(\d{2,5})/.exec(err);
      const rate = /([\d.]+) fps/.exec(err);
      if (!size) {
        // -v error says nothing on success, so ask again more loudly.
        const probe = spawn(ffmpeg, ["-i", input], { windowsHide: true });
        let out = "";
        probe.stderr.on("data", (c) => (out += String(c)));
        probe.on("close", () => {
          const s = /, (\d{2,5})x(\d{2,5})/.exec(out);
          const f = /([\d.]+) fps/.exec(out);
          if (!s) reject(new Error(`could not read ${input}`));
          else
            resolve({
              width: Number(s[1]),
              height: Number(s[2]),
              fps: f ? Number(f[1]) : 24,
            });
        });
        return;
      }
      resolve({
        width: Number(size[1]),
        height: Number(size[2]),
        fps: rate ? Number(rate[1]) : 24,
      });
    });
  },
);

const { width, height, fps } = probed;
const frameBytes = width * height * 4;
console.log(`${path.basename(input)}  ${width}x${height} @ ${fps}  ratio ${ratio}`);

const decode = spawn(
  ffmpeg,
  ["-v", "error", "-i", input, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
  { windowsHide: true },
);
const encode = spawn(
  ffmpeg,
  [
    "-v", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps),
    "-i", "-",
    "-c:v", "prores_ks", "-profile:v", "4444", "-qscale:v", "9",
    "-pix_fmt", "yuva444p10le", "-alpha_bits", "16", "-an",
    output,
  ],
  { windowsHide: true },
);

const frame = Buffer.alloc(frameBytes);
let filled = 0;
let frames = 0;
let touched = 0;
const errors: string[] = [];
encode.stderr.on("data", (c) => errors.push(String(c)));
decode.stderr.on("data", (c) => errors.push(String(c)));
encode.stdin.on("error", () => {
  // The encoder's exit code carries the real reason; an EPIPE here would hide it.
});

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
      if (filled === frameBytes) {
        const rgba = new Uint8Array(
          frame.buffer,
          frame.byteOffset,
          frameBytes,
        );
        touched += unspillFrame(rgba, { backing: [0, 0, 255], ratio }).touched;
        frames++;
        encode.stdin.write(Buffer.from(frame));
        filled = 0;
      }
    }
  });

  decode.stdout.on("end", () => encode.stdin.end());
  encode.on("close", (code) =>
    code === 0 ? resolve() : fail(new Error(errors.join("").slice(0, 500) || `exit ${code}`)),
  );
});

console.log(
  `  ${frames} frames, ${touched} pixels corrected ` +
    `(${((touched / (frames * width * height)) * 100).toFixed(3)}% of the clip)`,
);
