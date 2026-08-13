/**
 * Does Seedance accept a registered asset id where it wants a video URL?
 *
 * images/generations does not — `asset://<id>` and a bare id are both "invalid
 * url specified". The video endpoint is a different service with a different
 * content-part shape, and if it does accept an asset id that is a better route
 * than a presigned link: registration is permanent, so a reference used across
 * sessions never depends on a signature that expires.
 *
 * Registration is free; only a request that gets past validation costs
 * anything.
 *
 *   npx tsx --env-file=.env scripts/probe-asset-id-for-video.ts <clip.mp4>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArkAssetLibrary } from "../packages/providers/src/ark/assetLibrary.js";
import { ArkOpenApiClient } from "../packages/providers/src/ark/openapi.js";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const base = process.env.ARK_BASE_URL ?? "";
const apiKey = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";
const clip = process.argv[2];

if (!base || !apiKey || !model || !clip) {
  console.error("usage: probe-asset-id-for-video.ts <clip.mp4> (needs ARK_* in .env)");
  process.exit(1);
}

const publisher = new R2Publisher({
  endpoint: process.env.SEED_R2_ENDPOINT ?? "",
  bucket: process.env.SEED_R2_BUCKET ?? "",
  accessKeyId: process.env.SEED_R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.SEED_R2_SECRET_ACCESS_KEY ?? "",
});

const bytes = await readFile(clip);
console.log(`${path.basename(clip)}: ${(bytes.length / 1048576).toFixed(2)}MB`);

const library = new ArkAssetLibrary({
  client: new ArkOpenApiClient({
    accessKeyId: process.env.SEED_ARK_AK ?? process.env.ARK_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.SEED_ARK_SK ?? process.env.ARK_SECRET_ACCESS_KEY ?? "",
    host: process.env.ARK_OPENAPI_HOST ?? "open.byteplusapi.com",
    region: process.env.ARK_REGION ?? "ap-southeast-1",
  }),
  publisher,
  groupName: process.env.ARK_ASSET_GROUP ?? "seed-ae",
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});

const { assetId, cached } = await library.ensureAsset({
  bytes,
  filename: path.basename(clip),
  mimeType: "video/mp4",
});
console.log(`asset ${assetId}${cached ? " (already registered)" : " (registered now)"}\n`);

for (const value of [`asset://${assetId}`, assetId]) {
  const response = await fetch(`${base}/contents/generations/tasks`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      content: [
        { type: "text", text: "the same movement, restyled as an ink drawing" },
        { type: "video_url", video_url: { url: value }, role: "reference_video" },
      ],
      duration: -1,
      resolution: "480p",
    }),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { id?: string; error?: { code?: string; message?: string } }
    | undefined;

  if (response.ok && payload?.id) {
    console.log(`${value.slice(0, 24)}...: ACCEPTED as task ${payload.id}`);
    console.log("  (it passed validation — a running task will be billed)");
  } else {
    const message = (payload?.error?.message ?? "").replace(/\s*Request id:.*$/i, "");
    console.log(`${value.slice(0, 24)}...: HTTP ${response.status} — ${payload?.error?.code}: ${message}`);
  }
}
