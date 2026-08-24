/**
 * Expand a shot into a wider format, keeping every original pixel.
 *
 *   npx tsx --env-file=.env scripts/expand-shot.ts <clip> <x,y,w,h> [outDir] [prompt]
 *
 * The rect is the artist's, not a guess: it says where the original picture
 * sits inside the full frame. Everything outside it is what gets generated.
 *
 * Four steps, and nothing clever in between:
 *
 *   1. take the real first and last frames of the clip
 *   2. Seedream fills the margins on each -> two full-format stills
 *   3. Seedance animates between them, so the delivered clip is that exact
 *      framing moving
 *   4. the original is composited back over the rect, so the picture that was
 *      photographed is the picture that is delivered
 *
 * Why frames rather than a reference video, when a reference video follows the
 * source motion beautifully and this does not:
 *
 *   Both were measured on 2026-08-24, on the same shot. Handed the original as
 *   a `reference_video` plus the filled still as a `reference_image`, Seedance
 *   tracked the dolly almost frame for frame — but composed its own wider view
 *   of the scene rather than reproducing the still's framing, so the generated
 *   margins met the original at a hard jump in scale. A reference is treated as
 *   material to draw on, not as a frame to match.
 *
 *   `first_frame` is a frame to match. The output ratio follows it — "For
 *   first-frame or first-last-frame generation, the output ratio follows the
 *   first-frame image" — so the plate decides the shape, and both ends of the
 *   move are pinned to real photographed frames. The cost is that the motion
 *   between them is interpolated rather than tracked, which is affordable here
 *   precisely because the original covers the middle of every frame.
 *
 * The two modes cannot be combined: "first/last frame content cannot be mixed
 * with reference media content". Set SEED_EXPAND_MODE=reference to run the
 * other one.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const run = promisify(execFile);

const base = process.env.ARK_BASE_URL ?? "";
const apiKey = process.env.ARK_API_KEY ?? "";
const imageModel = process.env.SEEDREAM_MODEL_ID ?? "";
const videoModel = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";
const mode = process.env.SEED_EXPAND_MODE === "reference" ? "reference" : "frames";

const clip = process.argv[2];
const rectArg = process.argv[3];
const outDir = process.argv[4] ?? path.join(process.cwd(), ".seed-ae", "expand");

if (!clip || !rectArg) {
  console.error("usage: expand-shot.ts <clip> <x,y,w,h> [outDir] [prompt]");
  process.exit(1);
}
if (!base || !apiKey || !imageModel || !videoModel) {
  console.error("Needs ARK_BASE_URL, ARK_API_KEY, SEEDREAM_MODEL_ID, SEEDANCE_MODEL_ID.");
  process.exit(1);
}

const parts = rectArg.split(",").map((n) => Number(n.trim()));
const rx = parts[0] ?? NaN;
const ry = parts[1] ?? NaN;
const rw = parts[2] ?? NaN;
const rh = parts[3] ?? NaN;
if ([rx, ry, rw, rh].some((n) => !Number.isFinite(n))) {
  console.error(`rect must be x,y,w,h — received "${rectArg}"`);
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const stem = path.basename(clip).replace(/\.[^.]+$/, "").replace(/\s+/g, "_");
const out = (name: string): string => path.join(outDir, `${stem}_${name}`);

interface Probed {
  width: number;
  height: number;
  fps: number;
  duration: number;
}

/** What the file actually is, asked rather than assumed. */
async function probe(file: string): Promise<Probed> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,r_frame_rate,duration",
    "-of",
    "json",
    file,
  ]);
  const stream = (JSON.parse(stdout) as { streams: Array<Record<string, unknown>> })
    .streams[0] as Record<string, unknown>;
  const rate = String(stream.r_frame_rate ?? "24/1").split("/").map(Number);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    fps: (rate[0] ?? 24) / (rate[1] ?? 1),
    duration: Number(stream.duration),
  };
}

const source = await probe(clip);
console.log(
  `clip    ${source.width}x${source.height}  ${source.fps.toFixed(3)}fps  ${source.duration.toFixed(2)}s`,
);
console.log(`rect    ${rx},${ry} ${rw}x${rh} — the original picture, kept whole`);
console.log(`target  ${source.width}x${source.height} — full frame`);
console.log(`mode    ${mode}\n`);

/* ---------- 1. the real first and last frames ---------- */

const firstFrame = out("frame_first.png");
const lastFrame = out("frame_last.png");
await run("ffmpeg", ["-v", "error", "-i", clip, "-vframes", "1", firstFrame, "-y"]);

/**
 * Mean luma of a still, or of one region of it.
 *
 * Used for two different checks that both come down to "is this black": a
 * frame seeked past the end of a clip, and a margin a fill was supposed to
 * have painted and did not.
 */
async function meanLuma(file: string, crop?: string): Promise<number> {
  const { stderr } = await run("ffmpeg", [
    "-v",
    "info",
    "-i",
    file,
    "-vf",
    `${crop ? `crop=${crop},` : ""}signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
    "-f",
    "null",
    "-",
  ]).catch((error: { stderr?: string }) => ({ stderr: error.stderr ?? "" }));
  const match = /YAVG=([\d.]+)/.exec(stderr ?? "");
  return match ? Number(match[1]) : 0;
}

/*
 * Taken from the end of the file rather than by seeking to a computed time.
 *
 * This clip's reported duration is 6.047s and the frame at 6.000s is blank —
 * a forward seek lands past the last picture and ffmpeg writes black. That
 * cost a whole render on 2026-08-24: Seedream was handed a black frame, had
 * nothing to extend, and returned a copy of the other plate instead, so the
 * two ends of the move were identical and the clip barely moved.
 *
 * `-sseof` counts back from the end, and the result is checked rather than
 * trusted: a near-black frame steps further back instead of being used.
 */
let lastLuma = 0;
for (const back of [0.15, 0.4, 0.8, 1.5]) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-sseof",
    `-${back}`,
    "-i",
    clip,
    "-vframes",
    "1",
    lastFrame,
    "-y",
  ]);
  lastLuma = await meanLuma(lastFrame);
  if (lastLuma > 8) break;
  console.log(`   ${back}s from the end is blank (luma ${lastLuma.toFixed(1)}) — stepping back`);
}
if (lastLuma <= 8) {
  console.error("   every frame near the end of this clip is blank; nothing to extend");
  process.exit(1);
}
console.log(`1. first and last frames taken from the clip (end luma ${lastLuma.toFixed(1)})`);

/* ---------- 2. Seedream fills the margins ---------- */

const margins: string[] = [];
if (rx > 0) margins.push(`${rx}px on the left`);
if (source.width - (rx + rw) > 0) margins.push(`${source.width - (rx + rw)}px on the right`);
if (ry > 0) margins.push(`${ry}px along the top`);
if (source.height - (ry + rh) > 0) {
  margins.push(`${source.height - (ry + rh)}px along the bottom`);
}
const marginWords = margins.join(", ");
const size = `${source.width}x${source.height}`;

/**
 * Is every margin actually painted?
 *
 * Asked rather than assumed, because the fill is not reliable: on 2026-08-24
 * the same prompt filled the first frame perfectly and handed the last frame
 * back with its bars still in place. A plate that still has a black margin is
 * a plate that will put a black margin in the delivered clip, so it is worth
 * one more call rather than a whole render.
 */
async function marginsFilled(plate: string): Promise<boolean> {
  /*
   * The outermost band of each margin, not the whole margin. A fill that only
   * widens the picture part way leaves a narrow bar, and averaged across the
   * full margin that bar disappears into the picture beside it — the failed
   * plate measured 60 across its whole left margin and 2.6 at its outer edge,
   * against 160 for a plate that was filled properly.
   */
  const band = 24;
  const strips: string[] = [];
  if (rx >= band) strips.push(`${band}:${source.height}:0:0`);
  if (source.width - (rx + rw) >= band) {
    strips.push(`${band}:${source.height}:${source.width - band}:0`);
  }
  if (ry >= band) strips.push(`${source.width}:${band}:0:0`);
  if (source.height - (ry + rh) >= band) {
    strips.push(`${source.width}:${band}:0:${source.height - band}`);
  }
  for (const strip of strips) {
    if ((await meanLuma(plate, strip)) < 10) return false;
  }
  return true;
}

/**
 * Fill the empty margins of one frame, and cache the result: a retry should
 * not pay twice for the same plate.
 */
async function fillMargins(frame: string, target: string) {
  const cached = await readFile(target).catch(() => undefined);
  if (cached) {
    console.log(`   reusing ${path.basename(target)}`);
    return;
  }

  const image = `data:image/png;base64,${(await readFile(frame)).toString("base64")}`;

  const prompt =
    /*
     * This wording is the one that works, and both directions away from it
     * were measured on 2026-08-24 and were worse:
     *
     *   Leaning harder on preservation — "it must come back pixel for pixel,
     *   only the empty area changes" — and Seedream stopped filling at all:
     *   three attempts in a row came back with the bars still in place.
     *
     *   Describing what the margins should contain — "the scene carries on
     *   past its edges, the same vanishing point" — and it recomposed, handing
     *   back a handsome symmetrical view of the aisle with the shot's own
     *   off-centre framing thrown away. A plate that reframes is useless, so
     *   this is the worse failure of the two.
     *
     * It is not reliable even so: the same prompt filled the first frame first
     * time and needed a second attempt on the last frame. That is what the
     * margin check above is for.
     */
    `Extend the first image outwards to fill its empty margins: ${marginWords}. ` +
    `The black areas must be completely painted over with a continuation of the ` +
    `photograph — no black, no border, no letterboxing anywhere in the result. ` +
    `Continue the existing scene straight out past its edges — the same place, the ` +
    `same moment, the same lens, the same lighting and depth of field. Match grain, ` +
    `colour and exposure exactly across the join. Stay inside the same space: do not ` +
    `add windows, doorways, daylight or any view into another location. Do not alter, ` +
    `redraw, reframe or restyle anything inside the existing picture, and do not ` +
    `introduce new subjects; only continue what is already there into the empty area.`;

  const raw = `${target}.seedream.jpg`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        image,
        size,
        response_format: "url",
        watermark: false,
        sequential_image_generation: "disabled",
      }),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | { data?: Array<{ url?: string }>; error?: { code?: string; message?: string } }
      | undefined;
    const url = payload?.data?.[0]?.url;
    if (!response.ok || !url) {
      const message = (payload?.error?.message ?? "").replace(/\s*Request id:.*$/i, "");
      console.error(`   FAILED ${response.status} — ${payload?.error?.code}: ${message}`);
      process.exit(1);
    }
    await writeFile(raw, Buffer.from(await (await fetch(url)).arrayBuffer()));
    if (await marginsFilled(raw)) {
      /*
       * The original rect goes back on, mechanically.
       *
       * Seedream re-renders the whole frame, centre included — what comes back
       * is a repaint of the shot, not the shot. Asking a prompt not to touch
       * the middle does not work and cannot be verified; pasting the real
       * pixels over it is exact and costs nothing. It matters twice over: this
       * plate is what Seedance animates from, so the render starts from the
       * true frame, and the delivered comp meets generated margins that were
       * painted around the true frame rather than around a repaint of it.
       *
       * PNG, because writing the original pixels back through JPEG twice is a
       * pointless generation loss on the one part that must not change.
       */
      await run("ffmpeg", [
        "-v",
        "error",
        "-i",
        raw,
        "-i",
        frame,
        "-filter_complex",
        `[1:v]crop=${rw}:${rh}:${rx}:${ry}[fg];[0:v][fg]overlay=${rx}:${ry}`,
        "-frames:v",
        "1",
        target,
        "-y",
      ]);
      console.log(
        `   ${path.basename(target)}${attempt > 1 ? ` (attempt ${attempt})` : ""} — original rect pasted back`,
      );
      return;
    }
    console.log(`   attempt ${attempt} came back with a margin still black — asking again`);
  }
  console.error(`   ${path.basename(target)} still has an unfilled margin after 3 attempts`);
  process.exit(1);
}

const plateFirst = out("plate_first.png");
const plateLast = out("plate_last.png");

console.log(`2. filling margins with ${imageModel} at ${size} ...`);
await fillMargins(firstFrame, plateFirst);
/*
 * Filled on its own, deliberately.
 *
 * Handing the first plate along as a second reference "for consistency" made
 * Seedream reproduce that plate instead of extending this frame — measured
 * 2026-08-24, and it returned the first plate letterboxed inside a black
 * border, which then became a black border in the video. The two ends may
 * invent slightly different shelving; Seedance blends between them, and that
 * is a far smaller artefact than a shot that does not move.
 */
if (mode === "frames") await fillMargins(lastFrame, plateLast);

if (process.env.SEED_EXPAND_PLATES_ONLY) {
  console.log(`
plates only — stopping before the render`);
  process.exit(0);
}

/* ---------- 3. Seedance ---------- */

const publisher = new R2Publisher({
  endpoint: process.env.SEED_R2_ENDPOINT ?? "",
  bucket: process.env.SEED_R2_BUCKET ?? "",
  accessKeyId: process.env.SEED_R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.SEED_R2_SECRET_ACCESS_KEY ?? "",
  ...(process.env.SEED_R2_PREFIX ? { prefix: process.env.SEED_R2_PREFIX } : {}),
});

/*
 * The reference clip is cropped to the rect, and this is not a detail.
 *
 * Sent whole, a pillarboxed clip teaches the model that the black bars are
 * part of the scene: measured on 2026-08-24, Seedance reproduced them exactly
 * — a 1920x1080 render with the picture boxed in the middle and the margins
 * black, ignoring the wide composition in the reference image entirely.
 */
const refClip = out("ref.mp4");
await run("ffmpeg", [
  "-v",
  "error",
  "-i",
  clip,
  "-vf",
  `crop=${rw}:${rh}:${rx}:${ry}`,
  "-c:v",
  "libx264",
  "-crf",
  "16",
  "-pix_fmt",
  "yuv420p",
  "-an",
  refClip,
  "-y",
]);

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
const divisor = gcd(source.width, source.height);
const ratio = `${source.width / divisor}:${source.height / divisor}`;

const content: Array<Record<string, unknown>> = [];
const body: Record<string, unknown> = {
  model: videoModel,
  resolution: "1080p",
  bitrate_mode: "high",
  generate_audio: false,
};

if (mode === "frames") {
  console.log(`3. hosting both plates ...`);
  const first = await publisher.publish({
    bytes: await readFile(plateFirst),
    filename: `${stem}_first.png`,
    mimeType: "image/png",
  });
  const last = await publisher.publish({
    bytes: await readFile(plateLast),
    filename: `${stem}_last.png`,
    mimeType: "image/png",
  });
  /*
   * No `ratio`: with a first frame the API refuses it — "For first-frame or
   * first-last-frame generation, the output ratio follows the first-frame
   * image" — which is the whole point. The plate is already the full frame.
   */
  content.push({
    type: "text",
    text:
      process.argv[5] ??
      `One continuous live-action take. The camera continues its existing move ` +
        `smoothly and at a constant speed from the first frame to the last, without ` +
        `cutting, without changing angle or lens, and without reframing. Everything ` +
        `in shot stays exactly as photographed.`,
  });
  content.push({ type: "image_url", image_url: { url: first.url }, role: "first_frame" });
  content.push({ type: "image_url", image_url: { url: last.url }, role: "last_frame" });
  body.duration = Math.max(4, Math.min(30, Math.round(source.duration)));
} else {
  console.log(`3. hosting the cropped clip and the plate ...`);
  const hostedClip = await publisher.publish({
    bytes: await readFile(refClip),
    filename: `${stem}_ref.mp4`,
    mimeType: "video/mp4",
  });
  const hostedPlate = await publisher.publish({
    bytes: await readFile(plateFirst),
    filename: `${stem}_plate.png`,
    mimeType: "image/png",
  });
  /*
   * Worded as a shot to make, not an edit to apply, and this is load-bearing.
   * Anything reading as a transformation of the attached clip is refused:
   * "Seedance identified your task as video editing based on your prompt ...
   * `ratio` must be `adaptive`" — which hands back the input's shape.
   */
  content.push({
    type: "text",
    text:
      process.argv[5] ??
      `A single continuous live-action wide shot, framed exactly as the still ` +
        `reference — the same place, subjects, lighting, lens and depth of field, ` +
        `filling the whole ${ratio} frame edge to edge. The camera glides steadily ` +
        `and smoothly through the space in one unbroken take, no cuts.`,
  });
  content.push({
    type: "image_url",
    image_url: { url: hostedPlate.url },
    role: "reference_image",
  });
  content.push({
    type: "video_url",
    video_url: { url: hostedClip.url },
    role: "reference_video",
  });
  /*
   * Generated wider than the delivery, on purpose.
   *
   * Reference mode composes its own view rather than reproducing the still's
   * framing, and the view it chose was wider than the source and shifted: a
   * single scale-and-shift fitted it at scale 0.875, dx -448px, correlation
   * 0.69 (measured 2026-08-24). Correcting that means scaling the render down
   * to match the original, and a render made at the delivery ratio would then
   * no longer reach the edges of the delivery.
   *
   * Asking for a wider ratio leaves room to scale down into. What is not
   * needed gets cropped away after alignment.
   */
  body.ratio = process.env.SEED_EXPAND_GEN_RATIO ?? ratio;
  body.duration = -1;
}
body.content = content;

console.log(
  `   submitting ${videoModel}  ${mode === "frames" ? `duration=${body.duration}` : `ratio=${ratio} duration=-1`}`,
);
const submit = await fetch(`${base}/contents/generations/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const submitted = (await submit.json().catch(() => undefined)) as
  | { id?: string; error?: { code?: string; message?: string } }
  | undefined;

if (!submit.ok || !submitted?.id) {
  const message = (submitted?.error?.message ?? "").replace(/\s*Request id:.*$/i, "");
  console.error(`   REFUSED ${submit.status} — ${submitted?.error?.code}: ${message}`);
  process.exit(1);
}

console.log(`   task ${submitted.id} — polling`);
let videoUrl = "";
for (let i = 0; i < 150; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const poll = await fetch(`${base}/contents/generations/tasks/${submitted.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const task = (await poll.json().catch(() => undefined)) as
    | {
        status?: string;
        content?: { video_url?: string };
        error?: { code?: string; message?: string };
      }
    | undefined;
  if (task?.status === "succeeded" && task.content?.video_url) {
    videoUrl = task.content.video_url;
    break;
  }
  if (task?.status === "failed" || task?.status === "cancelled") {
    console.error(`   ${task.status}: ${task.error?.code} — ${task.error?.message}`);
    process.exit(1);
  }
  if (i % 5 === 0) console.log(`   ${task?.status ?? "?"} (${(i + 1) * 4}s)`);
}

if (!videoUrl) {
  console.error("   timed out waiting for the render");
  process.exit(1);
}

const wide = out("wide.mp4");
await writeFile(wide, Buffer.from(await (await fetch(videoUrl)).arrayBuffer()));
const generated = await probe(wide);
console.log(
  `   ${path.basename(wide)}  ${generated.width}x${generated.height}  ${generated.duration.toFixed(2)}s`,
);

/* ---------- 4. line the render up with the shot, then put the original back ---------- */

/** One frame of a file as raw 8-bit grey at the requested size. */
async function grey(file: string, at: number, w: number, h: number): Promise<Uint8Array> {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v", "error", "-ss", at.toFixed(3), "-i", file,
      "-vf", `scale=${w}:${h}`, "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ],
    { encoding: "buffer", maxBuffer: 1 << 28 },
  );
  return new Uint8Array(stdout as unknown as Buffer);
}

/**
 * How well a candidate scale and shift lines the two frames up.
 *
 * A point (x,y) in the source is looked up at (x/s + dx, y/s + dy) in the
 * render, and only the region the original picture occupies is scored — the
 * margins are generated and have nothing to agree with.
 */
function correlate(
  a: Uint8Array, b: Uint8Array, w: number, h: number,
  s: number, dx: number, dy: number,
  box: { x: number; y: number; w: number; h: number },
): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let y = Math.max(0, box.y); y < Math.min(h, box.y + box.h); y += 2) {
    const gy = Math.round(y / s + dy);
    if (gy < 0 || gy >= h) continue;
    for (let x = Math.max(0, box.x); x < Math.min(w, box.x + box.w); x += 2) {
      const gx = Math.round(x / s + dx);
      if (gx < 0 || gx >= w) continue;
      const p = a[y * w + x]!;
      const q = b[gy * w + gx]!;
      n += 1; sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q;
    }
  }
  if (n < (box.w * box.h) / 16) return -1;
  const cov = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  if (va <= 0 || vb <= 0) return -1;
  return cov / Math.sqrt(va * vb);
}

/*
 * In frames mode the render already starts from the plate, so its framing is
 * the plate's and no correction is wanted. In reference mode the model chose
 * its own view and this is what puts it back where the shot is.
 */
let fit = { s: 1, dx: 0, dy: 0, r: 1 };
if (mode === "reference") {
  const at = source.duration / 2;
  for (const [W, H, span, step] of [
    [192, 108, 0, 0],
    [768, 432, 0, 0],
  ] as const) {
    void span;
    void step;
    const box = {
      x: Math.round((rx * W) / source.width),
      y: Math.round((ry * H) / source.height),
      w: Math.round((rw * W) / source.width),
      h: Math.round((rh * H) / source.height),
    };
    const a = await grey(clip, at, W, H);
    const b = await grey(wide, (at / source.duration) * generated.duration, W, H);
    if (W === 192) {
      let best = { s: 1, dx: 0, dy: 0, r: -1 };
      for (let s = 0.7; s <= 1.6; s += 0.02) {
        for (let dx = -60; dx <= 60; dx += 2) {
          for (let dy = -40; dy <= 40; dy += 2) {
            const r = correlate(a, b, W, H, s, dx, dy, box);
            if (r > best.r) best = { s, dx, dy, r };
          }
        }
      }
      fit = best;
    } else {
      const k = W / 192;
      const c = { s: fit.s, dx: fit.dx * k, dy: fit.dy * k };
      let best = { ...c, r: -1 };
      for (let s = c.s - 0.04; s <= c.s + 0.04; s += 0.005) {
        for (let dx = c.dx - 12; dx <= c.dx + 12; dx += 1) {
          for (let dy = c.dy - 12; dy <= c.dy + 12; dy += 1) {
            const r = correlate(a, b, W, H, s, dx, dy, box);
            if (r > best.r) best = { s, dx, dy, r };
          }
        }
      }
      fit = { s: best.s, dx: (best.dx / k) * (source.width / 192), dy: (best.dy / k) * (source.height / 108), r: best.r };
    }
  }
  console.log(
    `4. render lines up at scale ${fit.s.toFixed(3)}, offset ${fit.dx.toFixed(0)},${fit.dy.toFixed(0)} (correlation ${fit.r.toFixed(2)})`,
  );
  if (fit.r < 0.5) {
    console.log(`   weak — the render is not a reframing of this shot, so the margins will not sit right`);
  }
}

/*
 * The generated clip is whatever size and length Ark chose. It is scaled to
 * the source frame and, where the lengths differ, retimed so the two moves
 * stay in step: a generated 6.00s against a 6.05s original drifts by a frame
 * at the end, and a frame of drift is visible at the seam.
 */
const stretch = source.duration / generated.duration;

/*
 * The join is feathered rather than cut.
 *
 * A hard edge announces itself even when both sides are correct, because the
 * original is sharper and fractionally different in exposure from anything
 * generated beside it — and the eye finds a straight vertical line instantly.
 * A short ramp costs a few pixels of original at the very border and buys an
 * edge that has to be looked for.
 *
 * SEED_EXPAND_FEATHER sets the width; 0 turns it off and cuts hard, which is
 * the honest way to see how well the margins actually line up.
 */
const feather = Number(process.env.SEED_EXPAND_FEATHER ?? 12);
const alpha =
  feather > 0
    ? `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(min(min(X\\,W-1-X)\\,min(Y\\,H-1-Y))/${feather}\\,0\\,1)'`
    : "";

/* Room for the aligned crop to land in without running off the edge. */
const PAD = 600;

const final = out("final.mp4");
await run("ffmpeg", [
  "-v",
  "error",
  "-i",
  wide,
  "-i",
  refClip,
  "-filter_complex",
  /*
   * The background: the render put back where the shot is.
   *
   * In frames mode the fit is the identity and this reduces to a plain scale
   * to the delivery size. In reference mode the render is scaled by the fitted
   * factor and cropped so the picture it contains sits exactly where the
   * original sits. The generous pad is what makes that crop safe — asking for
   * a wider generation ratio is what keeps the pad from being needed.
   */
  `[0:v]scale=${Math.round(source.width * fit.s)}:${Math.round(source.height * fit.s)},` +
    `pad=iw+${2 * PAD}:ih+${2 * PAD}:${PAD}:${PAD}:black,` +
    `crop=${source.width}:${source.height}:${Math.round(fit.dx * fit.s) + PAD}:${Math.round(fit.dy * fit.s) + PAD},` +
    `setpts=${stretch.toFixed(6)}*PTS,fps=${source.fps.toFixed(6)},setsar=1[bg];` +
    `[1:v]setsar=1${alpha}[fg];` +
    `[bg][fg]overlay=${rx}:${ry}:shortest=1:format=auto[v]`,
  "-map",
  "[v]",
  "-c:v",
  "libx264",
  "-crf",
  "16",
  "-pix_fmt",
  "yuv420p",
  final,
  "-y",
]);
const done = await probe(final);
console.log(`4. ${path.basename(final)}  ${done.width}x${done.height}  ${done.duration.toFixed(2)}s`);

/* Frames to actually look at, rather than take on trust. */
const stills: Array<[string, number]> = [
  ["a", 0.1],
  ["b", done.duration / 2],
  ["c", Math.max(0, done.duration - 0.2)],
];
for (const [name, at] of stills) {
  await run("ffmpeg", [
    "-v",
    "error",
    "-ss",
    at.toFixed(2),
    "-i",
    final,
    "-vframes",
    "1",
    out(`check_${name}.png`),
    "-y",
  ]);
}
console.log(`   check_a/b/c.png written beside it`);
