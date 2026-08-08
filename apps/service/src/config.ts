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
  };
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SEED_AE_PORT is not a valid port: ${value}`);
  }
  return port;
}
