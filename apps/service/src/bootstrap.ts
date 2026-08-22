import { MockAeHostAdapter, type AeHostAdapter } from "@seed-ae/ae-host";
import {
  ArkAssetLibrary,
  ICLightProvider,
  ArkOpenApiClient,
  LookProvider,
  MockImageProvider,
  MockVideoProvider,
  ProviderRegistry,
  R2Publisher,
  SeedanceProvider,
  seedanceProviderId,
  SeedreamProvider,
} from "@seed-ae/providers";
import {
  AssetRepository,
  GenerationRepository,
  ItemRepository,
  JobRepository,
  ensureWorkspace,
  openMigratedDatabase,
  resolveWorkspace,
} from "@seed-ae/storage";
import { PromptDirector } from "./agent/director.js";
import { ItemDescriber } from "./agent/describer.js";
import type { AppDepsInput } from "./app.js";
import type { ProviderConfig, ServiceConfig } from "./config.js";
import { GenerationService } from "./generation/generationService.js";
import { InputMaterializer } from "./generation/inputMaterializer.js";
import { MediaIngestor } from "./generation/mediaIngestor.js";
import { createLogger, type Logger } from "./logger.js";
import { findStillPreset, findVideoPreset } from "./pproPresets.js";

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
  const items = new ItemRepository(db);
  const jobs = new JobRepository(db);
  const ingestor = new MediaIngestor(workspace, assets, (reason, assetId) => {
    activeLogger.warn("asset.thumbnail_failed", { assetId, reason });
  });
  // One publisher, shared: it remembers what it has already uploaded, and two
  // instances would upload the same reference twice.
  const publisher = createPublisher(config.providers, activeLogger);
  const providerRegistry =
    registry ?? buildRegistry(config.providers, activeLogger, publisher);

  const generation = new GenerationService({
    registry: providerRegistry,
    assets,
    generations,
    items,
    jobs,
    materializer: new InputMaterializer(workspace, publisher),
    ingestor,
    logger: activeLogger,
    pollIntervalMs: config.pollIntervalMs,
  });

  // Anything left running belongs to a process that no longer exists.
  generation.reconcileInterruptedJobs();

  // Premiere frame export needs a still preset. Look for one rather than
  // making the artist hunt down a file path.
  let stillPreset = config.pproStillPreset;
  if (!stillPreset) {
    const discovered = await findStillPreset();
    if (discovered) {
      stillPreset = discovered.path;
      activeLogger.info("ppro.still_preset_found", {
        name: discovered.name,
        path: discovered.path,
      });
    }
  }

  // The same for video: without one, Premiere cannot export a range at all.
  let videoPreset = config.pproVideoPreset;
  if (!videoPreset) {
    const discovered = await findVideoPreset();
    if (discovered) {
      videoPreset = discovered.path;
      activeLogger.info("ppro.video_preset_found", {
        name: discovered.name,
        path: discovered.path,
        codec: discovered.codec,
        ...(discovered.codec === "HEVC"
          ? {
              note:
                "no H.264 preset was found, so this falls back to HEVC — the " +
                "same container, a codec no provider has been shown to accept. " +
                "Export an H.264 preset from Premiere's Export Settings dialog " +
                "to replace it.",
            }
          : {}),
      });
    } else {
      activeLogger.info("ppro.video_preset_missing", {
        reason:
          "no exported H.264 or HEVC preset in Documents/Adobe. Premiere " +
          "cannot render a range without one — export one from its Export " +
          "Settings dialog, or set SEED_PPRO_VIDEO_PRESET. Adobe's factory " +
          "presets are a different file format and cannot be used.",
      });
    }
  }

  /*
   * And a quality preset, for a clip that is not going to a provider. Looked
   * for separately and allowed to be absent: most installs will have no ProRes
   * preset exported, and that is not a failure — it just means the quality
   * route is unavailable and delivery is used throughout.
   */
  let qualityPreset = config.pproQualityPreset;
  if (!qualityPreset) {
    const discovered = await findVideoPreset(undefined, "quality");
    if (discovered && discovered.codec === "ProRes") {
      qualityPreset = discovered.path;
      activeLogger.info("ppro.quality_preset_found", {
        name: discovered.name,
        path: discovered.path,
        codec: discovered.codec,
      });
    }
  }

  // Catch up any asset that never got a thumbnail. Not awaited: the service
  // should start serving immediately, and a missing thumbnail is cosmetic.
  void (async () => {
    const { done, failed } = await ingestor.backfillThumbnails();
    if (done > 0 || failed > 0) {
      activeLogger.info("asset.thumbnails_backfilled", { done, failed });
    }

    // Videos cannot be decoded here, so they borrow the poster of the frame
    // they were generated from.
    let posters = 0;
    for (const video of assets.listMissingThumbnails(200, "video")) {
      /*
       * A captured clip carries the still that was rendered with it. Prefer it
       * over anything borrowed: it is this clip's own first frame, and the
       * only reason it would be missing a thumbnail is that the file had not
       * finished being written when it was registered.
       */
      const recorded =
        video.source.type === "after-effects" ? video.source.posterUri : undefined;
      if (recorded) {
        const written = await ingestor.thumbnailFromPoster(video.id, recorded);
        if (written) {
          posters += 1;
          continue;
        }
      }

      const generation = video.generationId
        ? generations.getById(video.generationId)
        : undefined;
      const source = generation?.inputAssetIds[0];
      if (source && (await ingestor.adoptPoster(video.id, source))) posters += 1;
    }
    if (posters > 0) activeLogger.info("asset.posters_backfilled", { posters });
  })().catch((error: unknown) => {
    activeLogger.warn("asset.thumbnail_backfill_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    config: {
      ...config,
      ...(stillPreset ? { pproStillPreset: stillPreset } : {}),
      ...(videoPreset ? { pproVideoPreset: videoPreset } : {}),
      ...(qualityPreset ? { pproQualityPreset: qualityPreset } : {}),
    },
    db,
    workspace,
    assets,
    generations,
    items,
    jobs,
    registry: providerRegistry,
    generation,
    ingestor,
    aeHost: aeHost ?? new MockAeHostAdapter({ outputDir: workspace.originalsDir }),
    // Direction is optional: without a key the panel simply does not offer it.
    ...(config.director
      ? {
          director: new PromptDirector({
            apiKey: config.director.apiKey,
            model: config.director.model,
            effort: config.director.effort,
            fast: config.director.fast,
            workspace,
          }),
          describer: new ItemDescriber({
            apiKey: config.director.apiKey,
            model: config.director.model,
            effort: config.director.effort,
            fast: config.director.fast,
            workspace,
          }),
        }
      : {}),
    logger: activeLogger,
  };
}

/**
 * Registers only providers that are actually usable. A provider missing its
 * credentials or its verified contract is left out rather than registered in a
 * state where the panel would offer it and then fail.
 */
/**
 * Builds the bucket-backed publisher, or nothing.
 *
 * Nothing is a working configuration: images travel inline and always have.
 * What it costs is video references, which Ark will not accept inline, and the
 * `asset://` route — so the absence is logged rather than left to be discovered
 * as a failed generation.
 */
export function createPublisher(
  config: ProviderConfig,
  logger: Logger,
): R2Publisher | undefined {
  if (!config.r2) {
    logger.info("publish.hosting_unconfigured", {
      reason: "SEED_R2_* are not set; video references cannot be sent",
    });
    return undefined;
  }
  const publisher = new R2Publisher({
    endpoint: config.r2.endpoint,
    bucket: config.r2.bucket,
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
    urlTtlSeconds: config.r2.urlTtlSeconds,
    ...(config.r2.prefix ? { prefix: config.r2.prefix } : {}),
    ...(config.r2.region ? { region: config.r2.region } : {}),
  });
  logger.info("publish.hosting_ready", {
    bucket: config.r2.bucket,
    urlTtlSeconds: config.r2.urlTtlSeconds,
  });
  return publisher;
}

export function buildRegistry(
  config: ProviderConfig,
  logger: Logger,
  publisher?: R2Publisher,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  /*
   * The film look needs no credential and reaches no network, so it is always
   * available — there is no configuration under which offering it would fail.
   * Registered first because it is the one thing here that always works.
   */
  registry.register(new LookProvider());

  /*
   * Mocks exist so the workflow can be exercised without credentials, and that
   * was worth a permanent slot while Seedance was unverified. It is verified
   * now, so they are off unless asked for: a mock sitting first in the panel's
   * provider list is something to pick by accident, and the result only looks
   * wrong later.
   */
  if (config.mockProviders) {
    registry.register(new MockImageProvider({ latencyMs: config.mockLatencyMs }));
  }

  /*
   * The asset library, built once for whoever can use it.
   *
   * It used to be constructed inside the Seedream branch and handed only to
   * Seedream — the one provider that cannot use it, since images/generations
   * refuses an asset id in any form (ADR 0010). Seedance, which accepts
   * `asset://` for video and is the provider that actually needs the
   * sanctioned route, never received one. That is why references were still
   * travelling as links and coming back "may contain real person".
   *
   * Optional, and uses the *other* credential type: an AK/SK pair signs the
   * OpenAPI, and cannot authenticate inference.
   */
  let assetLibrary: ArkAssetLibrary | undefined;
  if (config.arkApiKey && config.arkAccessKeyId && config.arkSecretAccessKey) {
    assetLibrary = new ArkAssetLibrary({
      client: new ArkOpenApiClient({
        accessKeyId: config.arkAccessKeyId,
        secretAccessKey: config.arkSecretAccessKey,
        host: config.arkOpenApiHost,
        region: config.arkRegion,
      }),
      groupName: config.arkAssetGroup,
      skipModeration: config.arkSkipModeration,
      // CreateAsset fetches the file itself, so registration needs somewhere
      // Ark can read from — the same bucket video references use.
      ...(publisher ? { publisher } : {}),
    });
  }

  if (config.arkApiKey && config.seedreamModelId) {
    registry.register(
      new SeedreamProvider({
        baseUrl: config.arkBaseUrl,
        apiKey: config.arkApiKey,
        model: config.seedreamModelId,
        referencePolicy: config.arkReferencePolicy,
        ...(assetLibrary ? { assetLibrary } : {}),
        ...(publisher ? { publisher } : {}),
      }),
    );

    if (config.arkReferencePolicy !== "inline" && !publisher) {
      logger.warn("provider.reference_hosting_unavailable", {
        reason: "SEED_R2_* are not set; image references go inline as data URLs",
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

  if (config.mockProviders && config.mockVideoFixture) {
    registry.register(
      new MockVideoProvider({
        fixturePath: config.mockVideoFixture,
        latencyMs: config.mockLatencyMs,
      }),
    );
  }

  // Seedance shares Seedream's Bearer credential; only the model differs.
  if (config.arkApiKey && config.seedanceModelIds.length > 0) {
    /*
     * One provider per model, rather than one provider listing several.
     * Capabilities are declared per provider — resolutions, durations, whether
     * a seed is honoured — and those differ between 2.0 and 2.5, so a single
     * entry would have to claim the union of them and mislead the panel.
     */
  /*
   * IC-Light, where a key exists.
   *
   * Registered separately from Ark because it answers a different question:
   * Seedance makes a new shot, this relights one that exists. Absent a key it
   * is simply not offered, rather than appearing and failing on use.
   */

  if (config.falKey) {
    registry.register(
      new ICLightProvider({
        apiKey: config.falKey,
        ...(config.falIcLightModel ? { model: config.falIcLightModel } : {}),
      }),
    );
    logger.info("provider.registered", { provider: "iclight-v2" });
  }

    for (const model of config.seedanceModelIds) {
      registry.register(
        new SeedanceProvider({
          baseUrl: config.arkBaseUrl,
          apiKey: config.arkApiKey,
          model,
          id: seedanceProviderId(model),
          /*
           * Say so when a reference could not be registered. The generation
           * still goes out with a link, and is likely to come back refused as
           * "may contain real person" — a message that describes the symptom
           * and not the cause. This line is the cause.
           */
          onAssetFallback: ({ mimeType, reason }) =>
            logger.warn("ark.asset.fallback", {
              provider: seedanceProviderId(model),
              mimeType,
              reason,
            }),
          ...(config.seedanceMaxReferences
            ? { maxReferences: config.seedanceMaxReferences }
            : {}),
          ...(config.seedanceSizes ? { sizes: config.seedanceSizes } : {}),
          ...(config.seedanceStableReferences
            ? { stableReferences: config.seedanceStableReferences }
            : {}),
          ...(config.seedanceBitrateMode
            ? { bitrateMode: config.seedanceBitrateMode }
            : {}),
          ...(config.seedanceOutputFormat
            ? { outputFormat: config.seedanceOutputFormat }
            : {}),
          // The sanctioned route for anything that may contain a person.
          ...(assetLibrary ? { assetLibrary } : {}),
        }),
      );
    }
  } else {
    logger.warn("provider.seedance_unavailable", {
      reason: config.arkApiKey
        ? "SEEDANCE_MODEL_ID is not set"
        : "ARK_API_KEY is not set",
    });
  }

  return registry;
}
