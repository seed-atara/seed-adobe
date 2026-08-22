import { SeedError, type JobStatus } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ImageEditRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  ProviderOutput,
  VideoGenerationRequest,
} from "../types.js";

/**
 * Beeble SwitchX — background, lighting and wardrobe switched generatively,
 * with the subject's pixels driving the result.
 *
 * Registered so SEED's own `POST /v1/switch` can be measured against the thing
 * it competes with on the same frame, and so an artist can reach for whichever
 * suits the shot. The two are not the same machine:
 *
 * - **SwitchX generates.** It can invent a wardrobe, a new environment and a
 *   camera perspective, and it needs no depth pass or normals to do it.
 * - **SEED's switch measures.** It solves the reference's light onto the
 *   subject's own normals and composites through a matte, so nothing about the
 *   subject is resynthesised — and it cannot invent anything either.
 *
 * Note this is *not* SwitchLight, Beeble's inverse-rendering product. SwitchX
 * is the generative one; SwitchLight decomposes a portrait into physical
 * intrinsics and re-renders it. Conflating them was a mistake this project
 * already made once — see docs/research/BEEBLE_AND_WHERE_WE_SIT.md.
 *
 * Contract verified against the live API on 2026-08-23.
 */

export interface SwitchXConfig {
  apiKey: string;
  baseUrl?: string;
  id?: string;
  /** 720 or 1080. The API rejects anything else. */
  maxResolution?: 720 | 1080;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://api.beeble.ai/v1";

/**
 * Which pixels survive.
 *
 * `auto` lets Beeble find the subject, `fill` regenerates everything, and the
 * two mask modes take one: `custom` a matte per frame, `select` a matte for one
 * keyframe which the model propagates across the shot.
 */
export type SwitchXAlphaMode = "auto" | "fill" | "custom" | "select";

/** Source limits, from the published contract. Checked before spending a call. */
export const SWITCHX_MAX_SOURCE_PIXELS = 2_770_000;
export const SWITCHX_MAX_FRAMES = 240;

interface SwitchXJob {
  id: string;
  status?: string;
  progress?: number;
  output?: { render?: string; source?: string; alpha?: string };
  error?: string;
  seed?: number;
}

/** Their vocabulary to ours. `in_queue` and `processing` are not terminal. */
function toJobStatus(status: string | undefined): JobStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "processing":
      return "running";
    default:
      return "queued";
  }
}

export class SwitchXProvider implements GenerationProvider {
  readonly id: string;

  private readonly config: SwitchXConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SwitchXConfig) {
    if (!config.apiKey) {
      throw new SeedError(
        "unauthorized",
        "SwitchX needs a Beeble API key (x-api-key), from developer.beeble.ai.",
      );
    }
    this.config = config;
    this.id = config.id ?? "beeble-switchx";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Beeble SwitchX (switch the scene)",
      models: ["switchx"],
      operations: ["image.edit", "video.generate"],
      textToImage: false,
      /*
       * Both halves are true and both are the same call: a source is always
       * required, and the new scene arrives either as a reference image or as
       * a prompt. One of the two is mandatory.
       */
      imageToImage: true,
      textToVideo: false,
      imageToVideo: true,
      /*
       * One reference, and it is the *scene* rather than a subject plate —
       * environment, lighting, colour grade and wardrobe come from it. This is
       * a different meaning of "reference" from Seedance's identity plates, and
       * budgeting more than one would be inventing a feature.
       */
      maxImageReferences: 1,
      stableImageReferences: 1,
      addressing: ["hosted-url", "inline"],
      nativeGrouping: false,
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      supportsNegativePrompt: false,
      videoReferences: true,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      /** Audio is carried through from the source rather than generated. */
      generatesAudio: false,
      outputFormats: [],
      seed: true,
      sizes: ["720", "1080"],
      aspectRatios: [],
      async: true,
    };
  }

  async editImage(request: ImageEditRequest): Promise<ProviderJob> {
    return this.submit("image", request.image, request, request.references?.[0]);
  }

  async generateVideo(request: VideoGenerationRequest): Promise<ProviderJob> {
    const source =
      request.references?.find((input) => input.mimeType.startsWith("video/")) ??
      request.firstFrame ??
      request.references?.[0];
    if (!source) {
      throw new SeedError(
        "unsupported_capability",
        "SwitchX transforms an existing shot, so it needs one as the source.",
      );
    }
    /*
     * The scene reference is whatever is left once the source has been taken
     * out. Without this the source counted as its own reference, and a request
     * with neither a prompt nor a backdrop sailed past the guard and failed at
     * the API instead.
     */
    const reference = (request.references ?? []).find(
      (input) => input !== source && !input.mimeType.startsWith("video/"),
    );
    return this.submit("video", source, request, reference);
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const job = await this.call<SwitchXJob>(
      `/switchx/generations/${providerJobId}`,
      "GET",
    );
    const status = toJobStatus(job.status);

    if (status !== "succeeded") {
      return {
        status,
        ...(job.progress !== undefined ? { progress: job.progress / 100 } : {}),
        ...(status === "failed"
          ? {
              error: {
                class: "provider_error",
                message: job.error ?? "SwitchX reported a failure with no message",
              },
            }
          : {}),
        raw: job,
      };
    }

    const render = job.output?.render;
    if (!render) {
      return {
        status: "failed",
        error: {
          class: "provider_error",
          message: "SwitchX reported completion but returned no render",
        },
        raw: job,
      };
    }

    /*
     * The alpha comes back as its own artifact and is kept as a second output,
     * because a matte is what makes the result a comp rather than a flat frame.
     * Signed URLs expire after 72 hours, so these are downloaded promptly.
     */
    const outputs: ProviderOutput[] = [{ mimeType: "video/mp4", url: render }];
    if (job.output?.alpha) {
      outputs.push({ mimeType: "video/mp4", url: job.output.alpha });
    }

    return {
      status: "succeeded",
      progress: 1,
      outputs,
      raw: job,
    };
  }

  private async submit(
    generationType: "image" | "video",
    source: MaterializedInput,
    request: ImageEditRequest | VideoGenerationRequest,
    reference: MaterializedInput | undefined,
  ): Promise<ProviderJob> {
    const parameters = (request.parameters ?? {}) as Record<string, unknown>;
    const alphaMode = (parameters.alphaMode as SwitchXAlphaMode) ?? "auto";

    const prompt = request.prompt?.trim();
    if (!prompt && !reference) {
      throw new SeedError(
        "bad_request",
        "SwitchX needs either a prompt or a reference image to describe the new scene.",
      );
    }

    const alpha = parameters.alphaUri;
    if ((alphaMode === "custom" || alphaMode === "select") && typeof alpha !== "string") {
      throw new SeedError(
        "bad_request",
        `SwitchX alpha_mode "${alphaMode}" needs a matte; supply parameters.alphaUri.`,
      );
    }

    const body: Record<string, unknown> = {
      generation_type: generationType,
      source_uri: toUri(source),
      alpha_mode: alphaMode,
      max_resolution: this.config.maxResolution ?? 1080,
    };
    if (prompt) body.prompt = prompt;
    if (reference) body.reference_image_uri = toUri(reference);
    if (typeof alpha === "string") body.alpha_uri = alpha;
    if (typeof parameters.alphaKeyframeIndex === "number") {
      body.alpha_keyframe_index = parameters.alphaKeyframeIndex;
    }
    if (typeof request.seed === "number") body.seed = request.seed;

    const job = await this.call<SwitchXJob>("/switchx/generations", "POST", body);
    if (!job.id) {
      throw new SeedError("provider_error", "SwitchX returned no generation id");
    }

    return {
      providerJobId: job.id,
      state: { status: toJobStatus(job.status), raw: job },
      // The key is a header, so it never enters what is stored.
      rawRequest: body,
    };
  }

  private async call<T>(
    path: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 120_000,
    );

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(
        `${this.config.baseUrl ?? DEFAULT_BASE}${path}`,
        {
          method,
          headers: {
            "x-api-key": this.config.apiKey,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        },
      );
      payload = await response.json().catch(() => undefined);
    } catch (cause) {
      throw new SeedError("provider_error", `SwitchX ${method} ${path} failed`, {
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw toSwitchXError(response.status, payload);
    }
    return payload as T;
  }
}

/** `data:` is accepted inline up to 50 MB; anything else must be a link. */
function toUri(input: MaterializedInput): string {
  if (input.kind === "url" || input.kind === "dataUrl") return input.value;
  return `data:${input.mimeType};base64,${input.value}`;
}

/**
 * Two error shapes, and they mean different things.
 *
 * A 422 is FastAPI's validation envelope with a `detail` array naming the
 * offending field; a 400 is Beeble's own `{error: {message, code}}`. Reporting
 * the field is the difference between "it failed" and "alpha_uri is required".
 */
function toSwitchXError(status: number, payload: unknown): SeedError {
  const detail = (payload as { detail?: Array<{ loc?: string[]; msg?: string }> })
    ?.detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const named = detail
      .slice(0, 3)
      .map((entry) => `${(entry.loc ?? []).slice(-1)[0] ?? "?"}: ${entry.msg ?? ""}`)
      .join("; ");
    return new SeedError("bad_request", `SwitchX rejected the request — ${named}`, {
      details: detail,
    });
  }

  const error = (payload as { error?: { message?: string; code?: string } })?.error;
  if (error?.message) {
    return new SeedError(
      status === 400 || status === 404 ? "bad_request" : "provider_error",
      `SwitchX: ${error.message}`,
      { details: { code: error.code } },
    );
  }
  return new SeedError("provider_error", `SwitchX returned HTTP ${status}`);
}
