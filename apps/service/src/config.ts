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
  /**
   * Optional .epr still preset for Premiere frame export. Presets are
   * per-install, so SEED cannot ship one; without it Premiere relies on the
   * undocumented QE exporter alone.
   */
  pproStillPreset?: string;
  /** Present only when direction is configured; absent disables the feature. */
  director?: DirectorConfig;
}

export interface DirectorConfig {
  apiKey: string;
  /** Model id from configuration, so it can be changed without a release. */
  model: string;
}

export interface ProviderConfig {
  /**
   * Ark inference key (Bearer). Distinct from the AK/SK pair below: this one
   * authenticates image generation, that one signs the asset library OpenAPI.
   */
  arkApiKey?: string;
  arkBaseUrl: string;
  seedreamModelId?: string;
  /** Account access key pair for the asset library. */
  arkAccessKeyId?: string;
  arkSecretAccessKey?: string;
  arkOpenApiHost: string;
  arkRegion: string;
  arkAssetGroup: string;
  arkSkipModeration: boolean;
  /** How local frames reach the model — see ReferencePolicy. */
  arkReferencePolicy: "asset" | "asset-or-inline" | "inline";
  /** Seedance stays unregistered as a working provider until its API is verified. */
  seedanceModelId?: string;
  /** Path to a real video file the mock video provider replays. */
  mockVideoFixture?: string;
  /** Simulated latency for the mock image provider, so demos show job states. */
  mockLatencyMs: number;
}

/**
 * Loads `.env`, searching upward from the working directory.
 *
 * `npm run dev` runs the service with `apps/service` as its cwd, so looking
 * only at `process.cwd()` silently missed the repo-root `.env` — the service
 * started with no credentials and no configured workspace, which looks like a
 * broken install rather than a missing file.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
  let dir = path.resolve(startDir);

  for (;;) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
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
    ...(env.SEED_PPRO_STILL_PRESET?.trim()
      ? { pproStillPreset: path.resolve(env.SEED_PPRO_STILL_PRESET.trim()) }
      : {}),
    providers: {
      ...(env.ARK_API_KEY?.trim() ? { arkApiKey: env.ARK_API_KEY.trim() } : {}),
      arkBaseUrl:
        env.ARK_BASE_URL?.trim() || "https://ark.cn-beijing.volces.com",
      ...(env.SEEDREAM_MODEL_ID?.trim()
        ? { seedreamModelId: env.SEEDREAM_MODEL_ID.trim() }
        : {}),
      ...(readKey(env, "SEED_ARK_AK", "ARK_ACCESS_KEY_ID")
        ? { arkAccessKeyId: readKey(env, "SEED_ARK_AK", "ARK_ACCESS_KEY_ID") }
        : {}),
      ...(readKey(env, "SEED_ARK_SK", "ARK_SECRET_ACCESS_KEY")
        ? {
            arkSecretAccessKey: readKey(
              env,
              "SEED_ARK_SK",
              "ARK_SECRET_ACCESS_KEY",
            ),
          }
        : {}),
      arkOpenApiHost: env.ARK_OPENAPI_HOST?.trim() || "open.byteplusapi.com",
      arkRegion: env.ARK_REGION?.trim() || "ap-southeast-1",
      arkAssetGroup: env.ARK_ASSET_GROUP?.trim() || "seed-ae",
      arkSkipModeration: env.ARK_SKIP_MODERATION?.trim() === "true",
      arkReferencePolicy: parseReferencePolicy(env.ARK_REFERENCE_POLICY),
      ...(env.SEEDANCE_MODEL_ID?.trim()
        ? { seedanceModelId: env.SEEDANCE_MODEL_ID.trim() }
        : {}),
      ...(env.SEED_AE_MOCK_VIDEO_FIXTURE?.trim()
        ? { mockVideoFixture: path.resolve(env.SEED_AE_MOCK_VIDEO_FIXTURE.trim()) }
        : {}),
      mockLatencyMs: parsePositiveInt(env.SEED_AE_MOCK_LATENCY_MS) ?? 1500,
    },
    ...(env.ANTHROPIC_API_KEY?.trim()
      ? {
          director: {
            apiKey: env.ANTHROPIC_API_KEY.trim(),
            model: env.SEED_AE_DIRECTOR_MODEL?.trim() || "claude-opus-5",
          },
        }
      : {}),
  };
}

function readKey(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

const REFERENCE_POLICIES = ["asset", "asset-or-inline", "inline"] as const;

/**
 * Defaults to `asset-or-inline`. The `asset` policy is the correct choice when
 * references contain recognisable real people — it refuses to fall back to
 * posting raw pixels — but it needs a public URL publisher configured, so it
 * is opt-in rather than the default.
 */
function parseReferencePolicy(
  value: string | undefined,
): (typeof REFERENCE_POLICIES)[number] {
  const trimmed = value?.trim();
  if (!trimmed) return "asset-or-inline";
  if (!(REFERENCE_POLICIES as readonly string[]).includes(trimmed)) {
    throw new Error(
      `ARK_REFERENCE_POLICY must be one of ${REFERENCE_POLICIES.join(", ")}`,
    );
  }
  return trimmed as (typeof REFERENCE_POLICIES)[number];
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
