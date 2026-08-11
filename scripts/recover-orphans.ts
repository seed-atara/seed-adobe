/**
 * Recovers renders that finished after SEED stopped listening.
 *
 * A job marked "the service restarted while this job was running" was
 * abandoned by us, not by the provider — the render usually completed and was
 * paid for. This asks the provider about every such job, and ingests whatever
 * is still downloadable into the library, attached to its original generation
 * so the recipe and lineage stay intact.
 *
 *   npx tsx --env-file=.env scripts/recover-orphans.ts [--apply]
 *
 * Without --apply it only reports what it would recover.
 */
import { bootstrap } from "../apps/service/src/bootstrap.ts";
import { loadConfig, loadDotEnv } from "../apps/service/src/config.ts";

const apply = process.argv.includes("--apply");

loadDotEnv();
const config = loadConfig();
const deps = await bootstrap({ config });

const base = config.providers.arkBaseUrl;
const key = config.providers.arkApiKey;
if (!key) {
  console.error("ARK_API_KEY is not set");
  process.exit(1);
}

const abandoned = deps.jobs
  .listRecent(200)
  .filter((job) => job.status === "failed" && job.providerJobId);

console.log(`${abandoned.length} failed job(s) with a provider task to check\n`);

let recovered = 0;
for (const job of abandoned) {
  const response = await fetch(
    `${base}/contents/generations/tasks/${job.providerJobId}`,
    { headers: { authorization: `Bearer ${key}` } },
  );
  const task = (await response.json()) as {
    status?: string;
    content?: { video_url?: string };
  };

  const url = task.content?.video_url;
  console.log(`${job.providerJobId}  ${task.status ?? "unknown"}`);
  if (task.status !== "succeeded" || !url) {
    console.log("   nothing to recover\n");
    continue;
  }
  if (!job.generationId) {
    console.log("   no generation to attach it to\n");
    continue;
  }

  const generation = deps.generations.getById(job.generationId);
  if (generation?.outputAssetIds.length) {
    console.log("   already collected\n");
    continue;
  }

  if (!apply) {
    console.log("   WOULD RECOVER (re-run with --apply)\n");
    recovered += 1;
    continue;
  }

  const asset = await deps.ingestor.ingest(
    { mimeType: "video/mp4", url },
    {
      generationId: job.generationId,
      provider: job.provider,
      model: job.model,
      index: 0,
    },
  );
  deps.generations.complete(job.generationId, {
    status: "succeeded",
    outputAssetIds: [asset.id],
  });
  deps.jobs.update(job.id, { status: "succeeded", errorMessage: "" });

  console.log(
    `   recovered ${asset.filename} (${Math.round((asset.byteSize ?? 0) / 1024)}KB)\n`,
  );
  recovered += 1;
}

console.log(
  apply ? `Recovered ${recovered}.` : `${recovered} recoverable; re-run with --apply.`,
);
deps.db.close();
