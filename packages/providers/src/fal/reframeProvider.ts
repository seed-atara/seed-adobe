import { SeedError } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  VideoGenerationRequest,
} from "../types.js";
import { FalQueue, type FalConfig } from "./queue.js";

/**
 * Luma Ray Reframe — a shot into a different aspect, with the edges filled in.
 *
 * Portrait to landscape and back, on footage that moves. The endpoint keeps the
 * original frames unchanged and paints the surrounding canvas, which is the
 * important property: it is an *expansion*, not a re-render, so the performance
 * that was shot is the performance that survives.
 *
 * Schema read from https://fal.ai/models/luma/agent/ray/v3.2/reframe/api on
 * 2026-08-22. Two limits from that page are real and worth knowing before a
 * shot is sent: the source must be **ten seconds or less**, and the aspect is
 * chosen from a fixed list rather than given as a number.
 *
 * `source_rect` is the control worth having. It places the original inside the
 * new canvas, so a subject can sit off-centre in the wider frame rather than
 * always being expanded symmetrically — which is what an editor actually wants
 * when a talking head has to make room for a title.
 */

export interface ReframeConfig extends FalConfig {
  model?: string;
  id?: string;
}

const DEFAULT_MODEL = "luma/agent/ray/v3.2/reframe";

/** The aspects the endpoint names. Not free-form. */
const ASPECTS = ["3:4", "4:3", "1:1", "9:16", "16:9", "21:9"] as const;
const RESOLUTIONS = ["540p", "720p", "1080p"] as const;

interface ReframeResult {
  video?: { url?: string; content_type?: string; file_size?: number };
}

export class ReframeProvider implements GenerationProvider {
  readonly id: string;
  private readonly queue: FalQueue;

  constructor(private readonly config: ReframeConfig) {
    this.id = config.id ?? "luma-reframe";
    this.queue = new FalQueue(config);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Luma Reframe (expand a shot)",
      models: [this.model()],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      /*
       * The source is a clip, and there is exactly one. It travels as
       * `video_url`, so it is a video reference rather than an image one.
       */
      maxImageReferences: 0,
      stableImageReferences: 0,
      addressing: ["hosted-url"],
      nativeGrouping: false,
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      supportsNegativePrompt: false,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: true,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      generatesAudio: false,
      outputFormats: [],
      seed: false,
      sizes: [...RESOLUTIONS],
      aspectRatios: [...ASPECTS],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    const source = (request.references ?? []).find((input) =>
      input.mimeType.startsWith("video/"),
    );
    if (!source) {
      throw new SeedError(
        "unsupported_capability",
        "Reframe expands an existing shot, so it needs one as a reference.",
      );
    }
    if (source.kind !== "url") {
      throw new SeedError(
        "unsupported_capability",
        "Reframe needs the clip as a fetchable URL. Configure a bucket " +
          "(SEED_R2_*) so clips can be hosted.",
      );
    }

    const aspect = request.aspectRatio;
    if (aspect && !(ASPECTS as readonly string[]).includes(aspect)) {
      throw new SeedError(
        "unsupported_capability",
        `Reframe takes one of ${ASPECTS.join(", ")}, and ${aspect} is not among ` +
          "them. Pick the nearest and crop, rather than being surprised later.",
      );
    }

    const parameters = (request.parameters ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {
      video_url: source.value,
      /*
       * A prompt is required by the endpoint, and an empty one produces
       * indifferent edges. Saying "continue the scene" is a better default
       * than nothing, because the job is continuation and not invention.
       */
      prompt:
        request.prompt?.trim() ||
        "continue the existing scene naturally beyond the frame, same location, " +
          "same lighting, same style",
      ...(aspect ? { aspect_ratio: aspect } : {}),
      ...(request.size && (RESOLUTIONS as readonly string[]).includes(request.size)
        ? { resolution: request.size }
        : {}),
      ...(isRect(parameters.sourceRect) ? { source_rect: parameters.sourceRect } : {}),
    };

    const submission = await this.queue.submit(this.model(), body, "Reframe");
    return {
      providerJobId: submission.requestId,
      state: { status: "queued" },
      rawRequest: body,
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const polled = await this.queue.poll<ReframeResult>(
      this.model(),
      providerJobId,
      "Reframe",
    );
    if (polled.status !== "succeeded") {
      return { status: polled.status, raw: polled.raw };
    }

    const url = polled.result?.video?.url;
    if (!url) {
      return {
        status: "failed",
        error: {
          class: "provider_error",
          message: "Reframe reported success but returned no video",
        },
        raw: polled.raw,
      };
    }

    return {
      status: "succeeded",
      outputs: [
        {
          mimeType: polled.result?.video?.content_type ?? "video/mp4",
          url,
        },
      ],
      raw: polled.raw,
    };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    await this.queue.cancel(this.model(), providerJobId, "Reframe");
  }

  private model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }
}

/**
 * Where the original sits inside the new canvas, normalised 0..1.
 *
 * Validated rather than passed through: a rectangle outside the canvas is a
 * request the endpoint will refuse, and finding that out after the upload and
 * the queue is a slow way to learn it.
 */
function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  const numbers = ["x", "y", "width", "height"].map((key) => Number(rect[key]));
  if (numbers.some((n) => !Number.isFinite(n))) return false;
  const [x, y, width, height] = numbers as [number, number, number, number];
  return (
    x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.001 && y + height <= 1.001
  );
}
