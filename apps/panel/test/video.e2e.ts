/**
 * Drives one real Seedance video generation from a captured After Effects
 * frame, against a running service.
 *
 * This costs money — every run creates a billable task — so it defaults to the
 * cheapest settings that still prove the path, and it uses an existing library
 * asset rather than capturing a new one.
 *
 *   npx tsx apps/panel/test/video.e2e.ts <baseUrl> <token> [seconds] [resolution]
 */
import { SeedClient } from "../src/api/client.ts";

const [, , baseUrl = "http://127.0.0.1:47831", token = "", seconds = "3", resolution = "480p"] =
  process.argv;
const client = new SeedClient(baseUrl, token);

const step = (name: string, detail: string) =>
  console.log(`${name.padEnd(24)} ${detail}`);

const { providers } = await client.providers();
const seedance = providers.find((p) => p.id === "seedance");
if (!seedance) throw new Error(`seedance not registered; have: ${providers.map((p) => p.id).join(", ")}`);
step("provider", `${seedance.id} · ${seedance.models.join(",")}`);

// Use the newest After Effects capture already in the library.
const { assets } = await client.listAssets({ limit: 60, kind: "image" });
const frame = assets.find((a) => a.source.type === "after-effects" && a.status === "ready");
if (!frame) throw new Error("no After Effects capture in the library to work from");
step("reference", `${frame.filename} · ${frame.width}x${frame.height}`);

const started = await client.startGeneration({
  providerId: "seedance",
  operation: "video.generate",
  prompt:
    "Image 1 is the reference. Hold the framing and slowly push in; " +
    "dust drifts through the light. Cinematic, no cuts.",
  inputAssetIds: [frame.id],
  durationSeconds: Number(seconds),
  aspectRatio: "16:9",
  parameters: { size: resolution },
});
step("submitted", `${started.job.id} · ${started.job.status}`);

let view = started;
const deadline = Date.now() + 15 * 60 * 1000;
let lastStatus = "";
while (!["succeeded", "failed", "cancelled"].includes(view.job.status)) {
  if (Date.now() > deadline) throw new Error("job did not settle within 15 minutes");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  view = await client.job(view.job.id);
  if (view.job.status !== lastStatus) {
    lastStatus = view.job.status;
    step("status", `${view.job.status} (${new Date().toISOString().slice(11, 19)})`);
  }
}

if (view.job.status !== "succeeded") {
  throw new Error(`generation ${view.job.status}: ${view.job.errorMessage}`);
}

const output = view.outputs[0];
if (!output) throw new Error("succeeded with no output asset");
step("output", `${output.filename} · ${output.kind} · ${output.mimeType}`);
step("size", `${Math.round((output.byteSize ?? 0) / 1024)} KB`);

const lineage = await client.lineage(output.id);
step("lineage", `${lineage.assets.length} assets · ${lineage.edges.length} edge(s)`);
if (!lineage.assets.some((a) => a.id === frame.id)) {
  throw new Error("lineage lost the source frame");
}

const { recipe } = await client.recipe(output.id);
step("recipe", `${recipe.providerId} · ${recipe.operation} · seed ${recipe.seed ?? "-"}`);

console.log("\nSeedance video loop OK");
