import { createServer as createHttpServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { SeedError, toSeedError } from "@seed-ae/domain";
import type { AeHostAdapter } from "@seed-ae/ae-host";
import type { AssetRepository, Database, WorkspaceLayout } from "@seed-ae/storage";
import type { ServiceConfig } from "./config.js";
import { isJsonResult, sendError, sendJson } from "./http/respond.js";
import { Router, type RequestContext } from "./http/router.js";
import { createLogger, type Logger } from "./logger.js";
import { aeContextRoute, captureFrameRoute } from "./routes/ae.js";
import {
  getAssetFileRoute,
  getAssetRoute,
  listAssetsRoute,
  registerAssetRoute,
} from "./routes/assets.js";
import { healthRoute } from "./routes/health.js";

export interface AppDeps {
  config: ServiceConfig;
  db: Database;
  assets: AssetRepository;
  workspace: WorkspaceLayout;
  aeHost: AeHostAdapter;
  logger: Logger;
  startedAt: number;
}

export interface AppDepsInput extends Omit<AppDeps, "logger" | "startedAt"> {
  logger?: Logger;
  startedAt?: number;
}

export function buildRouter(deps: AppDeps): Router {
  return new Router()
    .get("/health", healthRoute(deps), { isPublic: true })
    .get("/v1/ae/context", aeContextRoute(deps))
    .post("/v1/ae/capture-frame", captureFrameRoute(deps))
    .post("/v1/assets", registerAssetRoute(deps))
    .get("/v1/assets", listAssetsRoute(deps))
    .get("/v1/assets/:id", getAssetRoute(deps))
    .get("/v1/assets/:id/file", getAssetFileRoute(deps));
}

export interface App {
  deps: AppDeps;
  server: Server;
}

export function createApp(input: AppDepsInput): App {
  const deps: AppDeps = {
    ...input,
    logger: input.logger ?? createLogger(),
    startedAt: input.startedAt ?? Date.now(),
  };
  const router = buildRouter(deps);

  const server = createHttpServer((req, res) => {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    void (async () => {
      try {
        const { route, params } = router.match(req.method ?? "GET", url.pathname);
        if (!route.isPublic) {
          authorize(req.headers.authorization, deps.config.sessionToken);
        }

        const ctx: RequestContext = { req, res, url, params, correlationId };
        const result = await route.handler(ctx);

        if (res.writableEnded) return;
        if (isJsonResult(result)) {
          sendJson(res, result.status, result.body, correlationId);
        } else {
          sendJson(res, 204, null, correlationId);
        }
      } catch (error) {
        if (res.writableEnded) {
          deps.logger.error("request.failed_after_response", {
            correlationId,
            errorMessage: toSeedError(error).message,
          });
          return;
        }
        const seedError = sendError(res, error, correlationId);
        deps.logger.warn("request.error", {
          correlationId,
          method: req.method,
          path: url.pathname,
          code: seedError.code,
          status: seedError.httpStatus,
          errorMessage: seedError.message,
        });
      } finally {
        deps.logger.info("request.completed", {
          correlationId,
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }
    })();
  });

  return { deps, server };
}

/**
 * Constant-time bearer check. The token is shared between the panel and the
 * service so a stray page on localhost cannot drive After Effects.
 */
function authorize(header: string | undefined, expected: string): void {
  const provided = header?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!provided) {
    throw new SeedError("unauthorized", "missing session token");
  }
  const providedBuffer = Buffer.from(provided, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const equal =
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer);
  if (!equal) {
    throw new SeedError("unauthorized", "invalid session token");
  }
}
