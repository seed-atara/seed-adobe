/**
 * Does Seedance accept a video as a reference, and in what form?
 *
 * The adapter already builds the `video_url` part with role `reference_video`,
 * because the API says so when it is wrong. What has never been established is
 * whether a *data URL* is an acceptable value there — the images path works
 * inline, but a video is a thousand times larger and there is no reason to
 * assume the two are treated alike.
 *
 * This asks, with the smallest clip in the library, and reports exactly what
 * comes back. It submits a real job, so it costs a real generation.
 *
 *   npx tsx --env-file=.env scripts/probe-video-reference.ts <assetId>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const base = process.env.ARK_BASE_URL ?? "";
const key = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";
const workspace = process.env.SEED_AE_WORKSPACE ?? process.cwd();

if (!base || !key || !model) {
  console.error("Needs ARK_BASE_URL, ARK_API_KEY and SEEDANCE_MODEL_ID.");
  process.exit(1);
}

const assetId = process.argv[2];
const storage = process.argv[3];
if (!assetId || !storage) {
  console.error("usage: probe-video-reference.ts <assetId> <storageUri>");
  process.exit(1);
}

const file = path.join(workspace, ".seed-ae", storage);
const bytes = await readFile(file);
const dataUrl = `data:video/mp4;base64,${bytes.toString("base64")}`;
console.log(`clip ${assetId}: ${(bytes.length / 1048576).toFixed(2)}MB`);
console.log(`data URL length: ${dataUrl.length} characters`);

const body = {
  model,
  content: [
    { type: "text", text: "the same room, camera drifts left, lanterns warmer" },
    { type: "video_url", video_url: { url: dataUrl }, role: "reference_video" },
  ],
  duration: 5,
  resolution: "480p",
};

console.log(`\nPOST ${base}/contents/generations/tasks`);
const response = await fetch(`${base}/contents/generations/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

const text = await response.text();
console.log(`HTTP ${response.status}`);
console.log(text.slice(0, 900));
