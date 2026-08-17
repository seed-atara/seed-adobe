import { SeedError } from "@seed-ae/domain";
import type { ArkAssetLibrary, PublicUrlPublisher } from "../ark/assetLibrary.js";
import {
  MAX_REFERENCES,
  assertModelAvailable,
  assertSizeAllowed,
  sizesFor,
} from "../ark/models.js";
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

/**
 * How a local reference frame reaches the model.
 *
 * `hosted` puts the bytes in the bucket and sends the presigned link, which is
 * the form Volcengine's own examples use and the only alternative to inline
 * that exists — verified 2026-08-13 by trying all three candidates against the
 * live endpoint. `hosted` fails rather than falling back, because a pipeline
 * that must not post raw pixels needs that failure to be loud.
 *
 * The `asset://<id>` route ADR 0005 was built around is not one of the three:
 * images/generations answers "invalid url specified" to an asset id in any
 * form. Registration itself works — the ids are real — but nothing at
 * inference will take one. See MODEL_API_NOTES.md.
 */
export type ReferencePolicy = "hosted" | "hosted-or-inline" | "inline";

/** Old spellings from when the asset library was believed to be the route. */
const POLICY_ALIASES: Record<string, ReferencePolicy> = {
  asset: "hosted",
  "asset-or-inline": "hosted-or-inline",
};

/** Accepts the old names so an existing .env keeps working. */
export function normalizeReferencePolicy(value: string): ReferencePolicy {
  return POLICY_ALIASES[value] ?? (value as ReferencePolicy);
}

export interface SeedreamConfig {
  /** Inference base, e.g. https://ark.ap-southeast.bytepluses.com/api/v3 */
  baseUrl: string;
  /** Ark API key, used as `Authorization: Bearer <key>`. NOT an AK/SK pair. */
  apiKey: string;
  /** Model id — configuration, never a hard-coded guess. */
  model: string;
  /**
   * Asset library client.
   *
   * Kept because registration works and the ids are real; not used to build a
   * reference, because inference will not take one.
   */
  assetLibrary?: ArkAssetLibrary;
  /** Puts a local frame somewhere Ark can fetch it. Required by `hosted`. */
  publisher?: PublicUrlPublisher;
  referencePolicy?: ReferencePolicy;
  watermark?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const IMAGES_PATH = "/images/generations";

/**
 * Volcengine/BytePlus Ark image generation (Seedream).
 *
 * `POST {baseUrl}/images/generations` with `Authorization: Bearer $ARK_API_KEY`.
 * Image generation is **synchronous** — there is no task polling (that is the
 * video API), so a submitted job comes back already terminal.
 */
export class SeedreamProvider implements GenerationProvider {
  readonly id = "seedream";

  private readonly config: SeedreamConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly referencePolicy: ReferencePolicy;
  /** Ark answers in the initial response, so job state is held locally. */
  private readonly jobs = new Map<string, ProviderJobState>();
  private counter = 0;

  constructor(config: SeedreamConfig) {
    if (!config.apiKey) {
      throw new SeedError(
        "unauthorized",
        "Seedream needs an Ark API key for `Authorization: Bearer` (inference). " +
          "An account AK/SK pair is a different credential — it signs the asset " +
          "library OpenAPI, and cannot authenticate image generation.",
      );
    }
    assertModelAvailable(config.model);

    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.referencePolicy = normalizeReferencePolicy(
      config.referencePolicy ?? "hosted-or-inline",
    );

    if (this.referencePolicy === "hosted" && !config.publisher) {
      throw new SeedError(
        "bad_request",
        'referencePolicy "hosted" needs a public URL publisher: the frame has ' +
          "to be somewhere Ark can fetch it. Configure SEED_R2_*, or use the " +
          "inline policy.",
      );
    }
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Seedream (Ark)",
      models: [this.config.model],
      operations: ["image.generate", "image.edit"],
      textToImage: true,
      imageToImage: true,
      maxImageReferences: MAX_REFERENCES,
      /*
       * No narrower working range is published for Seedream, unlike Seedance,
       * so the stable range is the maximum rather than a number invented to
       * look cautious. If a probe finds identity degrades past some count,
       * this is where that finding lands.
       */
      stableImageReferences: MAX_REFERENCES,
      /*
       * `asset://` ids are rejected by images/generations in every form — see
       * ADR 0010. A hosted link is the accepted shape, with inline data URLs
       * still working for imagery that is not a recognisable person.
       */
      addressing: ["hosted-url", "inline"],
      nativeGrouping: false,
      /*
       * Measured: the model refers to inputs by position and does not resolve
       * ids in prose. It does not ask for a mapping block the way Seedance
       * does, so items bind by position alone here.
       */
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      supportsNegativePrompt: false,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: false,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      generatesAudio: false,
      seed: true,
      sizes: sizesFor(this.config.model),
      aspectRatios: ["1:1", "16:9", "9:16", "21:9"],
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

  /**
   * Registers references ahead of time so pressing Generate is a cache hit.
   * Registration is free and slow; generation is paid and interactive.
   */
  async prewarm(inputs: MaterializedInput[]): Promise<string[]> {
    return Promise.all(inputs.map((input) => this.toImageValue(input)));
  }

  private async send(
    request: ImageGenerationRequest | ImageEditRequest,
    references: MaterializedInput[],
  ): Promise<ProviderJob> {
    const model = request.model || this.config.model;
    assertModelAvailable(model);

    const size = request.size ?? "2K";
    assertSizeAllowed(model, size);

    if (references.length > MAX_REFERENCES) {
      throw new SeedError(
        "unsupported_capability",
        `Ark accepts at most ${MAX_REFERENCES} reference images, received ${references.length}`,
      );
    }

    const images = await Promise.all(
      references.map((reference) => this.toImageValue(reference)),
    );

    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      size,
      response_format: "url",
      watermark: this.config.watermark ?? false,
      sequential_image_generation: "disabled",
    };
    if (request.seed !== undefined) body.seed = request.seed;
    if (images.length === 1) body.image = images[0];
    else if (images.length > 1) body.image = images;

    this.counter += 1;
    const providerJobId = `seedream_${this.counter}_${request.correlationId}`;
    // Generation can legitimately take minutes at 4K.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 300_000,
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
      clearTimeout(timer);
    }

    // The key never enters the stored request.
    const rawRequest = { url: `${this.config.baseUrl}${IMAGES_PATH}`, body };

    if (!response.ok) {
      const state: ProviderJobState = {
        status: "failed",
        error: {
          class: "provider_error",
          message: describeFailure(response.status, payload),
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
                "Seedream response contained no image data; raw payload preserved",
            },
            raw: payload,
          };

    this.jobs.set(providerJobId, state);
    return { providerJobId, state, rawRequest };
  }

  /**
   * Converts a materialized input into something the `image` field accepts.
   *
   * Two forms, and only two: an https URL or a data URL. An asset id is not
   * one of them — see the note on ReferencePolicy.
   */
  private async toImageValue(input: MaterializedInput): Promise<string> {
    // Already reachable — the materializer hosted it, or the caller passed a
    // URL. Nothing to do but use it.
    if (input.kind === "url") return input.value;

    const inline =
      input.kind === "dataUrl"
        ? input.value
        : `data:${input.mimeType};base64,${input.value}`;

    if (this.referencePolicy === "inline") return inline;

    const publisher = this.config.publisher;
    if (!publisher) {
      if (this.referencePolicy === "hosted") {
        throw new SeedError(
          "bad_request",
          'referencePolicy "hosted" needs a public URL publisher; none is configured',
        );
      }
      return inline;
    }

    const base64 = inline.slice(inline.indexOf(",") + 1);
    const bytes = Buffer.from(base64, "base64");

    try {
      const { url } = await publisher.publish({
        bytes,
        filename: `${input.assetId ?? "reference"}.png`,
        mimeType: input.mimeType,
      });
      return url;
    } catch (cause) {
      if (this.referencePolicy === "hosted") {
        // Never silently post raw pixels when the policy says otherwise: the
        // inline path is the one that gets intercepted for real people.
        throw cause;
      }
      return inline;
    }
  }
}

function describeFailure(status: number, payload: unknown): string {
  const error = (payload as { error?: { message?: string; code?: string } })
    ?.error;
  const detail = error?.message ?? error?.code;
  if (status === 404) {
    return `Seedream returned HTTP 404 — the model may have been withdrawn or the base URL is wrong${
      detail ? `: ${detail}` : ""
    }`;
  }
  return `Seedream returned HTTP ${status}${detail ? `: ${detail}` : ""}`;
}

/**
 * Reads both delivery shapes. Returned URLs are temporary, so the caller
 * downloads immediately rather than storing the link.
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
      // Ark does not declare the format and returns JPEG in practice; the
      // ingestor sniffs the bytes rather than trusting a guess made here.
      mimeType: "",
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
