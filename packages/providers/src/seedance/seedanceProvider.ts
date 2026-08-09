import { SeedError, type JobStatus } from "@seed-ae/domain";
import type {
  GenerationProvider,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  ProviderOutput,
  VideoGenerationRequest,
} from "../types.js";

export interface SeedanceConfig {
  /** Inference base, e.g. https://ark.ap-southeast.bytepluses.com/api/v3 */
  baseUrl: string;
  /** Ark API key — the same Bearer credential Seedream uses. */
  apiKey: string;
  /** Model id from configuration, e.g. dreamina-seedance-2-5-260628. */
  model: string;
  /** Ark defaults this on; SEED keeps it explicit. */
  generateAudio?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const TASKS_PATH = "/contents/generations/tasks";

/**
 * A part of the `content` array. The API names the accepted types itself:
 * `text`, `image_url`, `audio_url`, `video_url`.
 */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Seedance 2.5 video generation on Volcengine/BytePlus Ark.
 *
 * Contract verified against the live API — see docs/research/MODEL_API_NOTES.md
 * for how, and for the traps. Unlike Seedream, video is genuinely
 * asynchronous: create returns a task id and the result is polled.
 *
 * Deliberately NOT sent: `framespersecond`. The API does not validate it, so a
 * wrong value is accepted and silently produces a billable task rather than an
 * error. Frame rate is left to the model's default until the accepted range is
 * confirmed.
 */
export class SeedanceProvider implements GenerationProvider {
  readonly id = "seedance";

  private readonly config: SeedanceConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SeedanceConfig) {
    if (!config.apiKey) {
      throw new SeedError(
        "unauthorized",
        "Seedance needs an Ark API key for `Authorization: Bearer` (inference). " +
          "An account AK/SK pair signs the asset library and cannot be used here.",
      );
    }
    if (!config.model) {
      throw new SeedError("bad_request", "Seedance needs a configured model id");
    }
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Seedance 2.5 (Ark)",
      models: [this.config.model],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      // A reference image turns the request into i2v, which the API reports
      // in its own error messages.
      maxImageReferences: 1,
      textToVideo: true,
      imageToVideo: true,
      videoReferences: false,
      // `video_url` and `audio_url` parts exist but their semantics are
      // unconfirmed, so they are not offered.
      startEndFrames: false,
      audioReferences: false,
      seed: true,
      /*
       * Verified against the live API for this model in i2v: 3s is rejected,
       * 4..30s accepted, and 1080p/2k/4k are refused while 480p and 720p pass.
       * The API validates these per model AND per mode without listing the
       * accepted set, so they are checked here and re-checked there.
       */
      durationSecondsRange: [4, 30],
      sizes: ["480p", "720p"],
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "21:9", "adaptive"],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    const content: ContentPart[] = [];

    const prompt = request.prompt.trim();
    if (prompt) content.push({ type: "text", text: prompt });

    // The first frame leads; any further references follow it.
    const references = [
      ...(request.firstFrame ? [request.firstFrame] : []),
      ...(request.references ?? []),
    ];
    for (const reference of references) {
      content.push({ type: "image_url", image_url: { url: toUrl(reference) } });
    }

    if (content.length === 0) {
      throw new SeedError(
        "bad_request",
        "Seedance needs a prompt, a reference image, or both",
      );
    }

    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      content,
      output_format: "mp4",
      generate_audio: this.config.generateAudio ?? false,
    };
    if (request.seed !== undefined) body.seed = request.seed;
    if (request.durationSeconds !== undefined) {
      // Catch it here rather than spending a round trip on a known rejection.
      if (request.durationSeconds < 4 || request.durationSeconds > 30) {
        throw new SeedError(
          "bad_request",
          `Seedance accepts 4 to 30 seconds; received ${request.durationSeconds}`,
        );
      }
      body.duration = request.durationSeconds;
    }
    /*
     * Only text-to-video may choose a ratio. With a reference image the API
     * refuses it outright: "For first-frame or first-last-frame generation,
     * the output ratio follows the first-frame image."
     */
    const isImageToVideo = references.length > 0;
    if (request.aspectRatio && !isImageToVideo) body.ratio = request.aspectRatio;
    // `size` carries the resolution keyword for video (480p/720p/1080p).
    const resolution = request.parameters?.size ?? request.parameters?.resolution;
    if (typeof resolution === "string") body.resolution = resolution;

    const payload = await this.call("POST", TASKS_PATH, body);
    const taskId = (payload as { id?: string })?.id;
    if (!taskId) {
      throw new SeedError(
        "provider_error",
        "Seedance accepted the request but returned no task id",
        { details: payload },
      );
    }

    return {
      providerJobId: taskId,
      state: { status: "queued", progress: 0, raw: payload },
      // The key never enters the stored request.
      rawRequest: { url: `${this.config.baseUrl}${TASKS_PATH}`, body },
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const payload = await this.call("GET", `${TASKS_PATH}/${providerJobId}`);
    const task = payload as {
      status?: string;
      content?: { video_url?: string };
      error?: { code?: string; message?: string };
    };

    const status = toJobStatus(task.status);
    if (status === "succeeded") {
      const url = task.content?.video_url;
      if (!url) {
        return {
          status: "failed",
          error: {
            class: "provider_error",
            message: "Seedance reported success but returned no video_url",
          },
          raw: payload,
        };
      }
      const output: ProviderOutput = {
        // Sniffed from the bytes on download; Ark states output_format, not a
        // content type.
        mimeType: "",
        url,
      };
      return { status: "succeeded", progress: 1, outputs: [output], raw: payload };
    }

    if (status === "failed") {
      return {
        status: "failed",
        error: {
          class: "provider_error",
          message: task.error?.message ?? "Seedance reported the task as failed",
        },
        raw: payload,
      };
    }

    return { status, raw: payload };
  }

  /**
   * Ark has no cancel: a running task refuses deletion and there is no stop
   * route. Say so plainly rather than pretending the job was stopped — the
   * work is billable either way.
   */
  async cancelJob(providerJobId: string): Promise<void> {
    const response = await this.request("DELETE", `${TASKS_PATH}/${providerJobId}`);
    if (response.ok) return;

    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    const code = payload?.error?.code ?? "";

    if (/RunningTaskDeletion/i.test(code) || response.status === 409) {
      throw new SeedError(
        "conflict",
        "Seedance cannot stop a task once it is running; it will finish and be billed.",
      );
    }
    throw new SeedError(
      "provider_error",
      payload?.error?.message ?? `could not delete task (HTTP ${response.status})`,
    );
  }

  private async request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 60_000,
    );
    try {
      return await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(method, path, body);
    } catch (cause) {
      throw new SeedError("provider_error", `Seedance ${method} ${path} failed`, {
        cause,
      });
    }

    const payload = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string } })
        ?.error;
      throw new SeedError(
        response.status === 401 ? "unauthorized" : "provider_error",
        `Seedance returned HTTP ${response.status}${
          error?.message ? `: ${stripRequestId(error.message)}` : ""
        }`,
        { details: { code: error?.code } },
      );
    }
    return payload;
  }
}

/** Ark echoes a request id into every message; it is noise in a panel. */
function stripRequestId(message: string): string {
  return message.replace(/\s*Request id:.*$/i, "").trim();
}

function toJobStatus(status: string | undefined): JobStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
    case "cancelled":
      return status === "failed" ? "failed" : "cancelled";
    case "queued":
      return "queued";
    default:
      // running, or anything new Ark introduces: keep polling rather than
      // declaring an outcome we do not understand.
      return "running";
  }
}

/**
 * `image_url` must be an object carrying a URL — a bare string is rejected.
 * A local frame therefore has to arrive as a data URL or a fetchable link.
 */
function toUrl(input: MaterializedInput): string {
  if (input.kind === "url" || input.kind === "dataUrl") return input.value;
  return `data:${input.mimeType};base64,${input.value}`;
}
