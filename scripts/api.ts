/**
 * Talks to the running SEED service, so testing does not mean writing curl.
 *
 *   npx tsx scripts/api.ts GET /v1/items/stale
 *   npx tsx scripts/api.ts POST /v1/assets/colour-match '{"assetIds":["ast_a","ast_b"]}'
 *   npx tsx scripts/api.ts GET /v1/assets?limit=5 --raw
 *
 * The token comes from .env, so it never appears in a shell history or a
 * screenshot. Output is pretty-printed and, for the routes that answer with
 * long arrays, summarised — `--raw` prints exactly what came back.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2).filter((arg) => arg !== "--raw");
const raw = process.argv.includes("--raw");
const [method, target, body] = args;

if (!method || !target) {
  console.error(
    "usage: api.ts <METHOD> <path> [json body] [--raw]\n" +
      "  npx tsx scripts/api.ts GET /v1/items/stale",
  );
  process.exit(2);
}

const env = Object.fromEntries(
  (await readFile(path.join(root, ".env"), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const base = `http://${env.SEED_AE_HOST ?? "127.0.0.1"}:${env.SEED_AE_PORT ?? "47831"}`;
const token = env.SEED_AE_SESSION_TOKEN;
if (!token) {
  console.error("SEED_AE_SESSION_TOKEN is not in .env");
  process.exit(1);
}

let response: Response;
try {
  response = await fetch(`${base}${target}`, {
    method: method.toUpperCase(),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
} catch {
  console.error(
    `Could not reach the service at ${base}. Start it with \`npm run dev\`.`,
  );
  process.exit(1);
}

const text = await response.text();
console.log(`HTTP ${response.status}`);

if (raw) {
  console.log(text);
  process.exit(response.ok ? 0 : 1);
}

try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
process.exit(response.ok ? 0 : 1);
