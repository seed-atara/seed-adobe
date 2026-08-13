/**
 * Does a presigned R2 link work as a Seedance `reference_video`?
 *
 * Two things are unknown and only measurable: whether Ark accepts a URL
 * carrying a query string and no file extension semantics of its own, and
 * whether it fetches it in time. Both are settled by submitting a real job and
 * watching it to the end — so this costs one generation.
 *
 *   npx tsx --env-file=.env scripts/probe-video-ref-r2.ts <clip.mp4> ["prompt"]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const base = process.env.ARK_BASE_URL ?? "";
const key = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";

if (!base || !key || !model) {
  console.error("Needs ARK_BASE_URL, ARK_API_KEY and SEEDANCE_MODEL_ID.");
  process.exit(1);
}

const clip = process.argv[2];
if (!clip) {
  console.error("usage: probe-video-ref-r2.ts <clip.mp4> [prompt]");
  process.exit(1);
}
const prompt =
  process.argv[3] ??
  "the same camera move and timing, restyled as a hand-painted ink illustration";

const publisher = new R2Publisher({
  endpoint: process.env.SEED_R2_ENDPOINT ?? "",
  bucket: process.env.SEED_R2_BUCKET ?? "",
  accessKeyId: process.env.SEED_R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.SEED_R2_SECRET_ACCESS_KEY ?? "",
  urlTtlSeconds: Number(process.env.SEED_R2_URL_TTL_SECONDS ?? 3600),
});

const bytes = await readFile(clip);
console.log(`clip ${path.basename(clip)}: ${(bytes.length / 1048576).toFixed(2)}MB`);

const started = Date.now();
const { url } = await publisher.publish({
  bytes,
  filename: path.basename(clip),
  mimeType: "video/mp4",
});
console.log(`hosted in ${Date.now() - started}ms`);
console.log(`url: ${url.replace(/X-Amz-Signature=.*/, "X-Amz-Signature=<redacted>")}`);

/*
 * `duration` is the interesting field. Ark classifies a request carrying a
 * reference video by what the prompt asks for, and a video-editing task
 * refuses any duration but -1 — "the output ratio and duration follow the
 * input video". Passed on the command line so both cases can be measured.
 */
const duration = Number(process.argv[4] ?? -1);
const resolution = process.argv[5] ?? "480p";
const ratio = process.argv[6];
const body = {
  model,
  content: [
    { type: "text", text: prompt },
    { type: "video_url", video_url: { url }, role: "reference_video" },
  ],
  duration,
  ...(resolution === "none" ? {} : { resolution }),
  ...(ratio ? { ratio } : {}),
};
console.log(`duration ${duration}, resolution ${resolution}, ratio ${ratio ?? "none"}`);

console.log(`\nPOST ${base}/contents/generations/tasks`);
const response = await fetch(`${base}/contents/generations/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const payload = (await response.json().catch(() => undefined)) as
  | { id?: string; error?: { code?: string; message?: string } }
  | undefined;
console.log(`HTTP ${response.status}`);
if (!response.ok || !payload?.id) {
  console.log(JSON.stringify(payload, null, 2).slice(0, 900));
  process.exit(1);
}

console.log(`task ${payload.id} accepted — polling`);
const submitted = Date.now();
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const poll = await fetch(`${base}/contents/generations/tasks/${payload.id}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const task = (await poll.json()) as {
    status?: string;
    content?: { video_url?: string };
    error?: { code?: string; message?: string };
  };
  const elapsed = Math.round((Date.now() - submitted) / 1000);
  console.log(`  ${elapsed}s ${task.status ?? poll.status}`);

  if (task.status === "succeeded") {
    console.log(`\nvideo: ${task.content?.video_url?.slice(0, 120)}...`);
    console.log("\nA presigned R2 link works as a reference_video.");
    break;
  }
  if (task.status === "failed" || task.status === "cancelled") {
    console.log(`\n${task.status}: ${task.error?.code} ${task.error?.message}`);
    process.exit(1);
  }
  if (elapsed > 900) {
    console.log("\ngave up after 15 minutes");
    process.exit(1);
  }
}
