import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const db = new DatabaseSync(
  path.join(process.env.SEED_AE_WORKSPACE ?? ".", ".seed-ae", "seed-ae.sqlite"),
);
const rows = db
  .prepare(
    "select id, provider, raw_response_json, created_at from generations " +
      "where operation='video.generate' and status='succeeded' " +
      "order by created_at desc limit 3",
  )
  .all() as Array<Record<string, string>>;

for (const row of rows) {
  const raw = String(row["raw_response_json"] ?? "");
  const match = raw.match(/https?:\/\/[^"\ ]+/);
  console.log(row["id"], row["created_at"]);
  console.log("  ", match ? match[0].slice(0, 150) : "(no url in raw response)");
}
