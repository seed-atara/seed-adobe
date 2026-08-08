import { MockAeHostAdapter, type AeHostAdapter } from "@seed-ae/ae-host";
import {
  ArkAssetLibrary,
  ArkOpenApiClient,
  MockImageProvider,
  MockVideoProvider,
  ProviderRegistry,
  SeedanceProvider,
  SeedreamProvider,
} from "@seed-ae/providers";
import {
  AssetRepository,
  GenerationRepository,
  JobRepository,
  ensureWorkspace,
  openMigratedDatabase,
  resolveWorkspace,
} from "@seed-ae/storage";
import type { AppDepsInput } from "./app.js";
import type { ProviderConfig, ServiceConfig } from "./config.js";
import { GenerationService } from "./generation/generationService.js";
import { InputMaterializer } from "./generation/inputMaterializer.js";
import { MediaIngestor } from "./generation/mediaIngestor.js";
import { createLogger, type Logger } from "./logger.js";

export interface BootstrapOptions {
  config: ServiceConfig;
  logger?: Logger;
  /**
   * Injected in tests. Production selects a host adapter once the Adobe
   * extension is built — see docs/research/ADOBE_INTEGRATION_NOTES.md.
   */
  aeHost?: AeHostAdapter;
  registry?: ProviderRegistry;
}

export async function bootstrap({
  config,
  logger,
  aeHost,
  registry,
}: BootstrapOptions): Promise<AppDepsInput> {
  const activeLogger = logger ?? createLogger();
  const workspace = await ensureWorkspace(resolveWorkspace(config.workspaceRoot));
  const db = openMigratedDatabase({ path: workspace.databasePath });

  const assets = new AssetRepository(db);
  const generations = new GenerationRepository(db);
  const jobs = new JobRepository(db);
  const ingestor = new MediaIngestor(workspace, assets);
  const providerRegistry = registry ?? buildRegistry(config.providers, activeLogger);

  const generation = new GenerationService({
    registry: providerRegistry,
    assets,
    generations,
    jobs,
    materializer: new InputMaterializer(workspace),
    ingestor,
    logger: activeLogger,
    pollIntervalMs: config.pollIntervalMs,
  });

  return {
    config,
    db,
    workspace,
    assets,
    generations,
    jobs,
    registry: providerRegistry,
    generation,
    ingestor,
    aeHost: aeHost ?? new MockAeHostAdapter({ outputDir: workspace.originalsDir }),
    logger: activeLogger,
  };
}

/**
 * Registers only providers that are actually usable. A provider missing its
 * credentials or its verified contract is left out rather than registered in a
 * state where the panel would offer it and then fail.
 */
export function buildRegistry(
  config: ProviderConfig,
  logger: Logger,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  registry.register(new MockImageProvider({ latencyMs: config.mockLatencyMs }));

  if (config.arkApiKey && config.seedreamModelId) {
    // The asset library is optional and uses the *other* credential type.
    let assetLibrary: ArkAssetLibrary | undefined;
    if (config.arkAccessKeyId && config.arkSecretAccessKey) {
      assetLibrary = new ArkAssetLibrary({
        client: new ArkOpenApiClient({
          accessKeyId: config.arkAccessKeyId,
          secretAccessKey: config.arkSecretAccessKey,
          host: config.arkOpenApiHost,
          region: config.arkRegion,
        }),
        groupName: config.arkAssetGroup,
        skipModeration: config.arkSkipModeration,
      });
    }

    registry.register(
      new SeedreamProvider({
        baseUrl: config.arkBaseUrl,
        apiKey: config.arkApiKey,
        model: config.seedreamModelId,
        referencePolicy: config.arkReferencePolicy,
        ...(assetLibrary ? { assetLibrary } : {}),
      }),
    );

    if (config.arkReferencePolicy !== "inline" && !assetLibrary) {
      logger.warn("provider.ark_asset_library_unavailable", {
        reason: "SEED_ARK_AK / SEED_ARK_SK are not set; references go inline",
        referencePolicy: config.arkReferencePolicy,
      });
    }
  } else {
    logger.warn("provider.seedream_unavailable", {
      reason: config.arkApiKey
        ? "SEEDREAM_MODEL_ID is not set"
        : "ARK_API_KEY is not set (an AK/SK pair cannot authenticate inference)",
    });
  }

  if (config.mockVideoFixture) {
    registry.register(
      new MockVideoProvider({
        fixturePath: config.mockVideoFixture,
        latencyMs: config.mockLatencyMs,
      }),
    );
  }

  // Always constructed so its capabilities can be shown as "pending", never
  // registered as something the panel can actually run.
  const seedance = new SeedanceProvider({
    ...(config.seedanceModelId ? { model: config.seedanceModelId } : {}),
  });
  if (seedance.configured) {
    logger.warn("provider.seedance_config_ignored", {
      reason: "the Seedance 2.5 API contract is not verified; adapter is inert",
    });
  }

  return registry;
}
