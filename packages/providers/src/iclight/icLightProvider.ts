import { SeedError, type JobStatus } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ImageEditRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
} from "../types.js";

/**
 * IC-Light V2, through fal's queue API.
 *
 * The current state of the art for relighting, and the reason SEED does not
 * try to compete with it: spherical harmonics carry soft light and nothing
 * else, so the maths in `@seed-ae/media` is for measuring and previewing while
 * this is for the frame that ships. See
 * docs/research/RELIGHTING_STATE_OF_THE_ART.md.
 *
 * **What this endpoint is, precisely.** `fal-ai/iclight-v2` is the
 * *text-conditioned* model: a foreground image plus a description of the light
 * and the scene. The **background-conditioned** variant — hand it a backdrop
 * and it composites and relights to match — is in lllyasviel's repository but
 * is **not exposed on this endpoint**, and the schema is not invented here.
 * Until a hosted background-conditioned endpoint is confirmed, replacing a
 * background means describing it, and `docs/research` records the gap.
 *
 * Schema read from https://fal.ai/models/fal-ai/iclight-v2/api on 2026-08-22.
 */

export interface ICLightConfig {
  apiKey: string;
  /** Overridable so a fork or a self-host can be pointed at. */
  baseUrl?: string;
  model?: string;
  id?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = "https://queue.fal.run";
const DEFAULT_MODEL = "fal-ai/iclight-v2";

/**
 * Where the light comes from.
 *
 * IC-Light expresses this as which side the initial latent is seeded from,
 * which is a strange-looking control until you realise it is doing the same
 * job as a key light's position. Mapped from an azimuth so the panel can offer
 * something an artist recognises.
 */
export type ICLightSide = "None" | "Left" | "Right" | "Top" | "Bottom";

export function sideFromAzimuth(azimuth?: number, elevation?: number): ICLightSide {
  if (azimuth === undefined && elevation === undefined) return "None";
  const a = ((azimuth ?? 0) % 360 + 360) % 360;
  const e = elevation ?? 0;
  // Elevation wins when the light is steeply above or below.
  if (e > 45) return "Top";
  if (e < -45) return "Bottom";
  if (a > 180) return "Left";
  if (a > 0) return "Right";
  return "None";
}

/** The sizes the endpoint names. Not free-form. */
const IMAGE_SIZES = [
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
] as const;

interface QueueSubmission {
  request_id?: string;
  status_url?: string;
  response_url?: string;
  detail?: string;
}

interface QueueStatus {
  status?: string;
  queue_position?: number;
  detail?: string;
}

interface ICLightResult {
  images?: Array<{ url?: string; width?: number; height?: number; content_type?: string }>;
  seed?: number;
  has_nsfw_concepts?: boolean[];
}

export class ICLightProvider implements GenerationProvider {
  readonly id: string;
  private readonly fetchImpl: typeof fetch;
  /** request_id -> where to ask about it. fal hands these back on submit. */
  private readonly urls = new Map<string, { status: string; response: string }>();

  constructor(private readonly config: ICLightConfig) {
    this.id = config.id ?? "iclight-v2";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "IC-Light V2 (relight)",
      models: [this.config.model ?? DEFAULT_MODEL],
      operations: ["image.edit"],
      textToImage: false,
      imageToImage: true,
      /*
       * One. The endpoint takes a single `image_url`, plus an optional mask —
       * which is a matte rather than a reference, so it is not counted here.
       * Declaring more would let the panel offer a second plate that would be
       * silently dropped.
       */
      maxImageReferences: 1,
      stableImageReferences: 1,
      addressing: ["hosted-url"],
      nativeGrouping: false,
      requiresBindingText: false,
      /*
       * Positional, because the seam has no "none". Only one image travels, so
       * the distinction never bites — nothing here needs a prompt to say which
       * plate is which.
       */
      mentionSyntax: "positional-en",
      supportsNegativePrompt: true,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: false,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      generatesAudio: false,
      outputFormats: ["jpeg", "png"],
      seed: true,
      sizes: [...IMAGE_SIZES],
      aspectRatios: [],
      async: true,
    };
  }

  async editImage(request: ImageEditRequest): Promise<ProviderJob> {
    const imageUrl = urlOf(request.image);
    if (!imageUrl) {
      throw new SeedError(
        "unsupported_capability",
        "IC-Light needs the plate as a fetchable URL. Configure a bucket " +
          "(SEED_R2_*) so references can be hosted.",
      );
    }

    const parameters = (request.parameters ?? {}) as Record<string, unknown>;
    const size = request.size;

    const body: Record<string, unknown> = {
      prompt: request.prompt,
      image_url: imageUrl,
      ...(typeof parameters.negativePrompt === "string" && parameters.negativePrompt
        ? { negative_prompt: parameters.negativePrompt }
        : {}),
      ...(size && (IMAGE_SIZES as readonly string[]).includes(size)
        ? { image_size: size }
        : {}),
      ...(request.seed !== undefined ? { seed: Number(request.seed) } : {}),
      // "None" is the endpoint's own default and means "let the model decide".
      initial_latent: sideFromAzimuth(
        numberOr(parameters.lightAzimuth),
        numberOr(parameters.lightElevation),
      ),
      ...(parameters.mask && typeof parameters.mask === "string"
        ? { mask_image_url: parameters.mask }
        : {}),
      ...(numberOr(parameters.steps) !== undefined
        ? { num_inference_steps: numberOr(parameters.steps) }
        : {}),
      ...(numberOr(parameters.guidance) !== undefined
        ? { guidance_scale: numberOr(parameters.guidance) }
        : {}),
      /*
       * PNG rather than the endpoint's JPEG default. A relight is an
       * intermediate that a detail transfer and a grade run on afterwards, and
       * re-encoding a lossy frame at every stage is how a pipeline loses more
       * than the model ever did.
       */
      output_format: "png",
    };

    const response = await this.call("POST", `/${this.model()}`, body);
    const payload = (await response.json().catch(() => undefined)) as
      | QueueSubmission
      | undefined;

    if (!response.ok || !payload?.request_id) {
      throw new SeedError(
        "provider_error",
        `IC-Light returned HTTP ${response.status}` +
          (payload?.detail ? `: ${payload.detail}` : ""),
      );
    }

    if (payload.status_url && payload.response_url) {
      this.urls.set(payload.request_id, {
        status: payload.status_url,
        response: payload.response_url,
      });
    }

    return {
      providerJobId: payload.request_id,
      state: { status: "running" },
      rawRequest: body,
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const known = this.urls.get(providerJobId);
    /*
     * fal hands back absolute status and response URLs on submit, and they are
     * the documented way to poll. Rebuilt from the model path only when they
     * were not kept — after a service restart, for instance.
     */
    const statusUrl =
      known?.status ?? `${this.base()}/${this.model()}/requests/${providerJobId}/status`;

    const response = await this.callAbsolute("GET", statusUrl);
    const status = (await response.json().catch(() => undefined)) as
      | QueueStatus
      | undefined;

    if (!response.ok) {
      return {
        status: "failed",
        error: {
          class: "provider_error",
          message: `IC-Light status returned HTTP ${response.status}` +
            (status?.detail ? `: ${status.detail}` : ""),
        },
        raw: status,
      };
    }

    const mapped = mapStatus(status?.status);
    if (mapped !== "succeeded") {
      return { status: mapped, raw: status };
    }

    const resultUrl =
      known?.response ?? `${this.base()}/${this.model()}/requests/${providerJobId}`;
    const resultResponse = await this.callAbsolute("GET", resultUrl);
    const result = (await resultResponse.json().catch(() => undefined)) as
      | ICLightResult
      | undefined;

    const images = result?.images ?? [];
    if (!resultResponse.ok || images.length === 0) {
      return {
        status: "failed",
        error: {
          class: "provider_error",
          message: "IC-Light reported success but returned no image",
        },
        raw: result,
      };
    }

    return {
      status: "succeeded",
      outputs: images
        .filter((image) => image.url)
        .map((image) => ({
          mimeType: image.content_type ?? "image/png",
          url: image.url as string,
          ...(image.width ? { width: image.width } : {}),
          ...(image.height ? { height: image.height } : {}),
          ...(result?.seed !== undefined ? { seed: result.seed } : {}),
        })),
      raw: result,
    };
  }

  async cancelJob(providerJobId: string): Promise<void> {
    const response = await this.callAbsolute(
      "PUT",
      `${this.base()}/${this.model()}/requests/${providerJobId}/cancel`,
    );
    // A job already running cannot be stopped, and that is not an error worth
    // throwing over — the caller wanted it gone and it will be shortly.
    if (!response.ok && response.status !== 400 && response.status !== 409) {
      throw new SeedError(
        "provider_error",
        `could not cancel IC-Light request (HTTP ${response.status})`,
      );
    }
  }

  private base(): string {
    return (this.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  }

  private model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }

  private call(method: string, path: string, body?: unknown): Promise<Response> {
    return this.callAbsolute(method, `${this.base()}${path}`, body);
  }

  private callAbsolute(method: string, url: string, body?: unknown): Promise<Response> {
    return this.fetchImpl(url, {
      method,
      headers: {
        // fal's scheme is "Key", not "Bearer".
        authorization: `Key ${this.config.apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
    });
  }
}

function urlOf(input: MaterializedInput): string | undefined {
  return input.kind === "url" ? input.value : undefined;
}

function numberOr(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** fal's queue vocabulary, mapped onto SEED's. */
function mapStatus(status?: string): JobStatus {
  switch (status) {
    case "COMPLETED":
      return "succeeded";
    case "IN_QUEUE":
      return "queued";
    case "IN_PROGRESS":
      return "running";
    default:
      // An unrecognised status is treated as still going rather than failed:
      // the poll will ask again, and guessing "failed" would abandon a job
      // that is merely in a state this adapter has not seen.
      return "running";
  }
}
