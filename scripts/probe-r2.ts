/**
 * Do the R2 credentials actually work, and is a presigned link fetchable?
 *
 * Everything downstream — video references, the `asset://` route — assumes a
 * bucket that accepts a signed PUT and serves a signed GET to a stranger. That
 * is two separate permissions and one signing convention, so it is measured
 * here before anything is built on top of it.
 *
 * Writes a small object, reads it back through a presigned URL with no
 * credentials attached, checks the bytes match, then deletes it.
 *
 *   npx tsx --env-file=.env scripts/probe-r2.ts [localFile]
 */
import { readFile } from "node:fs/promises";
import { R2Publisher } from "../packages/providers/src/publish/r2Publisher.js";

const endpoint = process.env.SEED_R2_ENDPOINT ?? "";
const bucket = process.env.SEED_R2_BUCKET ?? "";
const accessKeyId = process.env.SEED_R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.SEED_R2_SECRET_ACCESS_KEY ?? "";

if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error("Needs SEED_R2_ENDPOINT, SEED_R2_BUCKET, SEED_R2_ACCESS_KEY_ID, SEED_R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}

const publisher = new R2Publisher({
  endpoint,
  bucket,
  accessKeyId,
  secretAccessKey,
  prefix: "seed-ae/probe/",
  urlTtlSeconds: 300,
});

const local = process.argv[2];
const bytes = local
  ? await readFile(local)
  : Buffer.from(`seed-ae r2 probe\n${new Date().toISOString()}\n`, "utf8");
const filename = local ? local.replace(/^.*[\\/]/, "") : "probe.txt";
const mimeType = local ? "application/octet-stream" : "text/plain";

console.log(`endpoint ${endpoint}`);
console.log(`bucket   ${bucket}`);
console.log(`payload  ${bytes.length} bytes (${filename})`);

const key = publisher.keyFor(bytes, filename, mimeType);
console.log(`key      ${key}`);

const started = Date.now();
const { url } = await publisher.publish({ bytes, filename, mimeType });
console.log(`\nPUT ok in ${Date.now() - started}ms`);
console.log(`presigned URL: ${url.replace(/X-Amz-Signature=.*/, "X-Amz-Signature=<redacted>")}`);

// The point of the exercise: fetched with no credentials, the way Ark will.
const response = await fetch(url);
console.log(`\nGET (unauthenticated) HTTP ${response.status}`);
if (!response.ok) {
  console.log((await response.text()).slice(0, 400));
  process.exit(1);
}
const returned = Buffer.from(await response.arrayBuffer());
const same =
  returned.length === bytes.length && returned.equals(bytes);
console.log(`content-type: ${response.headers.get("content-type")}`);
console.log(`bytes back:   ${returned.length} — ${same ? "identical" : "DIFFERENT"}`);

/*
 * An unsigned URL must not work, or the bucket is public and the trust boundary
 * is not what the design claims. Any refusal will do — R2 answers 400 to a
 * request carrying no credentials at all, where S3 would say 403.
 */
const naked = `${endpoint.replace(/\/+$/, "")}${publisher.objectPath(key)}`;
const anonymous = await fetch(naked);
console.log(
  `\nGET without a signature: HTTP ${anonymous.status} — ` +
    (anonymous.ok
      ? "SERVED. The bucket is public; it should not be."
      : "refused, which is what we want"),
);

await publisher.remove(key);
console.log(`\ndeleted ${key}`);
console.log(same && !anonymous.ok ? "\nR2 hosting works." : "\nSomething is off — see above.");
