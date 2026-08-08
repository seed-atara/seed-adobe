import { SeedError, type JobStatus } from "@seed-ae/domain";
import { renderMockImage, hashString } from "./render.js";
import type {
  GenerationProvider,
  ImageEditRequest,
  ImageGenerationRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
} from "../types.js";

export interface MockImageProviderOptions {
  /** Simulated provider latency. 0 in tests, a second or two for demos. */
  latencyMs?: number;
  /** Prompts containing this string fail, for exercising error states. */
  failOnPromptContaining?: string;
  models?: string[];
  /** Declared sizes. Tests narrow this to small, fast renders. */
  sizes?: string[];
  /** Injectable clock so tests do not sleep. */
  now?: () => number;
}

interface MockJob {
  status: JobStatus;
  readyAt: number;
  request: ImageGenerationRequest | ImageEditRequest;
  reference?: Buffer;
}

const DEFAULT_SIZES = ["1024x1024", "1920x1080", "1080x1920", "2048x2048"];

/**
 * Stand-in image provider. It exists so the entire product loop — recipes,
 * jobs, lineage, import — can be built, demoed and regression-tested before any
 * provider credential or contract is confirmed.
 */
export class MockImageProvider implements GenerationProvider {
  readonly id = "mock-image";

  private readonly jobs = new Map<string, MockJob>();
  private readonly latencyMs: number;
  private readonly failOn: string | undefined;
  private readonly models: string[];
  private readonly sizes: string[];
  private readonly now: () => number;
  private counter = 0;

  constructor(options: MockImageProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
    this.failOn = options.failOnPromptContaining;
    this.models = options.models ?? ["mock-image-v1"];
    this.sizes = options.sizes ?? DEFAULT_SIZES;
    this.now = options.now ?? (() => Date.now());
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Mock Image",
      models: this.models,
      operations: ["image.generate", "image.edit"],
      textToImage: true,
      imageToImage: true,
      maxImageReferences: 4,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: false,
      startEndFrames: false,
      audioReferences: false,
      seed: true,
      sizes: this.sizes,
      aspectRatios: ["1:1", "16:9", "9:16"],
      async: true,
    };
  }

  async generateImage(request: ImageGenerationRequest): Promise<ProviderJob> {
    return this.enqueue(request, request.references?.[0]);
  }

  async editImage(request: ImageEditRequest): Promise<ProviderJob> {
    return this.enqueue(request, request.image);
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new SeedError("not_found", `unknown mock job ${providerJobId}`);
    }
    if (job.status === "cancelled" || job.status === "failed") {
      return { status: job.status, ...(job.status === "failed" ? { error: FAILURE } : {}) };
    }
    if (this.now() < job.readyAt) {
      return { status: "running", progress: 0.5 };
    }

    const { width, height } = parseSize(sizeOf(job.request));
    const seed = normalizeSeed(job.request.seed, job.request.prompt);
    const png = renderMockImage({
      width,
      height,
      prompt: job.request.prompt,
      seed,
      ...(job.reference ? { reference: job.reference } : {}),
    });

    job.status = "succeeded";
    return {
      status: "succeeded",
      progress: 1,
      outputs: [
        {
          mimeType: "image/png",
          base64: png.toString("base64"),
          width,
          height,
          seed,
        },
      ],
      raw: { mock: true, providerJobId, model: job.request.model, seed },
    };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new SeedError("not_found", `unknown mock job ${providerJobId}`);
    }
    if (job.status === "succeeded") {
      throw new SeedError("conflict", "job already finished");
    }
    job.status = "cancelled";
  }

  private enqueue(
    request: ImageGenerationRequest | ImageEditRequest,
    reference: MaterializedInput | undefined,
  ): ProviderJob {
    if (!this.models.includes(request.model)) {
      throw new SeedError(
        "bad_request",
        `unknown model ${request.model} for ${this.id}`,
        { details: { models: this.models } },
      );
    }

    this.counter += 1;
    const providerJobId = `mockjob_${this.counter}_${hashString(request.correlationId).toString(16)}`;
    const failing =
      this.failOn !== undefined && request.prompt.includes(this.failOn);

    this.jobs.set(providerJobId, {
      status: failing ? "failed" : "queued",
      readyAt: this.now() + this.latencyMs,
      request,
      ...(decodeReference(reference) ? { reference: decodeReference(reference) } : {}),
    });

    return {
      providerJobId,
      state: failing
        ? { status: "failed", error: FAILURE }
        : { status: "queued", progress: 0 },
      rawRequest: {
        mock: true,
        model: request.model,
        prompt: request.prompt,
        seed: request.seed,
        size: sizeOf(request),
        referenceCount: countReferences(request),
      },
    };
  }
}

const FAILURE = {
  class: "provider_error",
  message: "mock provider was asked to fail",
};

function sizeOf(request: ImageGenerationRequest | ImageEditRequest): string {
  return request.size ?? "1024x1024";
}

function countReferences(
  request: ImageGenerationRequest | ImageEditRequest,
): number {
  const extra = "image" in request ? 1 : 0;
  return (request.references?.length ?? 0) + extra;
}

function decodeReference(input: MaterializedInput | undefined): Buffer | undefined {
  if (!input) return undefined;
  if (input.kind === "base64") return Buffer.from(input.value, "base64");
  if (input.kind === "dataUrl") {
    const comma = input.value.indexOf(",");
    return comma === -1
      ? undefined
      : Buffer.from(input.value.slice(comma + 1), "base64");
  }
  return undefined; // a URL reference is not fetched by the mock
}

export function parseSize(size: string): { width: number; height: number } {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!match) {
    throw new SeedError("bad_request", `unsupported size "${size}"`, {
      details: { expected: "WIDTHxHEIGHT" },
    });
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function normalizeSeed(seed: number | string | undefined, prompt: string): number {
  if (typeof seed === "number") return seed;
  if (typeof seed === "string" && seed.trim() !== "") return hashString(seed);
  return hashString(prompt);
}
