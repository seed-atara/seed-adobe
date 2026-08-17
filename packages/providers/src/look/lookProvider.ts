import { SeedError } from "@seed-ae/domain";
import {
  applyFilmLook,
  createImage,
  PRESETS,
  resolveConfig,
  type FilmLookConfig,
  type FloatImage,
} from "@seed-ae/filmlook";
import { decodePng, encodePng } from "@seed-ae/media";
import type {
  GenerationProvider,
  ImageEditRequest,
  MaterializedInput,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
} from "../types.js";

/**
 * The film look, as a provider.
 *
 * A look is a deterministic generation — one input, one output, reproducible
 * from a config and a seed, with no network call. Putting it behind the same
 * contract as Seedream and Seedance means it inherits jobs, lineage, recipes,
 * the library and the iterate-in-place flow without any of them being written
 * again, and it keeps treated frames inside the provenance model rather than
 * beside it. Regrading a shot is then the same gesture as re-rendering it.
 *
 * It runs as `image.edit` rather than an operation of its own. An edit is
 * exactly what this is — an image in, a modified image out — and inventing a
 * fourth operation would have meant touching the domain enum, the router and
 * every switch over operations to describe something the existing one already
 * says.
 *
 * Synchronous underneath: the work happens on submit and `getJob` reports what
 * already finished. Stills take well under a second; video will not, and will
 * need a different execution model rather than a longer wait.
 */
export interface LookProviderOptions {
  /** Model ids are the preset ids, so the recipe records which look ran. */
  presets?: readonly string[];
  /** Injected in tests to keep a render off the critical path. */
  now?: () => number;
}

interface FinishedLook {
  png: Buffer;
  width: number;
  height: number;
  config: FilmLookConfig;
}

export class LookProvider implements GenerationProvider {
  readonly id = "film-look";

  private readonly jobs = new Map<string, FinishedLook | { error: string }>();
  private readonly presetIds: string[];
  private counter = 0;

  constructor(options: LookProviderOptions = {}) {
    this.presetIds = [...(options.presets ?? PRESETS.map((preset) => preset.id))];
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Film Look",
      models: this.presetIds,
      operations: ["image.edit"],
      textToImage: false,
      // It edits an image and needs one; it cannot invent a frame.
      imageToImage: true,
      /*
       * One, and that one is the subject rather than a reference: the service
       * takes inputs[0] as the image to edit and counts every input against
       * this cap. A look has nothing to refer to — it is a transfer function
       * with a config, not a model with context.
       */
      maxImageReferences: 1,
      stableImageReferences: 1,
      addressing: ["inline"],
      nativeGrouping: false,
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
      // Grain is seeded, and the seed is part of the config rather than a
      // separate control the caller sets per run.
      seed: false,
      sizes: [],
      aspectRatios: [],
      async: false,
    };
  }

  async editImage(request: ImageEditRequest): Promise<ProviderJob> {
    const providerJobId = `look_${++this.counter}`;

    try {
      const source = decodeInput(request.image);
      const config = configFrom(request);
      const frame = Number(request.parameters?.["frame"]) || 0;

      const { image } = applyFilmLook(source, config, { frame });
      const png = encodePng(image.width, image.height, toBytes(image));

      this.jobs.set(providerJobId, {
        png,
        width: image.width,
        height: image.height,
        config,
      });
    } catch (cause) {
      this.jobs.set(providerJobId, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }

    return {
      providerJobId,
      state: await this.getJob(providerJobId),
      /*
       * The resolved config is the raw request. There is no wire payload to
       * record, and the config is the thing that would be needed to reproduce
       * this exactly — which is what the raw request is for.
       */
      rawRequest: {
        preset: request.model,
        config: this.jobs.get(providerJobId),
      },
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const job = this.jobs.get(providerJobId);
    if (!job) {
      throw new SeedError("not_found", `unknown look job ${providerJobId}`);
    }

    if ("error" in job) {
      return {
        status: "failed",
        error: { class: "provider_error", message: job.error },
      };
    }

    return {
      status: "succeeded",
      progress: 1,
      outputs: [
        {
          mimeType: "image/png",
          base64: job.png.toString("base64"),
          width: job.width,
          height: job.height,
        },
      ],
      raw: { config: job.config },
    };
  }
}

/**
 * The config for this run.
 *
 * `model` carries the preset id, so a recipe records which look was applied
 * rather than only the sixty-six numbers it resolved to. The overrides carry
 * whatever the artist changed, and they win — which is the merge rule the
 * specification gives, applied at the edge where the request arrives.
 */
function configFrom(request: ImageEditRequest): FilmLookConfig {
  const parameters = request.parameters ?? {};
  const intensity =
    typeof parameters["intensity"] === "number" ? parameters["intensity"] : 1;
  const overrides =
    typeof parameters["look"] === "object" && parameters["look"] !== null
      ? (parameters["look"] as Partial<FilmLookConfig>)
      : {};

  return resolveConfig({ preset: request.model, intensity, overrides });
}

/** 8-bit PNG in, float image out. */
function decodeInput(input: MaterializedInput): FloatImage {
  const bytes = bytesOf(input);
  const decoded = decodePng(bytes);
  if (!decoded) {
    throw new SeedError(
      "unsupported_capability",
      "the film look reads PNG, and this input is not one — capture writes " +
        "PNG, so a JPEG here means the source came from somewhere else",
    );
  }

  const image = createImage(decoded.width, decoded.height);
  for (let i = 0; i < image.data.length; i++) {
    image.data[i] = decoded.rgba[i]! / 255;
  }
  return image;
}

function bytesOf(input: MaterializedInput): Buffer {
  if (input.kind === "base64") return Buffer.from(input.value, "base64");
  if (input.kind === "dataUrl") {
    const comma = input.value.indexOf(",");
    if (comma < 0) throw new SeedError("provider_error", "malformed data URL");
    return Buffer.from(input.value.slice(comma + 1), "base64");
  }
  throw new SeedError(
    "unsupported_capability",
    "the film look runs locally and needs the bytes, not a URL",
  );
}

/**
 * Float image back to 8-bit.
 *
 * Rounded rather than truncated, and clamped: the tonemap can leave a peak
 * highlight fractionally above 1, and truncation would cost half a code value
 * on every pixel — visible as a slight darkening across a whole frame.
 */
function toBytes(image: FloatImage): Uint8Array {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < image.data.length; i++) {
    const value = image.data[i]!;
    out[i] = value <= 0 ? 0 : value >= 1 ? 255 : Math.round(value * 255);
  }
  return out;
}
