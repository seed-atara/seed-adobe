/**
 * Lists the Ark foundation models the account can actually use, with their full
 * version-stamped ids — the value `SEEDREAM_MODEL_ID` expects.
 *
 * The console shows friendly names ("ByteDance-Seedream-4.0"); the API wants
 * `<Name>-<PrimaryVersion>`. This resolves one to the other.
 *
 * Uses the AK/SK pair (asset-library credentials), not the inference API key.
 *
 *   npx tsx --env-file=.env scripts/ark-models.ts [filter]
 */
import { ArkOpenApiClient } from "@seed-ae/providers";
import { minPixelsFor, WITHDRAWN_MODELS } from "@seed-ae/providers";

const filter = process.argv[2];

const client = new ArkOpenApiClient({
  accessKeyId: process.env.SEED_ARK_AK ?? "",
  secretAccessKey: process.env.SEED_ARK_SK ?? "",
  ...(process.env.ARK_OPENAPI_HOST ? { host: process.env.ARK_OPENAPI_HOST } : {}),
  ...(process.env.ARK_REGION ? { region: process.env.ARK_REGION } : {}),
  timeoutMs: 30_000,
});

interface FoundationModel {
  Name?: string;
  PrimaryVersion?: string;
  DisplayName?: string;
  FoundationModelTag?: { FilterTaskTypes?: string[] };
}

const result = await client.call<{ Items?: FoundationModel[] }>(
  "ListFoundationModels",
  { PageNumber: 1, PageSize: 100 },
);

const rows = (result.Items ?? [])
  .map((item) => ({
    id: `${item.Name ?? ""}-${item.PrimaryVersion ?? ""}`,
    display: item.DisplayName ?? "",
    task: (item.FoundationModelTag?.FilterTaskTypes ?? []).join(","),
  }))
  .filter((row) => !filter || row.id.includes(filter) || row.task.includes(filter))
  .sort((a, b) => a.task.localeCompare(b.task) || a.id.localeCompare(b.id));

for (const row of rows) {
  const minimum = minPixelsFor(row.id);
  const notes = [
    minimum ? `min ${minimum.toLocaleString("en-US")} px` : "",
    WITHDRAWN_MODELS[row.id] ? "WITHDRAWN" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  console.log(
    `${row.id.padEnd(34)} ${row.task.padEnd(16)} ${row.display.padEnd(30)} ${notes}`,
  );
}

console.log(`\n${rows.length} model(s).`);
