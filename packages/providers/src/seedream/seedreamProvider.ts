import { SeedError } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ImageEditRequest,
  ImageGenerationRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  ProviderOutput,
} from "../types.js";

export interface SeedreamConfig {
  /** e.g. https://ark.cn-beijing.volces.com */
  baseUrl: string;
  /** Ark API key used as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** Model id — configuration, never a hard-coded guess. */
  model: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const IMAGES_PATH = "/api/v3/images/generations";

/**
 * Adapter for Volcengine Ark image generation (Seedream).
 *
 * Verified from Volcengine developer documentation: the endpoint is
 * `POST /api/v3/images/generations` with `Authorization: Bearer $ARK_API_KEY`,
 * and documented payload fields include `model`, `prompt`, `image` (URL or
 * array of URLs), `size`, `sequential_image_generation`, `stream`,
 * `response_format` and `watermark`.
 *
 * Anything not in that list is NOT sent. Notably `seed` is not declared as a
 * capability here because it is not among the fields confirmed from official
 * docs — see docs/research/MODEL_API_NOTES.md. Turn it on only after verifying.
 */
export class SeedreamProvider implements GenerationProvider {
  readonly id = "seedream";

  private readonly config: SeedreamConfig;
  private readonly fetchImpl: typeof fetch;
  /** Ark answers in the initial response, so job state is held locally. */
  private readonly jobs = new Map<string, ProviderJobState>();
  private counter = 0;

  constructor(config: SeedreamConfig) {
    if (!config.apiKey) {
      throw new SeedError(
        "unauthorized",
        "Seedream requires ARK_API_KEY (Bearer auth). An AK/SK pair is a " +
          "different Volcengine credential type and its signing scheme for " +
          "this endpoint has not been verified — supply an Ark API key.",
      );
    }
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Seedream (Volcengine Ark)",
      models: [this.config.model],
      operations: ["image.generate", "image.edit"],
      textToImage: true,
      imageToImage: true,
      // Documented as a URL or an array of URLs; the exact upper bound is not
      // stated in the docs consulted, so this is a conservative floor.
      maxImageReferences: 4,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: false,
      startEndFrames: false,
      audioReferences: false,
      seed: false, // TODO: enable once seed support is confirmed from official docs.
      sizes: ["1024x1024", "1920x1080", "1080x1920", "2048x2048"],
      aspectRatios: ["1:1", "16:9", "9:16"],
      async: false,
    };
  }

  async generateImage(request: ImageGenerationRequest): Promise<ProviderJob> {
    return this.send(request, request.references ?? []);
  }

  async editImage(request: ImageEditRequest): Promise<ProviderJob> {
    return this.send(request, [request.image, ...(request.references ?? [])]);
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const state = this.jobs.get(providerJobId);
    if (!state) {
      throw new SeedError("not_found", `unknown Seedream job ${providerJobId}`);
    }
    return state;
  }

  private async send(
    request: ImageGenerationRequest | ImageEditRequest,
    references: MaterializedInput[],
  ): Promise<ProviderJob> {
    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      prompt: request.prompt,
      response_format: "b64_json",
      watermark: false,
    };
    if (request.size) body.size = request.size;

    const images = references.map(toArkImageValue);
    if (images.length === 1) body.image = images[0];
    else if (images.length > 1) body.image = images;

    this.counter += 1;
    const providerJobId = `seedream_${this.counter}_${request.correlationId}`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 120_000,
    );

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${IMAGES_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      payload = await response.json().catch(() => undefined);
    } catch (cause) {
      throw new SeedError("provider_error", "Seedream request failed", { cause });
    } finally {
      clearTimeout(timeout);
    }

    // Raw request is kept for reproducibility; the key never enters it.
    const rawRequest = { url: `${this.config.baseUrl}${IMAGES_PATH}`, body };

    if (!response.ok) {
      const state: ProviderJobState = {
        status: "failed",
        error: {
          class: "provider_error",
          message: `Seedream returned HTTP ${response.status}`,
        },
        raw: payload,
      };
      this.jobs.set(providerJobId, state);
      return { providerJobId, state, rawRequest };
    }

    const outputs = extractOutputs(payload);
    const state: ProviderJobState =
      outputs.length > 0
        ? { status: "succeeded", progress: 1, outputs, raw: payload }
        : {
            status: "failed",
            error: {
              class: "provider_error",
              message:
                "Seedream response contained no recognisable image data; raw payload preserved",
            },
            raw: payload,
          };

    this.jobs.set(providerJobId, state);
    return { providerJobId, state, rawRequest };
  }
}

/**
 * The documented `image` field takes URLs. A local AE render therefore has to
 * be materialized first; a data URL is accepted here because some Ark examples
 * show base64 data URLs, but a plain local path never is.
 */
function toArkImageValue(input: MaterializedInput): string {
  if (input.kind === "url" || input.kind === "dataUrl") return input.value;
  return `data:${input.mimeType};base64,${input.value}`;
}

/**
 * Tolerant response reader. The response schema was not confirmed field by
 * field from official docs, so this accepts the shapes Ark examples show and
 * otherwise reports failure with the raw payload intact rather than guessing.
 */
function extractOutputs(payload: unknown): ProviderOutput[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const outputs: ProviderOutput[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : undefined;
    const b64 = typeof record.b64_json === "string" ? record.b64_json : undefined;
    if (!url && !b64) continue;
    outputs.push({
      mimeType: "image/png",
      ...(url ? { url } : {}),
      ...(b64 ? { base64: b64 } : {}),
      ...(typeof record.size === "string" ? parseSizeLoose(record.size) : {}),
    });
  }
  return outputs;
}

function parseSizeLoose(size: string): { width?: number; height?: number } {
  const match = /^(\d+)x(\d+)$/.exec(size);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : {};
}
