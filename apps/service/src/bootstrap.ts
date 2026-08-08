import { MockAeHostAdapter, type AeHostAdapter } from "@seed-ae/ae-host";
import {
  AssetRepository,
  ensureWorkspace,
  openMigratedDatabase,
  resolveWorkspace,
} from "@seed-ae/storage";
import type { AppDepsInput } from "./app.js";
import type { ServiceConfig } from "./config.js";
import type { Logger } from "./logger.js";

export interface BootstrapOptions {
  config: ServiceConfig;
  logger?: Logger;
  /**
   * Injected in tests. Production selects a host adapter once the official
   * Adobe extension route is verified — see docs/research/ADOBE_INTEGRATION_NOTES.md.
   */
  aeHost?: AeHostAdapter;
}

export async function bootstrap({
  config,
  logger,
  aeHost,
}: BootstrapOptions): Promise<AppDepsInput> {
  const workspace = await ensureWorkspace(resolveWorkspace(config.workspaceRoot));
  const db = openMigratedDatabase({ path: workspace.databasePath });

  return {
    config,
    db,
    workspace,
    assets: new AssetRepository(db),
    aeHost: aeHost ?? new MockAeHostAdapter({ outputDir: workspace.originalsDir }),
    ...(logger ? { logger } : {}),
  };
}
