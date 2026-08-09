/**
 * Watchdog for the Seedream path.
 *
 * Checks, on an interval:
 *   1. the local service is up
 *   2. it still has `seedream` registered (a missing ARK_API_KEY or model id
 *      silently drops the provider, leaving only the mock)
 *   3. the Ark credentials still authenticate
 *
 * The auth check deliberately posts a bogus model id. Ark rejects the model
 * *after* authenticating, so a model-shaped error proves the key works while
 * an AuthenticationError proves it does not — and neither generates an image,
 * so watching costs nothing.
 *
 *   node scripts/watch-seedream.mjs [--interval 60] [--once]
 */
import { existsSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logPath = path.join(repoRoot, ".seed-watchdog.log");

const args = process.argv.slice(2);
const once = args.includes("--once");
const intervalIndex = args.indexOf("--interval");
const intervalMs =
  (intervalIndex >= 0 ? Number(args[intervalIndex + 1]) || 60 : 60) * 1000;

function env() {
  const envPath = path.join(repoRoot, ".env");
  const out = {};
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const config = env();
const baseUrl = `http://127.0.0.1:${config.SEED_AE_PORT || "47831"}`;
const token = config.SEED_AE_SESSION_TOKEN || "";
const arkBase = config.ARK_BASE_URL || "";
const arkKey = config.ARK_API_KEY || "";

async function checkService() {
  try {
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) return { ok: false, detail: `health HTTP ${health.status}` };

    const response = await fetch(`${baseUrl}/v1/providers`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, detail: `providers HTTP ${response.status}` };

    const { providers } = await response.json();
    const ids = providers.map((p) => p.id);
    const seedream = providers.find((p) => p.id === "seedream");
    return {
      ok: Boolean(seedream),
      detail: seedream
        ? `registered, model=${seedream.models.join(",")}`
        : `MISSING - only [${ids.join(", ")}]`,
    };
  } catch (error) {
    return { ok: false, detail: `service unreachable (${error.message})` };
  }
}

async function checkArkAuth() {
  if (!arkKey) return { ok: false, detail: "ARK_API_KEY not set" };
  try {
    const response = await fetch(`${arkBase}/images/generations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${arkKey}`,
        "content-type": "application/json",
      },
      // Deliberately invalid model: rejected after auth, so it never bills.
      body: JSON.stringify({ model: "seed-ae-healthcheck", prompt: "ping" }),
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => ({}));
    const code = payload?.error?.code ?? "";
    const message = payload?.error?.message ?? "";

    if (response.status === 401 || /Authentication/i.test(code)) {
      return { ok: false, detail: `auth rejected: ${message.slice(0, 90)}` };
    }
    return { ok: true, detail: `auth ok (rejected the probe model: ${code || response.status})` };
  } catch (error) {
    return { ok: false, detail: `ark unreachable (${error.message})` };
  }
}

async function tick() {
  const service = await checkService();
  const ark = await checkArkAuth();
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const status = service.ok && ark.ok ? "OK  " : "FAIL";
  const line = `${stamp}  ${status}  provider: ${service.detail}  |  ark: ${ark.detail}`;
  console.log(line);
  appendFileSync(logPath, line + "\n");
  return service.ok && ark.ok;
}

await tick();
if (!once) {
  setInterval(() => {
    void tick();
  }, intervalMs);
}
