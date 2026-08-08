import {
  SeedError,
  toSeedError,
  type Asset,
  type Generation,
  type StartGenerationRequest,
} from "@seed-ae/domain";
import type {
  GenerationProvider,
  ImageEditRequest,
  ImageGenerationRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  ProviderRegistry,
  VideoGenerationRequest,
} from "@seed-ae/providers";
import { isTerminal } from "@seed-ae/providers";
import type {
  AssetRepository,
  GenerationRepository,
  Job,
  JobRepository,
} from "@seed-ae/storage";
import type { Logger } from "../logger.js";
import type { InputMaterializer } from "./inputMaterializer.js";
import type { MediaIngestor } from "./mediaIngestor.js";

export interface GenerationServiceOptions {
  registry: ProviderRegistry;
  assets: AssetRepository;
  generations: GenerationRepository;
  jobs: JobRepository;
  materializer: InputMaterializer;
  ingestor: MediaIngestor;
  logger: Logger;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface StartResult {
  job: Job;
  generation: Generation;
}

/**
 * Owns the lifecycle of a generation: recipe in, job out, media and lineage
 * recorded on the way back.
 *
 * The HTTP request never waits for a provider. `start` persists the job and
 * returns; everything after that happens on a background task the panel polls.
 */
export class GenerationService {
  private readonly options: GenerationServiceOptions;
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private disposed = false;

  constructor(options: GenerationServiceOptions) {
    this.options = options;
  }

  async start(
    request: StartGenerationRequest,
    correlationId: string,
  ): Promise<StartResult> {
    const provider = this.options.registry.get(request.providerId);
    const capabilities = await provider.capabilities();
    const model = request.model ?? capabilities.models[0];

    if (!model) {
      throw new SeedError(
        "unsupported_capability",
        `provider ${provider.id} has no model configured`,
      );
    }
    assertSupported(capabilities, request, model);

    // Fail before creating a job if an input is unknown — a job that could
    // never run should not appear in history.
    const inputAssets = request.inputAssetIds.map((id) =>
      this.options.assets.requireById(id),
    );

    const job = this.options.jobs.create({
      provider: provider.id,
      model,
      operation: request.operation,
      correlationId,
    });

    const generation = this.options.generations.create({
      provider: provider.id,
      model,
      operation: request.operation,
      prompt: request.prompt,
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      parameters: {
        ...request.parameters,
        ...(request.size ? { size: request.size } : {}),
        ...(request.durationSeconds ? { durationSeconds: request.durationSeconds } : {}),
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      },
      inputAssetIds: request.inputAssetIds,
      ...(request.parentAssetId ? { parentAssetId: request.parentAssetId } : {}),
      ...(request.parentGenerationId
        ? { parentGenerationId: request.parentGenerationId }
        : {}),
      jobId: job.id,
    });

    const linkedJob = this.options.jobs.update(job.id, {
      generationId: generation.id,
    });

    this.options.logger.info("generation.started", {
      jobId: job.id,
      generationId: generation.id,
      provider: provider.id,
      model,
      operation: request.operation,
      inputCount: inputAssets.length,
      correlationId,
    });

    const task = this.run(linkedJob, generation, provider, capabilities, request, inputAssets)
      .catch((error: unknown) => {
        // run() handles its own failures; this only catches a bug in that path.
        this.options.logger.error("generation.task_crashed", {
          jobId: job.id,
          errorMessage: toSeedError(error).message,
        });
      })
      .finally(() => {
        this.running.delete(job.id);
      });

    this.running.set(job.id, task);
    return { job: linkedJob, generation };
  }

  /** Resolves once the background task for a job has finished. */
  async whenSettled(jobId: string): Promise<void> {
    await this.running.get(jobId);
  }

  async cancel(jobId: string): Promise<Job> {
    const job = this.options.jobs.requireById(jobId);
    if (isTerminal(job.status)) {
      throw new SeedError("conflict", `job ${jobId} has already finished`);
    }

    this.cancelled.add(jobId);
    const provider = this.options.registry.get(job.provider);
    if (job.providerJobId && provider.cancelJob) {
      await provider.cancelJob(job.providerJobId).catch((error: unknown) => {
        // A provider that cannot cancel does not block our own bookkeeping.
        this.options.logger.warn("generation.provider_cancel_failed", {
          jobId,
          errorMessage: toSeedError(error).message,
        });
      });
    }

    const updated = this.options.jobs.update(jobId, { status: "cancelled" });
    if (job.generationId) {
      this.options.generations.complete(job.generationId, { status: "cancelled" });
    }
    return updated;
  }

  /** Stops polling; in-flight tasks observe this and exit. */
  dispose(): void {
    this.disposed = true;
  }

  /**
   * Closes out jobs that were mid-flight when the process died.
   *
   * Their background tasks live in memory only, so after a restart nothing is
   * driving them — they would sit "running" forever and the panel would spin.
   * Marking them failed is honest; the recipe and lineage survive, so the user
   * can re-run from the recorded generation.
   */
  reconcileInterruptedJobs(): number {
    const stale = this.options.jobs.listUnfinished();
    for (const job of stale) {
      this.options.jobs.update(job.id, {
        status: "failed",
        errorClass: "interrupted",
        errorMessage: "the service restarted while this job was running",
      });
      if (job.generationId) {
        this.options.generations.complete(job.generationId, {
          status: "failed",
          errorClass: "interrupted",
          errorMessage: "the service restarted while this job was running",
        });
      }
    }
    if (stale.length > 0) {
      this.options.logger.warn("generation.interrupted_jobs_closed", {
        count: stale.length,
      });
    }
    return stale.length;
  }

  private async run(
    job: Job,
    generation: Generation,
    provider: GenerationProvider,
    capabilities: ProviderCapabilities,
    request: StartGenerationRequest,
    inputAssets: Asset[],
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      this.options.jobs.update(job.id, { status: "running", progress: 0 });
      this.options.generations.setStatus(generation.id, "running");

      // Seedream takes URLs/data URLs; the mock takes raw base64. Both need the
      // local file turned into something transportable first.
      const kind = provider.id === "seedream" ? "dataUrl" : "base64";
      const inputs = await this.options.materializer.materializeAll(inputAssets, kind);

      const submitted = await this.submit(provider, capabilities, request, generation, inputs);
      this.options.jobs.update(job.id, {
        providerJobId: submitted.providerJobId,
        // A provider-terminal state is NOT a job-terminal state: the outputs
        // still have to be downloaded and registered. A synchronous provider
        // (Seedream answers inline) would otherwise flip the job to
        // "succeeded" while it still has zero outputs, and anything polling
        // for completion would see a finished job with nothing in it.
        // finish()/fail() own the terminal status.
        status: "running",
        ...(submitted.state.progress !== undefined
          ? { progress: submitted.state.progress }
          : {}),
      });

      const finalState = await this.poll(job.id, provider, submitted);

      if (this.cancelled.has(job.id) || finalState.status === "cancelled") {
        this.finish(job.id, generation.id, "cancelled", [], finalState, startedAt);
        return;
      }

      if (finalState.status !== "succeeded") {
        const error = finalState.error ?? {
          class: "provider_error",
          message: "generation failed without a provider error",
        };
        this.fail(job.id, generation.id, error, finalState.raw, startedAt);
        return;
      }

      const outputs = finalState.outputs ?? [];
      if (outputs.length === 0) {
        this.fail(
          job.id,
          generation.id,
          { class: "provider_error", message: "provider reported success with no outputs" },
          finalState.raw,
          startedAt,
        );
        return;
      }

      const assets: Asset[] = [];
      for (const [index, output] of outputs.entries()) {
        assets.push(
          await this.options.ingestor.ingest(output, {
            generationId: generation.id,
            provider: provider.id,
            model: job.model,
            index,
          }),
        );
      }

      this.finish(
        job.id,
        generation.id,
        "succeeded",
        assets.map((asset) => asset.id),
        finalState,
        startedAt,
      );
    } catch (error) {
      const seedError = toSeedError(error);
      this.fail(
        job.id,
        generation.id,
        { class: seedError.code, message: seedError.message },
        undefined,
        startedAt,
      );
    }
  }

  private async submit(
    provider: GenerationProvider,
    capabilities: ProviderCapabilities,
    request: StartGenerationRequest,
    generation: Generation,
    inputs: MaterializedInput[],
  ): Promise<ProviderJob> {
    const base = {
      model: generation.model,
      prompt: request.prompt,
      ...(capabilities.seed && request.seed !== undefined ? { seed: request.seed } : {}),
      parameters: request.parameters,
      correlationId: generation.id,
    };

    if (request.operation === "image.generate") {
      if (!provider.generateImage) {
        throw new SeedError(
          "unsupported_capability",
          `${provider.id} cannot generate images`,
        );
      }
      const payload: ImageGenerationRequest = {
        ...base,
        ...(request.size ? { size: request.size } : {}),
        references: inputs,
      };
      return provider.generateImage(payload);
    }

    if (request.operation === "image.edit") {
      if (!provider.editImage) {
        throw new SeedError("unsupported_capability", `${provider.id} cannot edit images`);
      }
      const [subject, ...rest] = inputs;
      if (!subject) {
        throw new SeedError("bad_request", "image.edit requires an input asset");
      }
      const payload: ImageEditRequest = {
        ...base,
        ...(request.size ? { size: request.size } : {}),
        image: subject,
        references: rest,
      };
      return provider.editImage(payload);
    }

    if (!provider.generateVideo) {
      throw new SeedError("unsupported_capability", `${provider.id} cannot generate video`);
    }
    const [first, ...rest] = inputs;
    const payload: VideoGenerationRequest = {
      ...base,
      ...(request.durationSeconds ? { durationSeconds: request.durationSeconds } : {}),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(capabilities.startEndFrames && first ? { firstFrame: first } : {}),
      references: capabilities.startEndFrames ? rest : inputs,
    };
    return provider.generateVideo(payload);
  }

  private async poll(
    jobId: string,
    provider: GenerationProvider,
    submitted: ProviderJob,
  ): Promise<ProviderJobState> {
    if (isTerminal(submitted.state.status)) return submitted.state;

    const interval = this.options.pollIntervalMs ?? 1000;
    const maxAttempts = this.options.maxPollAttempts ?? 600;

    let state = submitted.state;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.disposed) return { status: "cancelled" };
      if (this.cancelled.has(jobId)) return { status: "cancelled" };

      state = await provider.getJob(submitted.providerJobId);
      this.options.jobs.update(jobId, {
        attempts: attempt,
        ...(state.progress !== undefined ? { progress: state.progress } : {}),
      });
      if (isTerminal(state.status)) return state;

      await sleep(interval);
    }

    return {
      status: "failed",
      error: {
        class: "provider_error",
        message: `provider job did not finish within ${maxAttempts} polls`,
      },
    };
  }

  private finish(
    jobId: string,
    generationId: string,
    status: "succeeded" | "cancelled",
    outputAssetIds: string[],
    state: ProviderJobState,
    startedAt: number,
  ): void {
    this.options.generations.complete(generationId, {
      status,
      outputAssetIds,
      ...(state.raw !== undefined ? { rawResponse: state.raw } : {}),
    });
    this.options.jobs.update(jobId, { status, progress: 1 });
    this.options.logger.info("generation.completed", {
      jobId,
      generationId,
      status,
      outputCount: outputAssetIds.length,
      durationMs: Date.now() - startedAt,
    });
  }

  private fail(
    jobId: string,
    generationId: string,
    error: { class: string; message: string },
    raw: unknown,
    startedAt: number,
  ): void {
    this.options.generations.complete(generationId, {
      status: "failed",
      errorClass: error.class,
      errorMessage: error.message,
      ...(raw !== undefined ? { rawResponse: raw } : {}),
    });
    this.options.jobs.update(jobId, {
      status: "failed",
      errorClass: error.class,
      errorMessage: error.message,
    });
    this.options.logger.warn("generation.failed", {
      jobId,
      generationId,
      errorClass: error.class,
      errorMessage: error.message,
      durationMs: Date.now() - startedAt,
    });
  }
}

function assertSupported(
  capabilities: ProviderCapabilities,
  request: StartGenerationRequest,
  model: string,
): void {
  if (!capabilities.operations.includes(request.operation)) {
    throw new SeedError(
      "unsupported_capability",
      `${capabilities.id} does not support ${request.operation}`,
      { details: { operations: capabilities.operations } },
    );
  }
  if (capabilities.models.length > 0 && !capabilities.models.includes(model)) {
    throw new SeedError("bad_request", `unknown model ${model}`, {
      details: { models: capabilities.models },
    });
  }
  if (request.inputAssetIds.length > capabilities.maxImageReferences) {
    throw new SeedError(
      "unsupported_capability",
      `${capabilities.id} accepts at most ${capabilities.maxImageReferences} references`,
    );
  }
  if (request.seed !== undefined && !capabilities.seed) {
    throw new SeedError(
      "unsupported_capability",
      `${capabilities.id} does not expose a verified seed parameter`,
    );
  }
  if (request.size && capabilities.sizes.length > 0 && !capabilities.sizes.includes(request.size)) {
    throw new SeedError("bad_request", `unsupported size ${request.size}`, {
      details: { sizes: capabilities.sizes },
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Never hold the process open just to poll.
    timer.unref?.();
  });
}
