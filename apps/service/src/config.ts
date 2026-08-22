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
  /**
   * Optional .epr H.264 preset for Premiere range export.
   *
   * Same story as the still preset — per-install, so SEED cannot ship one —
   * except that almost nobody has made a user preset for H.264, so discovery
   * also looks where Adobe ships its own.
   */
  pproVideoPreset?: string;
  /**
   * A ProRes preset for clips that stay local.
   *
   * Separate from `pproVideoPreset`, which must stay in a codec Ark accepts:
   * a ProRes reference is not a better reference, it is a refused one. This is
   * the Premiere half of the delivery/quality split After Effects already makes
   * by choosing an output module template.
   */
  pproQualityPreset?: string;
  /** Present only when direction is configured; absent disables the feature. */
  director?: DirectorConfig;
}

export interface DirectorConfig {
  apiKey: string;
  /** Model id from configuration, so it can be changed without a release. */
  model: string;
  /**
   * How hard the model thinks before answering.
   *
   * Composition is a short creative task with a picture in front of it, not a
   * long chain of reasoning, and the default of high spends half a minute
   * proving it. Low is the right shape for the job and is where this starts.
   */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Premium-priced fast mode. Off unless someone chooses to pay for it. */
  fast: boolean;
}

export interface R2Settings {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Presigned link lifetime; only has to cover the provider's fetch. */
  urlTtlSeconds: number;
  /** Namespace inside the bucket. */
  prefix?: string;
  /** `auto` on R2; a real region on S3. */
  region?: string;
}

export interface ProviderConfig {
  /**
   * Ark inference key (Bearer). Distinct from the AK/SK pair below: this one
   * authenticates image generation, that one signs the asset library OpenAPI.
   */
  arkApiKey?: string;
  /** fal, for IC-Light. Absent means the relighter is simply not offered. */
  falKey?: string;
  falIcLightModel?: string;
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
  arkReferencePolicy: "hosted" | "hosted-or-inline" | "inline";
  /**
   * S3-compatible bucket used to hand media to a provider over https.
   *
   * Absent unless configured, and its absence is a real capability difference
   * rather than a detail: without it a video reference cannot be sent at all,
   * because Ark refuses an inline one.
   */
  r2?: R2Settings;
  /**
   * Seedance models to offer, in panel order.
   *
   * A list rather than one id: 2.0 and 2.5 differ in what they accept, and
   * choosing between them is a creative decision, not a deployment one.
   */
  seedanceModelIds: string[];
  /** How many reference images Seedance is offered; see the research notes. */
  seedanceMaxReferences?: number;
  /** Overrides the offered resolutions for every Seedance model. */
  seedanceSizes?: string[];
  /**
   * How many references to build item budgets against, as distinct from the
   * maximum validation will accept. Published stable range is 1-8.
   */
  seedanceStableReferences?: number;
  /**
   * Encoder quality: `high` is CRF 11 against `standard`'s 18.
   *
   * Defaults to `high` in the adapter. There is deliberately no container
   * setting here — `output_format` was measured on 2026-08-17 and does not
   * exist, so there is no MOV to choose and offering one would be a lie.
   */
  seedanceBitrateMode?: "standard" | "high";
  /**
   * Container, which on this API is really a chroma choice: `mov` is 4:4:4 and
   * `mp4` is 4:2:0, at the same resolution and price. Defaults to `mov`, and is
   * only sent to models that accept it.
   */
  seedanceOutputFormat?: "mov" | "mp4";
  /** Path to a real video file the mock video provider replays. */
  mockVideoFixture?: string;
  /** Simulated latency for the mock image provider, so demos show job states. */
  mockLatencyMs: number;
  /**
   * Whether to offer the mock providers at all.
   *
   * Off by default. They are for running the workflow without credentials, not
   * for choosing from a list next to the real thing.
   */
  mockProviders: boolean;
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
  const r2 = parseR2(env);

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
    ...(env.SEED_PPRO_VIDEO_PRESET?.trim()
      ? { pproVideoPreset: path.resolve(env.SEED_PPRO_VIDEO_PRESET.trim()) }
      : {}),
    ...(env.SEED_PPRO_QUALITY_PRESET?.trim()
      ? { pproQualityPreset: path.resolve(env.SEED_PPRO_QUALITY_PRESET.trim()) }
      : {}),
    providers: {
      ...(env.ARK_API_KEY?.trim() ? { arkApiKey: env.ARK_API_KEY.trim() } : {}),
      ...(env.FAL_KEY?.trim() ? { falKey: env.FAL_KEY.trim() } : {}),
      ...(env.FAL_ICLIGHT_MODEL?.trim()
        ? { falIcLightModel: env.FAL_ICLIGHT_MODEL.trim() }
        : {}),
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
      ...(r2 ? { r2 } : {}),
      seedanceModelIds: parseList(env.SEEDANCE_MODEL_ID),
      ...(parseList(env.SEEDANCE_SIZES).length > 0
        ? { seedanceSizes: parseList(env.SEEDANCE_SIZES) }
        : {}),
      ...(parsePositiveInt(env.SEEDANCE_MAX_REFERENCES)
        ? { seedanceMaxReferences: parsePositiveInt(env.SEEDANCE_MAX_REFERENCES) }
        : {}),
      ...(parsePositiveInt(env.SEEDANCE_STABLE_REFERENCES)
        ? { seedanceStableReferences: parsePositiveInt(env.SEEDANCE_STABLE_REFERENCES) }
        : {}),
      ...(env.SEEDANCE_BITRATE_MODE?.trim() === "standard" ||
      env.SEEDANCE_BITRATE_MODE?.trim() === "high"
        ? { seedanceBitrateMode: env.SEEDANCE_BITRATE_MODE.trim() as "standard" | "high" }
        : {}),
      ...(env.SEEDANCE_OUTPUT_FORMAT?.trim() === "mov" ||
      env.SEEDANCE_OUTPUT_FORMAT?.trim() === "mp4"
        ? { seedanceOutputFormat: env.SEEDANCE_OUTPUT_FORMAT.trim() as "mov" | "mp4" }
        : {}),
      ...(env.SEED_AE_MOCK_VIDEO_FIXTURE?.trim()
        ? { mockVideoFixture: path.resolve(env.SEED_AE_MOCK_VIDEO_FIXTURE.trim()) }
        : {}),
      mockLatencyMs: parsePositiveInt(env.SEED_AE_MOCK_LATENCY_MS) ?? 1500,
      mockProviders: env.SEED_AE_MOCK_PROVIDERS?.trim() === "true",
    },
    ...(env.ANTHROPIC_API_KEY?.trim()
      ? {
          director: {
            apiKey: env.ANTHROPIC_API_KEY.trim(),
            model: env.SEED_AE_DIRECTOR_MODEL?.trim() || "claude-opus-5",
            effort: parseEffort(env.SEED_AE_DIRECTOR_EFFORT),
            fast: env.SEED_AE_DIRECTOR_FAST?.trim() === "true",
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

/**
 * Reads the bucket settings, or nothing.
 *
 * All four of endpoint, bucket and the key pair are required together — a
 * half-configured bucket is a misconfiguration, and starting up as though
 * hosting worked would turn it into a failed generation later. Say it at
 * startup instead.
 */
function parseR2(env: NodeJS.ProcessEnv): R2Settings | undefined {
  const endpoint = env.SEED_R2_ENDPOINT?.trim();
  const bucket = env.SEED_R2_BUCKET?.trim();
  const accessKeyId = env.SEED_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SEED_R2_SECRET_ACCESS_KEY?.trim();

  const present = [endpoint, bucket, accessKeyId, secretAccessKey].filter(Boolean);
  if (present.length === 0) return undefined;
  if (present.length < 4) {
    throw new Error(
      "R2 hosting needs SEED_R2_ENDPOINT, SEED_R2_BUCKET, SEED_R2_ACCESS_KEY_ID " +
        "and SEED_R2_SECRET_ACCESS_KEY together; leave all four empty to disable it",
    );
  }

  return {
    endpoint: endpoint as string,
    bucket: bucket as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
    urlTtlSeconds: parsePositiveInt(env.SEED_R2_URL_TTL_SECONDS) ?? 3600,
    ...(env.SEED_R2_PREFIX?.trim() ? { prefix: env.SEED_R2_PREFIX.trim() } : {}),
    ...(env.SEED_R2_REGION?.trim() ? { region: env.SEED_R2_REGION.trim() } : {}),
  };
}

const REFERENCE_POLICIES = ["hosted", "hosted-or-inline", "inline"] as const;

/** What the old names meant, kept so an existing .env still starts. */
const POLICY_ALIASES: Record<string, (typeof REFERENCE_POLICIES)[number]> = {
  asset: "hosted",
  "asset-or-inline": "hosted-or-inline",
};

/**
 * Defaults to `hosted-or-inline`.
 *
 * `hosted` is the strict choice when references contain recognisable real
 * people: it puts the frame in the bucket and sends a link, and refuses to
 * fall back to posting raw pixels inline. It needs `SEED_R2_*`.
 *
 * The old `asset`/`asset-or-inline` names are accepted and mean the hosted
 * ones. They were named for a route that turned out not to exist —
 * images/generations rejects an asset id in every form — and renaming them
 * silently would have left a setting whose name describes something the
 * product does not do.
 */
function parseReferencePolicy(
  value: string | undefined,
): (typeof REFERENCE_POLICIES)[number] {
  const trimmed = value?.trim();
  if (!trimmed) return "hosted-or-inline";

  const aliased = POLICY_ALIASES[trimmed] ?? trimmed;
  if (!(REFERENCE_POLICIES as readonly string[]).includes(aliased)) {
    throw new Error(
      `ARK_REFERENCE_POLICY must be one of ${REFERENCE_POLICIES.join(", ")}`,
    );
  }
  return aliased as (typeof REFERENCE_POLICIES)[number];
}

/** A comma-separated setting, trimmed and without blanks. */
/** Effort level for the direction model, defaulting to the quick end. */
function parseEffort(value: string | undefined): DirectorConfig["effort"] {
  const wanted = (value ?? "").trim().toLowerCase();
  return wanted === "medium" || wanted === "high" || wanted === "xhigh" || wanted === "max"
    ? wanted
    : "low";
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
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
