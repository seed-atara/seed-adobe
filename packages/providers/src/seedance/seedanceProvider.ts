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
  /** Provider id; derived from the model when not given. */
  id?: string;
  /** Shown in the panel; derived from the model when not given. */
  displayName?: string;
/** Overrides the resolutions offered; defaults come from seedanceSizesFor. */
  sizes?: string[];
  /** Ark defaults this on; SEED keeps it explicit. */
  generateAudio?: boolean;
  /**
   * How many reference images to offer.
   *
   * Validation accepted 64 without complaint, and ByteDance's launch material
   * says 30, but only a handful have actually been generated with — so this is
   * configuration rather than a constant.
   */
  maxReferences?: number;
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
  | { type: "video_url"; video_url: { url: string }; role: "reference_video" }
  | { type: "audio_url"; audio_url: { url: string }; role: "reference_audio" }
  | {
      type: "image_url";
      image_url: { url: string };
      /**
       * Required as soon as a request carries more than one image: the API
       * answers a roleless pair with "role must be specified for image
       * contents". Verified values are `first_frame`, `last_frame` and
       * `reference_image`; anything else is "invalid role specified".
       */
      role?: SeedanceImageRole;
    };

/**
 * How an image is used, in the API's own vocabulary.
 *
 * These are the only accepted values, established by probing the live API —
 * `reference`, `subject`, `image`, `start_frame` and `end_frame` are all
 * rejected.
 */
export type SeedanceImageRole = "first_frame" | "last_frame" | "reference_image";

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
/**
 * The resolutions a model accepts.
 *
 * Measured against the live API rather than assumed — and measured
 * repeatedly, because when two parameters are invalid the API names only one
 * of them and which one varies between identical requests. A resolution the
 * model refuses is named sooner or later; one never named across eight tries
 * is accepted. See docs/research/MODEL_API_NOTES.md and the probe in
 * scripts/seedance-resolutions.ts.
 *
 * The families genuinely differ, which is why this is a table and not a
 * constant: 2.0 reaches 4K where 2.5 stops at 1080p, and the fast and mini
 * variants stop at 720p. Neither family accepts a 2K tier at all.
 */
export function seedanceSizesFor(model: string): string[] {
  if (/seedance-2-0-(fast|mini)/.test(model)) return ["480p", "720p"];
  if (/seedance-2-0/.test(model)) return ["480p", "720p", "1080p", "4K"];
  return ["480p", "720p", "1080p"];
}

/**
 * A readable name for a model id.
 *
 * "dreamina-seedance-2-0-fast-260128" is precise and unreadable; the panel
 * shows a person "Seedance 2.0 fast (Ark)" and keeps the id in the tooltip.
 */
export function seedanceDisplayName(model: string): string {
  const match = /seedance-(\d+)-(\d+)(-(fast|mini|pro|lite))?/.exec(model);
  if (!match) return `${model} (Ark)`;
  const variant = match[4] ? ` ${match[4]}` : "";
  return `Seedance ${match[1]}.${match[2]}${variant} (Ark)`;
}

/** A stable provider id for a model, so recipes keep resolving. */
export function seedanceProviderId(model: string): string {
  const match = /seedance-(\d+)-(\d+)(-(fast|mini|pro|lite))?/.exec(model);
  if (!match) return "seedance";
  return `seedance-${match[1]}-${match[2]}${match[4] ? `-${match[4]}` : ""}`;
}

/** One frame part, with the role the API requires. */
function seedanceImage(
  input: MaterializedInput,
  role: SeedanceImageRole,
): ContentPart {
  return { type: "image_url", image_url: { url: toUrl(input) }, role };
}

/**
 * One reference part, typed by what the media actually is.
 *
 * Each kind has its own part type and its own role, and the API says so
 * plainly when they disagree: "reference media mode requires video role to be
 * reference_video".
 */
/** Whether this input can play the part of a frame. Only a still can. */
function isFrame(input: MaterializedInput): boolean {
  return input.mimeType.startsWith("image/");
}

function seedanceReference(input: MaterializedInput): ContentPart {
  const url = toUrl(input);
  if (input.mimeType.startsWith("video/")) {
    return { type: "video_url", video_url: { url }, role: "reference_video" };
  }
  if (input.mimeType.startsWith("audio/")) {
    return { type: "audio_url", audio_url: { url }, role: "reference_audio" };
  }
  return { type: "image_url", image_url: { url }, role: "reference_image" };
}

export class SeedanceProvider implements GenerationProvider {
  readonly id: string;

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
    this.id = config.id ?? "seedance";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: this.config.displayName ?? seedanceDisplayName(this.config.model),
      models: [this.config.model],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      /*
       * Multi-reference is the model's headline feature and the API confirms
       * it: any number of `reference_image` parts is accepted, and the request
       * becomes r2v rather than i2v — the mode appears in its error messages.
       */
      maxImageReferences: this.config.maxReferences ?? 30,
      textToVideo: true,
      imageToVideo: true,
      /*
       * Reference media is one mode with three kinds in it: images, video and
       * audio mix freely, each under its own role. A video carries motion and
       * grade that no still can — a camera move referenced from a plate,
       * alongside stills for the characters and the location.
       */
      videoReferences: true,
      // `video_url` and `audio_url` parts exist but their semantics are
      // unconfirmed, so they are not offered.
      // A first_frame + last_frame pair passes validation; more than one of
      // either is refused by count.
      startEndFrames: true,
      audioReferences: true,
      generatesAudio: true,
      seed: true,
      /*
       * Verified against the live API for this model in i2v: 3s is rejected,
       * 4..30s accepted, and 1080p/2k/4k are refused while 480p and 720p pass.
       * The API validates these per model AND per mode without listing the
       * accepted set, so they are checked here and re-checked there.
       */
      durationSecondsRange: [4, 30],
      sizes: this.config.sizes ?? seedanceSizesFor(this.config.model),
      aspectRatios: ["16:9", "9:16", "1:1", "4:3", "21:9", "adaptive"],
      async: true,
    };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    const content: ContentPart[] = [];

    const prompt = request.prompt.trim();
    if (prompt) content.push({ type: "text", text: prompt });

    /*
     * Images reach the model one of two ways, and the API treats them as
     * mutually exclusive modes:
     *
     *   frame-anchored (i2v) — a first frame, optionally with a last frame.
     *     The generated motion starts from that exact image.
     *   reference-driven (r2v) — any number of reference images. The model
     *     draws on them without reproducing any one of them as a frame.
     *
     * Mixing them is refused: "first/last frame content cannot be mixed with
     * reference media content." So the mode is chosen here rather than left to
     * a request that cannot express the distinction.
     */
    const loose = [
      ...(request.firstFrame ? [request.firstFrame] : []),
      ...(request.references ?? []),
    ];

    let mode: "frame" | "reference" | "text" = "text";
    if (request.lastFrame) {
      mode = "frame";
      if (request.references?.length) {
        throw new SeedError(
          "unsupported_capability",
          "Seedance will not mix a last frame with reference images — use " +
            "first and last frames, or references, but not both",
        );
      }
      if (request.firstFrame) {
        content.push(seedanceImage(request.firstFrame, "first_frame"));
      }
      content.push(seedanceImage(request.lastFrame, "last_frame"));
    } else if (loose.length === 1 && isFrame(loose[0] as MaterializedInput)) {
      // One image anchors the opening frame, which is what makes a captured
      // plate animate from itself rather than merely resemble itself. Only an
      // image: a lone *clip* is a motion reference, and sending it as a frame
      // means an image_url part holding a video.
      mode = "frame";
      content.push(seedanceImage(loose[0] as MaterializedInput, "first_frame"));
    } else if (loose.length > 0) {
      mode = "reference";
      for (const reference of loose) {
        content.push(seedanceReference(reference));
      }
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
      // Silent unless asked, at every layer: the request decides, the
      // configured default is the fallback, and that default is off.
      generate_audio: request.generateAudio ?? this.config.generateAudio ?? false,
    };
    if (request.seed !== undefined) body.seed = request.seed;

    /*
     * A reference video changes what `duration` may be.
     *
     * Ark classifies a request carrying one by what the prompt asks for. When
     * it decides the task is video *editing* it refuses any duration but -1:
     * "the output ratio and duration follow the input video selected by the
     * model for editing". When it reads the prompt as describing a new shot,
     * an ordinary 4–30 is accepted. Both verified live, with the same clip.
     *
     * So -1 is the default rather than the rule: it always works, and it is
     * what an artist reskinning a shot wants. A stated duration is still sent,
     * because the artist who asks for one is the one using the clip as a loose
     * reference — and if the model disagrees it says so, in words the panel
     * passes on.
     */
    const followsReferenceVideo = content.some((part) => part.type === "video_url");
    if (followsReferenceVideo && request.durationSeconds === undefined) {
      body.duration = -1;
    } else if (request.durationSeconds !== undefined) {
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
    // A first frame dictates the output ratio, so sending one is refused:
    // "For first-frame or first-last-frame generation, the output ratio
    // follows the first-frame image." Reference-driven requests have no such
    // anchor and do accept a ratio.
    /*
     * A reference clip decides the shape on the same terms as the length:
     * silence means follow the clip, and a stated ratio is sent because it was
     * asked for. Verified live — 9:16 alongside a clip is accepted when the
     * prompt describes a new shot, and refused when it describes an edit.
     */
    if (request.aspectRatio && mode !== "frame") body.ratio = request.aspectRatio;
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
          message: explainFailure(task.error?.message),
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

/**
 * Puts the one recoverable failure in terms of what to do about it.
 *
 * A duration sent alongside a reference clip is refused only when the model
 * reads the prompt as editing that clip, and Ark's own wording — four
 * sentences ending in "`duration` must be -1" — describes its rule rather than
 * the artist's next move. The rest are passed through unchanged: guessing at
 * an explanation is worse than the provider's own words.
 */
function explainFailure(message: string | undefined): string {
  const text = stripRequestId(message ?? "");
  if (!text) return "Seedance reported the task as failed";
  if (/must be -1/i.test(text) || /ratio.{0,20}must be .?adaptive/i.test(text)) {
    return (
      "Seedance read this prompt as editing the reference clip, so the length " +
      "and shape come from the clip. Clear Duration and Aspect and generate " +
      "again, or describe a new shot rather than a change to this one. " +
      `Seedance said: ${text}`
    );
  }
  return text;
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
