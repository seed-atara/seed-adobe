import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

/** Kept in step with apps/service/package.json. */
export const SERVICE_VERSION = "0.0.0";

export interface ServiceConfig {
  host: string;
  port: number;
  /** Shared secret the panel must present as `Authorization: Bearer <token>`. */
  sessionToken: string;
  /** Folder that will contain `.seed-ae/`. */
  workspaceRoot: string;
  /** True when the token was generated for this process rather than configured. */
  ephemeralToken: boolean;
  providers: ProviderConfig;
  pollIntervalMs: number;
}

export interface ProviderConfig {
  /** Seedream is registered only when both a key and a model id are present. */
  arkApiKey?: string;
  arkBaseUrl: string;
  seedreamModelId?: string;
  /** Seedance stays unregistered as a working provider until its API is verified. */
  seedanceModelId?: string;
  /** Path to a real video file the mock video provider replays. */
  mockVideoFixture?: string;
  /** Simulated latency for the mock image provider, so demos show job states. */
  mockLatencyMs: number;
}

export function loadDotEnv(cwd: string = process.cwd()): void {
  const envPath = path.join(cwd, ".env");
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const configuredToken = env.SEED_AE_SESSION_TOKEN?.trim();
  const isPlaceholder =
    !configuredToken || configuredToken === "replace-with-random-local-token";

  return {
    // Loopback-only by default: the service holds provider credentials.
    host: env.SEED_AE_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.SEED_AE_PORT) ?? 47831,
    sessionToken: isPlaceholder
      ? randomBytes(24).toString("base64url")
      : configuredToken,
    ephemeralToken: isPlaceholder,
    workspaceRoot: path.resolve(
      env.SEED_AE_WORKSPACE?.trim() || process.cwd(),
    ),
    pollIntervalMs: parsePositiveInt(env.SEED_AE_POLL_INTERVAL_MS) ?? 1000,
    providers: {
      ...(env.ARK_API_KEY?.trim() ? { arkApiKey: env.ARK_API_KEY.trim() } : {}),
      arkBaseUrl:
        env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com",
      ...(env.SEEDREAM_MODEL_ID?.trim()
        ? { seedreamModelId: env.SEEDREAM_MODEL_ID.trim() }
        : {}),
      ...(env.SEEDANCE_MODEL_ID?.trim()
        ? { seedanceModelId: env.SEEDANCE_MODEL_ID.trim() }
        : {}),
      ...(env.SEED_AE_MOCK_VIDEO_FIXTURE?.trim()
        ? { mockVideoFixture: path.resolve(env.SEED_AE_MOCK_VIDEO_FIXTURE.trim()) }
        : {}),
      mockLatencyMs: parsePositiveInt(env.SEED_AE_MOCK_LATENCY_MS) ?? 1500,
    },
  };
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`expected a non-negative integer, received: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SEED_AE_PORT is not a valid port: ${value}`);
  }
  return port;
}
