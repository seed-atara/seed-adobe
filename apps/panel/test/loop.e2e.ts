/**
 * Drives the full V1 loop against a *running* SEED service using the panel's
 * own client, so the path the UI takes is the path that gets verified.
 *
 * Not part of `npm test` (it needs a live service). Run with:
 *   npx tsx apps/panel/test/loop.e2e.ts <baseUrl> <token>
 */
import { SeedClient } from "../src/api/client.ts";

const [, , baseUrl = "http://127.0.0.1:47831", token = "demo-token"] =
  process.argv;
const client = new SeedClient(baseUrl, token);

const step = (name: string, detail: string) =>
  console.log(`${name.padEnd(26)} ${detail}`);

const health = await client.health();
step("health", `${health.status} · schema v${health.database.schemaVersion}`);

const { providers } = await client.providers();
step("providers", providers.map((p) => p.id).join(", "));

const { context } = await client.aeContext();
step("ae context", `${context.compName} · frame ${context.frameNumber}`);

const { asset: frame } = await client.captureFrame();
step("capture", `${frame.id} · ${frame.width}x${frame.height} · thumb=${Boolean(frame.thumbnailUri)}`);

const provider = providers[0];
if (!provider) throw new Error("no providers registered");

const started = await client.startGeneration({
  providerId: provider.id,
  operation: "image.edit",
  prompt: "moody night grade, volumetric fog",
  seed: 1234,
  size: provider.sizes[0],
  inputAssetIds: [frame.id],
});
step("generate", `${started.job.id} · ${started.job.status}`);

let view = started;
const deadline = Date.now() + 30_000;
while (!["succeeded", "failed", "cancelled"].includes(view.job.status)) {
  if (Date.now() > deadline) throw new Error("job did not settle in 30s");
  await new Promise((resolve) => setTimeout(resolve, 300));
  view = await client.job(view.job.id);
}
step("job settled", `${view.job.status} · ${view.outputs.length} output(s)`);
if (view.job.status !== "succeeded") {
  throw new Error(`generation failed: ${view.job.errorMessage}`);
}

const output = view.outputs[0];
if (!output) throw new Error("no output asset");
step("output", `${output.id} · ${output.filename} · thumb=${Boolean(output.thumbnailUri)}`);

const lineage = await client.lineage(output.id);
step(
  "lineage",
  `${lineage.assets.length} assets · ${lineage.edges.length} edge(s) · root=${lineage.rootAssetId === output.id}`,
);
if (!lineage.assets.some((a) => a.id === frame.id)) {
  throw new Error("lineage lost the captured frame");
}

const { recipe } = await client.recipe(output.id);
step("recipe", `"${recipe.prompt}" · seed ${recipe.seed}`);

const variation = await client.startGeneration({
  ...recipe,
  seed: 5678,
});
let varied = variation;
while (!["succeeded", "failed", "cancelled"].includes(varied.job.status)) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  varied = await client.job(varied.job.id);
}
step(
  "variation",
  `${varied.job.status} · branched from ${varied.generation?.parentGenerationId?.slice(0, 12)}…`,
);

const imported = await client.importAsset(output.id, true);
step("import", `${imported.name} · playhead=${imported.insertedAtPlayhead}`);

const { assets } = await client.listAssets({ limit: 100 });
step("library", `${assets.length} assets`);

console.log("\nV1 loop OK");
