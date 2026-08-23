/**
 * Clears expansion samples out of the library.
 *
 * Sampling used to register every still it took, so a dozen frames landed in
 * the library per attempt. It no longer does — samples now live in
 * `.seed-ae/samples` and are never registered — but the ones already there have
 * to be swept up.
 *
 *   npx tsx --env-file=.env scripts/clean-samples.ts            # list only
 *   npx tsx --env-file=.env scripts/clean-samples.ts --delete   # remove them
 *
 * Dry by default, and it never touches a frame some generation used as an
 * input: that one is not clutter, it is provenance.
 */
const remove = process.argv.includes("--delete");
const baseUrl =
  process.argv.find((a) => a.startsWith("http")) ??
  `http://127.0.0.1:${process.env.SEED_AE_PORT ?? 47831}`;
const token = process.env.SEED_AE_SESSION_TOKEN ?? "";

async function call(route: string, method = "GET") {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(`${method} ${route} -> ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload as any;
}

/** `HERO_s0012.png` — the name the host gives a sampled still. */
const SAMPLE = /_s\d+\.png$/i;

const found: Array<{ id: string; filename: string }> = [];
for (let offset = 0; ; offset += 200) {
  const page = await call(`/v1/assets?limit=200&offset=${offset}`);
  const assets: Array<{ id: string; filename: string; source: { type: string } }> =
    page.assets ?? [];
  for (const asset of assets) {
    if (asset.source?.type === "after-effects" && SAMPLE.test(asset.filename)) {
      found.push({ id: asset.id, filename: asset.filename });
    }
  }
  if (assets.length < 200) break;
}

if (found.length === 0) {
  console.log("No expansion samples in the library.");
} else {
  console.log(`${found.length} sampled frame(s):`);
  for (const asset of found.slice(0, 20)) {
    console.log(`  ${asset.id}  ${asset.filename}`);
  }
  if (found.length > 20) console.log(`  … and ${found.length - 20} more`);

  /*
   * Which frames some generation actually used.
   *
   * Gathered before anything is deleted, because the delete route reports
   * `usedBy` only *after* it has already removed the file — checking it there
   * would let this claim it kept something it had just thrown away.
   */
  const used = new Set<string>();
  for (let offset = 0; ; offset += 200) {
    const page = await call(`/v1/generations?limit=200&offset=${offset}`);
    const generations: Array<{ inputAssetIds?: string[]; parentAssetId?: string }> =
      page.generations ?? [];
    for (const generation of generations) {
      for (const id of generation.inputAssetIds ?? []) used.add(id);
      if (generation.parentAssetId) used.add(generation.parentAssetId);
    }
    if (generations.length < 200) break;
  }

  const spare = found.filter((asset) => !used.has(asset.id));
  const keeping = found.length - spare.length;
  if (keeping > 0) {
    console.log(`
${keeping} of those are inputs to a generation and will be kept.`);
  }

  if (!remove) {
    console.log(`
Dry run. Re-run with --delete to remove ${spare.length}.`);
  } else {
    for (const asset of spare) await call(`/v1/assets/${asset.id}`, "DELETE");
    console.log(`
Removed ${spare.length}; kept ${keeping} that generations reference.`);
  }
}
