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
  /**
   * How many consecutive failures to reach the provider end a job.
   *
   * Not one: the render is already running and already paid for, and a poll
   * that cannot be sent says nothing about it.
   */
  maxPollErrors?: number;
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
      /*
       * Everything the request said, so the recipe can be run again.
       *
       * Roles and the audio switch are recorded for the same reason size and
       * duration are: without them a reopened recipe is a different generation
       * wearing the same prompt. Roles especially — "this frame is where the
       * shot ends" is not recoverable by guessing from a list of inputs.
       */
      parameters: {
        ...request.parameters,
        ...(request.size ? { size: request.size } : {}),
        ...(request.durationSeconds ? { durationSeconds: request.durationSeconds } : {}),
        ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
        ...(request.generateAudio ? { generateAudio: true } : {}),
        ...(request.inputRoles && request.inputRoles.length > 0
          ? { inputRoles: request.inputRoles }
          : {}),
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
      /*
       * A task that reached the provider is still running there. The process
       * that died was only the one listening — the render was not cancelled
       * (Ark cannot be), and it will be billed either way. So pick the
       * listening back up rather than declaring a finished clip a failure,
       * which is how three completed videos were thrown away.
       */
      if (job.providerJobId && job.generationId && this.resume(job)) continue;

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
        resumed: this.running.size,
      });
    }
    return stale.length;
  }

  /**
   * Re-attaches to a task that outlived the process that started it.
   *
   * Returns false when it cannot — an unknown provider, a generation that is
   * gone — and the caller then closes the job out as interrupted, which is the
   * old behaviour and still the right one when there is nothing to re-attach
   * to.
   */
  private resume(job: Job): boolean {
    const generation = job.generationId
      ? this.options.generations.getById(job.generationId)
      : undefined;
    if (!generation) return false;

    let provider: GenerationProvider;
    try {
      provider = this.options.registry.get(job.provider);
    } catch {
      // The provider is no longer registered — credentials changed, or a model
      // was withdrawn. Nothing here can ask about the task.
      return false;
    }

    const inputAssets = generation.inputAssetIds
      .map((id) => this.options.assets.getById(id))
      .filter((asset): asset is Asset => asset !== undefined);

    this.options.logger.info("generation.resumed", {
      jobId: job.id,
      generationId: generation.id,
      providerJobId: job.providerJobId,
    });

    const task = this.awaitAndIngest(
      job,
      generation,
      provider,
      // Status unknown until the first poll; "running" is what it was.
      { providerJobId: job.providerJobId as string, state: { status: "running" } },
      inputAssets,
      Date.now(),
    )
      .catch((error: unknown) => {
        this.options.logger.error("generation.resume_crashed", {
          jobId: job.id,
          errorMessage: toSeedError(error).message,
        });
      })
      .finally(() => {
        this.running.delete(job.id);
      });

    this.running.set(job.id, task);
    return true;
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
      // Ark accepts an image inline and refuses a video the same way — the
      // clip has to be somewhere it can fetch from. Only Ark providers are
      // asked to pay for hosting; the mocks and the look run on local bytes.
      const hostVideo = provider.id.startsWith("seedance") || provider.id === "seedream";
      const inputs = await this.options.materializer.materializeAll(inputAssets, kind, {
        hostVideo,
      });

      const submitted = await this.submit(provider, capabilities, request, generation, inputs);

      /*
       * What went on the wire, kept beside what was asked for. The adapter
       * decides the reference form and normalizes parameters, so the two are
       * different documents — and the difference is the whole content of a
       * question like "was that frame sent inline or as a link".
       */
      if (submitted.rawRequest !== undefined) {
        this.options.generations.setRawRequest(generation.id, submitted.rawRequest);
      }

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

      await this.awaitAndIngest(job, generation, provider, submitted, inputAssets, startedAt);
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

  /**
   * Everything after a task exists at the provider: wait for it, download it,
   * register it.
   *
   * Separate from submission because a restarted service has to do exactly
   * this and nothing else — the task is already running, and the only thing
   * lost with the process was whoever was listening.
   */
  private async awaitAndIngest(
    job: Job,
    generation: Generation,
    provider: GenerationProvider,
    submitted: ProviderJob,
    inputAssets: Asset[],
    startedAt: number,
  ): Promise<void> {
    try {
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

      // A generated clip has no decodable thumbnail; borrow the reference
      // frame's, which for image-to-video is its own first frame.
      const posterSource = inputAssets[0];
      if (posterSource) {
        for (const asset of assets) {
          if (asset.kind === "video" && !asset.thumbnailUri) {
            await this.options.ingestor.adoptPoster(asset.id, posterSource.id);
          }
        }
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
    /*
     * Where the caller said what each input is for, that is used. Where it did
     * not, a single image anchors the opening frame and several are
     * references — the old guess, kept so an older panel still behaves.
     *
     * The two are exclusive modes at the provider, not degrees of one thing;
     * the adapter enforces that, with the API's own wording.
     */
    const roles = request.inputRoles;
    let firstFrame: MaterializedInput | undefined;
    let lastFrame: MaterializedInput | undefined;
    let references: MaterializedInput[] = [];

    /*
     * A frame role is only meaningful for a still. A clip is motion — it can
     * be referenced but it cannot *be* the first frame, and the panel's "a
     * lone input anchors the shot" rule would otherwise hand Ark a video under
     * an image role.
     */
    const isFrame = (input: MaterializedInput) => input.mimeType.startsWith("image/");

    if (roles && roles.length > 0 && capabilities.startEndFrames) {
      inputs.forEach((input, index) => {
        const role = roles[index] ?? "reference";
        if (role === "first" && !firstFrame && isFrame(input)) firstFrame = input;
        else if (role === "last" && !lastFrame && isFrame(input)) lastFrame = input;
        else references.push(input);
      });
    } else {
      const [only] = inputs;
      if (capabilities.startEndFrames && inputs.length === 1 && only && isFrame(only)) {
        firstFrame = only;
      } else {
        references = inputs;
      }
    }

    /*
     * Asking for exactly what the clip already is *is* following the clip.
     *
     * A reference clip makes Ark read the task as editing, and editing refuses
     * a duration or a ratio — but the most natural thing an artist types next
     * to a 4-second clip is "4", and the most natural shape to pick is the one
     * they can see. Sending those through fails a running task twenty seconds
     * in to produce the result they would have got by saying nothing. So a
     * value that matches the clip is treated as the silence it means, and the
     * decision is logged rather than hidden.
     */
    const clip = this.referenceClip(references);
    let durationSeconds = request.durationSeconds;
    let aspectRatio = request.aspectRatio;

    if (clip) {
      if (
        durationSeconds !== undefined &&
        clip.durationSeconds !== undefined &&
        Math.abs(durationSeconds - clip.durationSeconds) < 0.75
      ) {
        this.options.logger.info("generation.duration_follows_clip", {
          generationId: generation.id,
          asked: durationSeconds,
          clipSeconds: clip.durationSeconds,
        });
        durationSeconds = undefined;
      }
      if (aspectRatio && matchesShape(aspectRatio, clip)) {
        this.options.logger.info("generation.ratio_follows_clip", {
          generationId: generation.id,
          asked: aspectRatio,
          clipShape: `${clip.width}x${clip.height}`,
        });
        aspectRatio = undefined;
      }
    }

    const payload: VideoGenerationRequest = {
      ...base,
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      // Sound is opt-in, and stays off when nothing asked for it.
      ...(request.generateAudio ? { generateAudio: true } : {}),
      ...(firstFrame ? { firstFrame } : {}),
      ...(lastFrame ? { lastFrame } : {}),
      references,
    };
    return provider.generateVideo(payload);
  }

  /** The reference clip behind these inputs, if one of them is a video. */
  private referenceClip(inputs: MaterializedInput[]): Asset | undefined {
    for (const input of inputs) {
      if (!input.mimeType.startsWith("video/") || !input.assetId) continue;
      const asset = this.options.assets.getById(input.assetId);
      if (asset) return asset;
    }
    return undefined;
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
    /*
     * Consecutive failures to *ask*, which is a different thing from a failed
     * render.
     *
     * A poll is a network call against a render that is already running and
     * already paid for. Treating one refused GET as the job's outcome is how a
     * brief outage discarded three finished Seedance clips — they completed on
     * Ark and nobody was listening. So asking is retried, and only a run of
     * failures long enough to mean the provider is genuinely unreachable ends
     * the job. The render is not harmed by us waiting.
     */
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = this.options.maxPollErrors ?? 20;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.disposed) return { status: "cancelled" };
      if (this.cancelled.has(jobId)) return { status: "cancelled" };

      try {
        state = await provider.getJob(submitted.providerJobId);
        consecutiveErrors = 0;
      } catch (cause) {
        consecutiveErrors += 1;
        const error = toSeedError(cause);
        this.options.logger.warn("generation.poll_failed", {
          jobId,
          attempt,
          consecutiveErrors,
          errorClass: error.code,
          errorMessage: error.message,
        });

        /*
         * A refused credential IS worth waiting out here, which is the
         * opposite of what it is at submission — and the difference is that
         * by this point a task exists.
         *
         * Measured, after a key was re-enabled: submitting worked, the poll
         * seconds later answered "The API key status is not active", and a
         * minute after that the same call returned `running`. The status
         * propagates unevenly, and the render was going the whole time. A job
         * killed on the first 401 there is a paid render thrown away for a
         * condition that fixed itself.
         *
         * A genuinely dead key still ends the job — it just takes the full
         * error budget to say so, which costs nothing next to the render.
         *
         * `bad_request` stays terminal: a malformed request will be malformed
         * on every retry.
         */
        if (error.code === "bad_request") {
          return {
            status: "failed",
            error: { class: error.code, message: error.message },
          };
        }

        if (consecutiveErrors >= maxConsecutiveErrors) {
          return {
            status: "failed",
            error: {
              class: "provider_error",
              message:
                `could not reach the provider for ${consecutiveErrors} polls in a row: ` +
                `${error.message}. The render may still have finished — ` +
                "scripts/recover-orphans.ts asks and ingests whatever is there.",
            },
          };
        }

        // Back off a little so a flapping network is not hammered.
        await sleep(interval * Math.min(consecutiveErrors, 5));
        continue;
      }

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

/**
 * Whether a requested shape is the shape the clip already has.
 *
 * `adaptive` is not a shape but a policy — "take it from the input" — which is
 * exactly what following the clip means, so it counts. Ratios are compared on
 * the log of the quotient, at about a percent, so 1920x1080 and 16:9 agree
 * while 16:9 and 4:3 do not.
 */
function matchesShape(
  aspectRatio: string,
  clip: { width?: number; height?: number },
): boolean {
  if (aspectRatio.trim().toLowerCase() === "adaptive") return true;
  if (!clip.width || !clip.height) return false;

  const parts = aspectRatio.split(/[:x]/).map(Number);
  const [w, h] = parts;
  if (!w || !h || parts.length !== 2) return false;

  return Math.abs(Math.log(w / h) - Math.log(clip.width / clip.height)) < 0.01;
}
