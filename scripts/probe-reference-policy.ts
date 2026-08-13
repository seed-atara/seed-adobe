/**
 * Does `ARK_REFERENCE_POLICY=hosted` keep raw pixels out of the request?
 *
 * ADR 0005 wanted a route for references containing recognisable real people
 * that does not post raw pixels inline on every request. It named the asset
 * library; that turned out not to be referenceable at inference. The route
 * that does exist is a link to our own bucket.
 *
 * This forces the strict policy on, runs one real image edit from a frame
 * already in the library, and reports what the stored request actually
 * carried. Costs one Seedream generation.
 *
 *   npx tsx --env-file=.env scripts/probe-reference-policy.ts [assetId]
 */
import { createApp } from "../apps/service/src/app.js";
import { bootstrap } from "../apps/service/src/bootstrap.js";
import { loadConfig } from "../apps/service/src/config.js";
import { silentLogger } from "../apps/service/src/logger.js";

// The whole point of the run: the policy that refuses to fall back to inline.
const config = loadConfig({ ...process.env, ARK_REFERENCE_POLICY: "hosted" });
if (!config.providers.arkAccessKeyId || !config.providers.arkSecretAccessKey) {
  console.error("Needs SEED_ARK_AK / SEED_ARK_SK — the asset library uses AK/SK, not the API key.");
  process.exit(1);
}
if (!config.providers.r2) {
  console.error("Needs SEED_R2_* — CreateAsset fetches the file over https.");
  process.exit(1);
}

const deps = await bootstrap({ config, logger: silentLogger });
const { server, deps: appDeps } = createApp(deps);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };

const call = (path: string, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.sessionToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });

async function main(): Promise<void> {
  let assetId = process.argv[2];
  if (!assetId) {
    const { assets } = (await (await call("/v1/assets?limit=40&kind=image")).json()) as {
      assets: { id: string; filename: string; status: string }[];
    };
    const usable = assets.find((asset) => asset.status === "ready");
    if (!usable) throw new Error("no ready image in the library to reference");
    assetId = usable.id;
    console.log(`reference ${assetId} — ${usable.filename}`);
  }

  const started = await call("/v1/generations", {
    method: "POST",
    body: JSON.stringify({
      providerId: "seedream",
      operation: "image.edit",
      prompt: "the same frame, graded cooler and a stop darker",
      inputAssetIds: [assetId],
    }),
  });
  const body = (await started.json()) as { job?: { id: string } };
  if (!started.ok || !body.job) {
    throw new Error(`refused: ${JSON.stringify(body).slice(0, 500)}`);
  }
  console.log(`job ${body.job.id} — registering the reference, then generating`);

  const startedAt = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const detail = (await (await call(`/v1/jobs/${body.job.id}`)).json()) as {
      job: { status: string; errorMessage?: string };
      generation?: { id: string };
      outputs?: { id: string; filename: string; width?: number; height?: number }[];
    };
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${elapsed}s ${detail.job.status}`);

    if (detail.job.status === "succeeded") {
      const [output] = detail.outputs ?? [];
      console.log(`\nresult ${output?.id} — ${output?.filename}, ${output?.width}x${output?.height}`);

      // What did the request actually carry? Registered, or quietly inline?
      const recipe = (await (await call(`/v1/assets/${output?.id}/recipe`)).json()) as unknown;
      const text = JSON.stringify(recipe);
      const hosted = /"image":\s*"https:\/\//.test(text) || /X-Amz-Signature/.test(text);
      const inline = /"image":\s*"data:image/.test(text);
      console.log(
        `\nreference sent as: ${
          inline ? "an inline data URL" : hosted ? "a link to the bucket" : "unrecognised"
        }`,
      );
      console.log(
        hosted && !inline
          ? "\nARK_REFERENCE_POLICY=hosted works — no raw pixels in the request."
          : "\nThe policy did not take. Check the stored rawRequest.",
      );
      return;
    }
    if (detail.job.status === "failed" || detail.job.status === "cancelled") {
      throw new Error(`${detail.job.status}: ${detail.job.errorMessage}`);
    }
    if (elapsed > 600) throw new Error("gave up after 10 minutes");
  }
}

try {
  await main();
} finally {
  appDeps.generation.dispose();
  server.close();
  appDeps.db.close();
}
