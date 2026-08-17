import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { SeedError, toSeedError } from "@seed-ae/domain";
import type { AeHostAdapter } from "@seed-ae/ae-host";
import type { ProviderRegistry } from "@seed-ae/providers";
import type {
  AssetRepository,
  Database,
  GenerationRepository,
  ItemRepository,
  JobRepository,
  WorkspaceLayout,
} from "@seed-ae/storage";
import type { ServiceConfig } from "./config.js";
import type { GenerationService } from "./generation/generationService.js";
import type { MediaIngestor } from "./generation/mediaIngestor.js";
import { isJsonResult, sendError, sendJson } from "./http/respond.js";
import { PromptDirector } from "./agent/director.js";
import type { ItemDescriber } from "./agent/describer.js";
import { Router, type RequestContext } from "./http/router.js";
import { lookLutRoute } from "./routes/look.js";
import { createLogger, type Logger } from "./logger.js";
import {
  aeContextRoute,
  captureFrameRoute,
  importAssetRoute,
  registerCaptureRoute,
  registerClipRoute,
} from "./routes/ae.js";
import {
  adoptFileRoute,
  getAssetFileRoute,
  getAssetPathRoute,
  getAssetRoute,
  listAssetsRoute,
  registerAssetRoute,
  placeholderRoute,
  removeAssetRoute,
  setPosterRoute,
  workspaceRoute,
} from "./routes/assets.js";
import {
  cancelJobRoute,
  getGenerationRoute,
  getJobRoute,
  lineageRoute,
  listGenerationsRoute,
  listJobsRoute,
  listProvidersRoute,
  recipeRoute,
  startGenerationRoute,
} from "./routes/generations.js";
import { composeRoute } from "./routes/agent.js";
import {
  addRevisionRoute,
  adoptItemRoute,
  createItemRoute,
  createVariantRoute,
  describeItemRoute,
  getItemRoute,
  itemGenerationsRoute,
  listItemsRoute,
  removeItemRoute,
  renameItemRoute,
  resolvePromptRoute,
  updateItemRoute,
} from "./routes/items.js";
import { exportPackRoute, importPackRoute } from "./routes/packs.js";
import { healthRoute } from "./routes/health.js";

export interface AppDeps {
  config: ServiceConfig;
  db: Database;
  assets: AssetRepository;
  generations: GenerationRepository;
  items: ItemRepository;
  jobs: JobRepository;
  registry: ProviderRegistry;
  generation: GenerationService;
  ingestor: MediaIngestor;
  workspace: WorkspaceLayout;
  aeHost: AeHostAdapter;
  /** Absent when ANTHROPIC_API_KEY is unset — direction is optional. */
  director?: PromptDirector;
  /** Absent for the same reason as the director: no key, no feature. */
  describer?: ItemDescriber;
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
    .post("/v1/ae/register-capture", registerCaptureRoute(deps))
    .post("/v1/ae/register-clip", registerClipRoute(deps))
    .post("/v1/ae/import", importAssetRoute(deps))
    .post("/v1/assets", registerAssetRoute(deps))
    .post("/v1/assets/adopt", adoptFileRoute(deps))
    .get("/v1/assets", listAssetsRoute(deps))
    .get("/v1/assets/:id", getAssetRoute(deps))
    .delete("/v1/assets/:id", removeAssetRoute(deps))
    .get("/v1/assets/:id/file", getAssetFileRoute(deps))
    .get("/v1/assets/:id/path", getAssetPathRoute(deps))
    .post("/v1/assets/:id/poster", setPosterRoute(deps))
    .get("/v1/assets/:id/lineage", lineageRoute(deps))
    .get("/v1/assets/:id/recipe", recipeRoute(deps))
    .post("/v1/look/lut", lookLutRoute(deps))
    .get("/v1/workspace", workspaceRoute(deps))
    .get("/v1/placeholder", placeholderRoute(deps))
    .get("/v1/providers", listProvidersRoute(deps))
    .post("/v1/agent/compose", composeRoute(deps))
    .post("/v1/items", createItemRoute(deps))
    .post("/v1/items/adopt", adoptItemRoute(deps))
    .post("/v1/items/resolve", resolvePromptRoute(deps))
    .post("/v1/items/describe", describeItemRoute(deps))
    // Literal paths before `:id`, or "import" is read as an item id.
    .post("/v1/items/import", importPackRoute(deps))
    .get("/v1/items", listItemsRoute(deps))
    .get("/v1/items/:id", getItemRoute(deps))
    .delete("/v1/items/:id", removeItemRoute(deps))
    .post("/v1/items/:id", updateItemRoute(deps))
    .post("/v1/items/:id/rename", renameItemRoute(deps))
    .post("/v1/items/:id/variants", createVariantRoute(deps))
    .post("/v1/items/:id/revisions", addRevisionRoute(deps))
    .get("/v1/items/:id/generations", itemGenerationsRoute(deps))
    .post("/v1/items/:id/export", exportPackRoute(deps))
    .post("/v1/generations", startGenerationRoute(deps))
    .get("/v1/generations", listGenerationsRoute(deps))
    .get("/v1/generations/:id", getGenerationRoute(deps))
    .get("/v1/jobs", listJobsRoute(deps))
    .get("/v1/jobs/:id", getJobRoute(deps))
    .post("/v1/jobs/:id/cancel", cancelJobRoute(deps));
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

    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

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

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * CORS for local panel hosts only: a Vite dev server today, a CEP panel (which
 * sends `Origin: null` from a file:// document) later. The session token — not
 * the origin — is the actual security boundary, but there is no reason to hand
 * arbitrary websites a preflight pass.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  if (origin !== "null" && !LOCAL_ORIGIN.test(origin)) return;

  res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-max-age", "600");
  res.setHeader("vary", "origin");
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
