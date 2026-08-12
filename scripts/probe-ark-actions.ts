/**
 * Which asset actions does the Ark OpenAPI actually have?
 *
 * Video references must be a web URL, and CreateAsset fetches from one too, so
 * the question is whether Ark will take the bytes at all. Volcengine's other
 * media services use an apply/upload/commit flow, so if the asset library has
 * one it will be named like theirs.
 *
 * An unknown action and a known one that dislikes its arguments answer
 * differently, which is the whole point: the error text tells us which is
 * which without needing documentation we cannot reach.
 *
 *   npx tsx --env-file=.env scripts/probe-ark-actions.ts
 */
import { ArkOpenApiClient } from "@seed-ae/providers";

const client = new ArkOpenApiClient({
  accessKeyId: process.env.SEED_ARK_AK ?? "",
  secretAccessKey: process.env.SEED_ARK_SK ?? "",
  host: process.env.ARK_OPENAPI_HOST ?? "open.byteplusapi.com",
  region: process.env.ARK_REGION ?? "ap-southeast-1",
});

const candidates = [
  "CreateAsset",
  "ListAssets",
  "GetAsset",
  "ApplyUploadInfo",
  "CommitUpload",
  "GetUploadAuth",
  "ApplyUpload",
  "UploadAsset",
  "CreateUploadTask",
  "GetAssetUploadURL",
  "CreateAssetUpload",
];

for (const action of candidates) {
  try {
    const result = await client.call(action, {});
    console.log(`${action.padEnd(22)} OK      ${JSON.stringify(result).slice(0, 110)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const known = !/not\s*found|unknown|invalid\s*action|does not exist/i.test(message);
    console.log(
      `${action.padEnd(22)} ${known ? "EXISTS " : "absent "} ${message.slice(0, 110)}`,
    );
  }
}
