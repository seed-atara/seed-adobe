import { readFile } from "node:fs/promises";
import path from "node:path";
import { SeedError, type JobStatus } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  VideoGenerationRequest,
} from "../types.js";

export interface MockVideoProviderOptions {
  /**
   * Path to a real video file used as the stand-in result. Encoding video
   * without native dependencies is out of scope, so the mock replays a fixture
   * rather than fabricating a file that would not decode.
   */
  fixturePath?: string;
  fixtureMimeType?: string;
  latencyMs?: number;
  models?: string[];
  now?: () => number;
}

interface MockVideoJob {
  status: JobStatus;
  readyAt: number;
  request: VideoGenerationRequest;
}

/**
 * Stand-in video provider so the Seedance demo path (submit → poll → register →
 * insert at playhead) can be built and rehearsed before the official Seedance
 * 2.5 contract is available.
 */
export class MockVideoProvider implements GenerationProvider {
  readonly id = "mock-video";

  private readonly jobs = new Map<string, MockVideoJob>();
  private readonly options: MockVideoProviderOptions;
  private readonly models: string[];
  private readonly now: () => number;
  private counter = 0;

  constructor(options: MockVideoProviderOptions = {}) {
    this.options = options;
    this.models = options.models ?? ["mock-video-v1"];
    this.now = options.now ?? (() => Date.now());
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Mock Video",
      models: this.models,
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      maxImageReferences: 4,
      textToVideo: true,
      imageToVideo: true,
      videoReferences: false,
      startEndFrames: true,
      audioReferences: false,
      seed: true,
      durationSecondsRange: [2, 10],
      sizes: ["1920x1080", "1080x1920"],
      aspectRatios: ["16:9", "9:16", "1:1"],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    if (!this.options.fixturePath) {
      throw new SeedError(
        "unsupported_capability",
        "MockVideoProvider needs a fixture video (SEED_AE_MOCK_VIDEO_FIXTURE); " +
          "it replays real media rather than fabricating an undecodable file.",
      );
    }
    if (!this.models.includes(request.model)) {
      throw new SeedError("bad_request", `unknown model ${request.model}`, {
        details: { models: this.models },
      });
    }

    this.counter += 1;
    const providerJobId = `mockvideo_${this.counter}`;
    this.jobs.set(providerJobId, {
      status: "queued",
      readyAt: this.now() + (this.options.latencyMs ?? 0),
      request,
    });

    return {
      providerJobId,
      state: { status: "queued", progress: 0 },
      rawRequest: {
        mock: true,
        model: request.model,
        prompt: request.prompt,
        durationSeconds: request.durationSeconds,
        aspectRatio: request.aspectRatio,
        hasFirstFrame: Boolean(request.firstFrame),
        hasLastFrame: Boolean(request.lastFrame),
      },
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new SeedError("not_found", `unknown mock video job ${providerJobId}`);
    }
    if (job.status === "cancelled") return { status: "cancelled" };
    if (this.now() < job.readyAt) return { status: "running", progress: 0.5 };

    const fixturePath = this.options.fixturePath as string;
    const bytes = await readFile(fixturePath).catch((cause: unknown) => {
      throw new SeedError(
        "provider_error",
        `mock video fixture is unreadable: ${fixturePath}`,
        { cause },
      );
    });

    job.status = "succeeded";
    return {
      status: "succeeded",
      progress: 1,
      outputs: [
        {
          mimeType: this.options.fixtureMimeType ?? guessMime(fixturePath),
          base64: bytes.toString("base64"),
        },
      ],
      raw: { mock: true, fixture: path.basename(fixturePath) },
    };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new SeedError("not_found", `unknown mock video job ${providerJobId}`);
    }
    if (job.status === "succeeded") {
      throw new SeedError("conflict", "job already finished");
    }
    job.status = "cancelled";
  }
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".gif") return "image/gif";
  return "video/mp4";
}
