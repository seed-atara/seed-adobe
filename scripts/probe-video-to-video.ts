/**
 * The whole video-to-video path, through the service rather than around it.
 *
 * The probes proved the pieces: R2 accepts a signed PUT, Ark fetches a
 * presigned link, `duration: -1` is what a reference video wants. This runs
 * them as the product does — adopt a clip into the library, start a generation
 * with it as the reference, poll the job, and check the result registered with
 * lineage back to the clip.
 *
 * Costs one real generation.
 *
 *   npx tsx --env-file=.env scripts/probe-video-to-video.ts <clip.mp4> ["prompt"]
 */
import { createApp } from "../apps/service/src/app.js";
import { bootstrap } from "../apps/service/src/bootstrap.js";
import { loadConfig } from "../apps/service/src/config.js";
import { silentLogger } from "../apps/service/src/logger.js";

const clip = process.argv[2];
if (!clip) {
  console.error("usage: probe-video-to-video.ts <clip.mp4> [prompt]");
  process.exit(1);
}
const prompt =
  process.argv[3] ?? "the same motion, restyled as a charcoal drawing on grey paper";

const config = loadConfig(process.env);
const deps = await bootstrap({ config, logger: silentLogger });
const { server, deps: appDeps } = createApp(deps);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.sessionToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });

async function main(): Promise<void> {
  const providers = (await (await call("/v1/providers")).json()) as {
    providers: { id: string; videoReferences?: boolean; models: string[] }[];
  };
  const seedance = providers.providers.find(
    (provider) => provider.id.startsWith("seedance") && provider.videoReferences,
  );
  if (!seedance) throw new Error("no Seedance provider is registered");
  console.log(`provider ${seedance.id} (${seedance.models[0]})`);

  const adopted = await call("/v1/assets/adopt", {
    method: "POST",
    body: JSON.stringify({ path: clip }),
  });
  const { asset } = (await adopted.json()) as {
    asset: { id: string; filename: string; durationSeconds?: number };
  };
  console.log(
    `clip ${asset.id} — ${asset.filename}, ${asset.durationSeconds ?? "?"}s`,
  );

  const started = await call("/v1/generations", {
    method: "POST",
    body: JSON.stringify({
      providerId: seedance.id,
      operation: "video.generate",
      prompt,
      inputAssetIds: [asset.id],
      parameters: { size: "480p" },
    }),
  });
  const startedBody = (await started.json()) as {
    job?: { id: string };
    error?: unknown;
  };
  if (!started.ok || !startedBody.job) {
    throw new Error(`generation refused: ${JSON.stringify(startedBody).slice(0, 400)}`);
  }
  const jobId = startedBody.job.id;
  console.log(`job ${jobId} — polling`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const job = (await (await call(`/v1/jobs/${jobId}`)).json()) as {
      job: { status: string; errorMessage?: string };
      outputs?: {
        id: string;
        filename: string;
        width?: number;
        height?: number;
        durationSeconds?: number;
      }[];
    };
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${elapsed}s ${job.job.status}`);

    if (job.job.status === "succeeded") {
      const [output] = job.outputs ?? [];
      if (!output) throw new Error("succeeded with no output asset");
      console.log(
        `\nresult ${output.id} — ${output.filename}, ` +
          `${output.width}x${output.height}, ${output.durationSeconds}s`,
      );

      const lineage = (await (await call(`/v1/assets/${output.id}/lineage`)).json()) as unknown;
      const linked = JSON.stringify(lineage).includes(asset.id);
      console.log(`lineage names the source clip: ${linked}`);
      console.log("\nVideo-to-video works end to end through the service.");
      return;
    }
    if (job.job.status === "failed" || job.job.status === "cancelled") {
      throw new Error(`${job.job.status}: ${job.job.errorMessage}`);
    }
    if (elapsed > 900) throw new Error("gave up after 15 minutes");
  }
}

try {
  await main();
} finally {
  appDeps.generation.dispose();
  server.close();
  appDeps.db.close();
}
