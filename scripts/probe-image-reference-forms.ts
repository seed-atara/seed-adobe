/**
 * What may the `image` parameter of images/generations actually be?
 *
 * Three forms are in play and only one of them has ever been verified:
 *
 *   data:image/png;base64,...   what SEED sends today, and what works
 *   https://...                 the form Volcengine's own examples show
 *   asset://<Asset_Id>          claimed by research, never tested
 *
 * The third matters because ADR 0005 built a whole reference policy on it. It
 * costs one generation to find out — the wrong forms are refused in seconds,
 * before anything renders.
 *
 *   npx tsx --env-file=.env scripts/probe-image-reference-forms.ts <image.png>
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ArkAssetLibrary } from "../packages/providers/src/ark/assetLibrary.js";
import { ArkOpenApiClient } from "../packages/providers/src/ark/openapi.js";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const base = process.env.ARK_BASE_URL ?? "";
const apiKey = process.env.ARK_API_KEY ?? "";
const model = process.env.SEEDREAM_MODEL_ID ?? "";
const file = process.argv[2];

if (!base || !apiKey || !model || !file) {
  console.error("usage: probe-image-reference-forms.ts <image.png> (needs ARK_* in .env)");
  process.exit(1);
}

const bytes = await readFile(file);
console.log(`${path.basename(file)}: ${(bytes.length / 1048576).toFixed(2)}MB`);

const publisher = new R2Publisher({
  endpoint: process.env.SEED_R2_ENDPOINT ?? "",
  bucket: process.env.SEED_R2_BUCKET ?? "",
  accessKeyId: process.env.SEED_R2_ACCESS_KEY_ID ?? "",
  secretAccessKey: process.env.SEED_R2_SECRET_ACCESS_KEY ?? "",
});
const { url } = await publisher.publish({
  bytes,
  filename: path.basename(file),
  mimeType: "image/png",
});
console.log("hosted.");

// An asset id to try. Registration is free, so this costs nothing but time.
const library = new ArkAssetLibrary({
  client: new ArkOpenApiClient({
    accessKeyId: process.env.SEED_ARK_AK ?? process.env.ARK_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.SEED_ARK_SK ?? process.env.ARK_SECRET_ACCESS_KEY ?? "",
    host: process.env.ARK_OPENAPI_HOST ?? "open.byteplusapi.com",
    region: process.env.ARK_REGION ?? "ap-southeast-1",
  }),
  publisher,
  groupName: process.env.ARK_ASSET_GROUP ?? "seed-ae",
  // The library's own sleep unrefs its timer, which is right inside a service
  // and fatal in a script: the loop empties and the process exits mid-poll.
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
});
const { assetId, cached } = await library.ensureAsset({
  bytes,
  filename: path.basename(file),
  mimeType: "image/png",
});
console.log(`asset ${assetId}${cached ? " (already registered)" : " (registered now)"}\n`);

const forms: { name: string; value: string }[] = [
  { name: "presigned https URL", value: url },
  { name: "asset://<id>", value: `asset://${assetId}` },
  { name: "bare asset id", value: assetId },
];

for (const form of forms) {
  const response = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "the same frame, graded one stop cooler",
      image: form.value,
      size: "2K",
      response_format: "url",
      watermark: false,
    }),
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { error?: { code?: string; message?: string }; data?: unknown[] }
    | undefined;

  if (response.ok) {
    console.log(`${form.name}: ACCEPTED — ${payload?.data?.length ?? 0} image(s) back`);
  } else {
    const message = (payload?.error?.message ?? "").replace(/\s*Request id:.*$/i, "");
    console.log(`${form.name}: HTTP ${response.status} — ${payload?.error?.code}: ${message}`);
  }
}
