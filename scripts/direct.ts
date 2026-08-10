/**
 * Composes a generation plan from the command line, without the panel.
 *
 * Direction has to be judged by reading what it writes, which is awkward
 * through a CEP panel. This runs the same code path the panel calls.
 *
 *   npx tsx scripts/direct.ts "a wider version of the bar, colder light"
 */
import { bootstrap } from "../apps/service/src/bootstrap.ts";
import { loadConfig, loadDotEnv } from "../apps/service/src/config.ts";

const description = process.argv.slice(2).join(" ").trim();
if (!description) {
  console.error('usage: npx tsx scripts/direct.ts "describe the shot"');
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
const deps = await bootstrap({ config });

if (!deps.director) {
  console.error("ANTHROPIC_API_KEY is not set — direction is unavailable.");
  process.exit(1);
}

// The panel offers the most recent frames; mirror that here.
const candidates = deps.assets.list({ limit: 6 }).assets;
console.log(`Candidates (${candidates.length}):`);
for (const [index, asset] of candidates.entries()) {
  console.log(`  ${index + 1}. ${asset.filename} (${asset.kind})`);
}
console.log(`\nDescription: ${description}\n`);

const startedAt = Date.now();
const plan = await deps.director.compose({
  request: {
    description,
    candidateAssetIds: candidates.map((asset) => asset.id),
    mentions: [],
  },
  candidates,
  providers: await deps.registry.describeAll(),
});

console.log(`--- plan (${Math.round((Date.now() - startedAt) / 1000)}s) ---`);
console.log(`provider   ${plan.providerId} / ${plan.model}`);
console.log(`operation  ${plan.operation}`);
if (plan.size) console.log(`size       ${plan.size}`);
if (plan.aspectRatio) console.log(`aspect     ${plan.aspectRatio}`);
if (plan.durationSeconds) console.log(`duration   ${plan.durationSeconds}s`);
console.log(`\nprompt:\n${plan.prompt}\n`);
if (plan.negativePrompt) console.log(`negative:\n${plan.negativePrompt}\n`);
console.log("references:");
for (const reference of plan.references) {
  const asset = candidates.find((item) => item.id === reference.assetId);
  console.log(`  ${reference.label}: ${asset?.filename} — ${reference.role}`);
}
console.log(`\nrationale:\n${plan.rationale}`);
if (plan.warnings.length > 0) {
  console.log(`\nwarnings:`);
  for (const warning of plan.warnings) console.log(`  - ${warning}`);
}

// Closing the database releases the handles the service opened; exiting hard
// instead trips a libuv teardown assertion on Windows.
deps.db.close();
