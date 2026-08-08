import { getSchemaVersion } from "@seed-ae/storage";
import type { AppDeps } from "../app.js";
import { SERVICE_VERSION } from "../config.js";
import { json } from "../http/respond.js";

export function healthRoute(deps: AppDeps) {
  return () =>
    json({
      status: "ok",
      service: "seed-ae",
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      database: {
        path: deps.workspace.databasePath,
        schemaVersion: getSchemaVersion(deps.db),
      },
    });
}
