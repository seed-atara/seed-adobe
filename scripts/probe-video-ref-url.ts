/**
 * Can a Seedance-generated clip be referenced by the URL Ark itself gave us?
 *
 * Video references must be a web URL and Ark provides no way to upload one —
 * but every clip Seedance generates is already served from Volcengine storage,
 * and that URL is kept in the generation's raw response. If it is still alive
 * when the artist wants to iterate, referencing a previous take costs nothing
 * and needs no hosting at all.
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const db = new DatabaseSync(
  path.join(process.env.SEED_AE_WORKSPACE ?? ".", ".seed-ae", "seed-ae.sqlite"),
);
const row = db
  .prepare(
    "select id, raw_response_json, created_at from generations " +
      "where operation='video.generate' and status='succeeded' " +
      "order by created_at desc limit 1",
  )
  .get() as Record<string, string>;

const url = String(row["raw_response_json"] ?? "").match(/https?:\/\/[^"\ ]+/)?.[0];
if (!url) {
  console.error("no url in the newest generation");
  process.exit(1);
}
console.log(`generation ${row["id"]} from ${row["created_at"]}`);

const head = await fetch(url, { method: "HEAD" });
console.log(`the clip's own URL: HTTP ${head.status}`,
            head.headers.get("content-length"), head.headers.get("content-type"));
if (!head.ok) {
  console.log("expired — a generated clip cannot reference itself forever");
  process.exit(0);
}

const base = process.env.ARK_BASE_URL ?? "";
const key = process.env.ARK_API_KEY ?? "";
const model = (process.env.SEEDANCE_MODEL_ID ?? "").split(",")[0]?.trim() ?? "";

const response = await fetch(`${base}/contents/generations/tasks`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model,
    content: [
      { type: "text", text: "same room, camera drifts left, warmer lanterns" },
      { type: "video_url", video_url: { url }, role: "reference_video" },
    ],
    duration: 5,
    resolution: "480p",
  }),
});
console.log(`\nreference_video with that URL: HTTP ${response.status}`);
console.log((await response.text()).slice(0, 500));
