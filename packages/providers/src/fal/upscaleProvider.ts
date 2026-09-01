import { SeedError, type RestoreTreatment } from "@seed-ae/domain";
import type {
  GenerationProvider,
  ProviderCapabilities,
  ProviderJob,
  ProviderJobState,
  VideoGenerationRequest,
} from "../types.js";
import { FalQueue, type FalConfig } from "./queue.js";

/**
 * Topaz Video Upscale — the restoration lane that cannot invent.
 *
 * Every other video provider here is generative, and each one is asked to
 * preserve the shot by being told to. This one preserves it because it has no
 * way not to: there is no prompt field on the endpoint, so an archive clip
 * comes back as the same clip with more resolution and less noise. For
 * documentary footage that is the difference between a shot that can be cut
 * and a shot that has to be captioned.
 *
 * Schema read from https://fal.ai/models/fal-ai/topaz/upscale/video/api on
 * 2026-09-01. `video_url` and `model` are the only fields with documented
 * enums; `compression`, `noise`, `halo` and `recover_detail` are 0..1 and
 * `grain` is 0..0.1, all with model-dependent defaults — which is why every
 * value sent here is clamped rather than trusted, and why nothing is sent
 * unless a treatment actually asks for it. Leaving a field out gets Topaz's
 * own default for the chosen model, which is a better number than a guess.
 *
 * **Not verified against a live account.** The contract is from Topaz's
 * published schema on fal, not from a response this code has seen. Treat the
 * first real run as the measurement.
 */

export interface UpscaleConfig extends FalConfig {
  model?: string;
  id?: string;
  /** Overridable so a slower, better Topaz model can be chosen per install. */
  topazModel?: string;
}

const DEFAULT_MODEL = "fal-ai/topaz/upscale/video";

/**
 * The Topaz model families the endpoint names.
 *
 * Not narrowed to the ones used below: an install can point at any of them
 * through configuration, and refusing a name the endpoint accepts would be
 * this adapter inventing a restriction Topaz does not have.
 */
const TOPAZ_MODELS = [
  "Proteus",
  "Artemis HQ",
  "Artemis MQ",
  "Artemis LQ",
  "Gaia HQ",
  "Gaia CG",
  "Gaia 2",
  "Nyx",
  "Nyx Fast",
  "Nyx XL",
  "Nyx HF",
  "Starlight Precise 2.5",
  "Starlight HQ",
  "Starlight Mini",
  "Starlight Sharp",
  "Starlight Fast 2",
  "Starlight Precise 1",
  "Starlight Precise 2",
  "Starlight Fast 1",
] as const;

/**
 * How SEED's treatments become Topaz's numbers.
 *
 * The two treatments that reach this lane want opposite things from the same
 * controls, which is exactly why they are separate buttons in the panel rather
 * than one "enhance":
 *
 *   detail — keep everything, resolve more of it. `recover_detail` high and
 *     noise reduction low, because aggressive denoising is how an upscaler
 *     turns skin into wax.
 *   clean  — the recording's faults go, the film's own character stays. Noise
 *     and compression high, `grain` left alone so film grain is not
 *     synthesised back in on top of what survived.
 *
 * `Proteus` for both: it is the model with the manual controls, which is what
 * makes the distinction above expressible at all. The specialised families
 * (Gaia for CG, Nyx for noisy video, Starlight for the heaviest degradation)
 * are reachable through configuration for an install that knows its footage.
 */
const TREATMENTS: Partial<
  Record<RestoreTreatment, { model: string; settings: Record<string, number> }>
> = {
  detail: {
    model: "Proteus",
    settings: { recover_detail: 0.8, noise: 0.15, compression: 0.3, halo: 0.3 },
  },
  clean: {
    model: "Proteus",
    settings: { recover_detail: 0.4, noise: 0.75, compression: 0.8, halo: 0.5 },
  },
};

interface UpscaleResult {
  video?: { url?: string; content_type?: string; file_size?: number };
}

/** 0..1 unless the field says otherwise; `grain` is the odd one at 0..0.1. */
const RANGES: Record<string, [number, number]> = {
  compression: [0, 1],
  noise: [0, 1],
  halo: [0, 1],
  grain: [0, 0.1],
  recover_detail: [0, 1],
};

export class UpscaleProvider implements GenerationProvider {
  readonly id: string;
  private readonly queue: FalQueue;

  constructor(private readonly config: UpscaleConfig) {
    this.id = config.id ?? "topaz-upscale";
    this.queue = new FalQueue(config);
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      id: this.id,
      displayName: "Topaz Upscale (restore, no invention)",
      models: [this.model()],
      operations: ["video.generate"],
      textToImage: false,
      imageToImage: false,
      /*
       * The source is one clip and it travels as `video_url`, so it is a video
       * reference and there is no image reference budget to spend. Declared as
       * zero rather than one: an image here is not a weaker version of the
       * input, it is not an input at all.
       */
      maxImageReferences: 0,
      stableImageReferences: 0,
      addressing: ["hosted-url"],
      nativeGrouping: false,
      requiresBindingText: false,
      mentionSyntax: "positional-en",
      /*
       * No prompt of any kind, which is the whole reason this provider exists.
       * A negative prompt is still a prompt, and declaring support for one
       * would let the panel offer a field that goes nowhere.
       */
      supportsNegativePrompt: false,
      textToVideo: false,
      imageToVideo: false,
      videoReferences: true,
      startEndFrames: false,
      framesExcludeReferences: false,
      audioReferences: false,
      generatesAudio: false,
      outputFormats: [],
      /*
       * Deterministic by construction — there is no sampling to seed. Saying
       * false is not a limitation to apologise for: it means the same clip
       * gives the same result, which is what a restoration wants and what no
       * generative lane can offer.
       */
      seed: false,
      /*
       * Output size is the input size times a factor, so there is no ladder of
       * tiers to choose from. An empty list is the honest answer; the panel
       * asks for a factor instead.
       */
      sizes: [],
      aspectRatios: [],
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
        "An upscale restores an existing clip, so it needs one as a reference.",
      );
    }
    if (source.kind !== "url") {
      throw new SeedError(
        "unsupported_capability",
        "Topaz needs the clip as a fetchable URL. Configure a bucket " +
          "(SEED_R2_*) so clips can be hosted.",
      );
    }

    const parameters = (request.parameters ?? {}) as Record<string, unknown>;
    const treatment = parameters.seedRestore as RestoreTreatment | undefined;
    const preset = treatment ? TREATMENTS[treatment] : undefined;

    /*
     * A factor, not a resolution. Topaz multiplies the source, so asking for
     * "1080p" would mean knowing the input size here — which this adapter does
     * not, and should not have to.
     */
    const factor = clampFactor(parameters.upscaleFactor);

    const body: Record<string, unknown> = {
      video_url: source.value,
      model: this.config.topazModel ?? preset?.model ?? "Proteus",
      upscale_factor: factor,
      ...clampAll(preset?.settings),
      // Overrides last: an install that has measured its own numbers on its own
      // footage beats a table written from a documentation page.
      ...clampAll(parameters.topaz),
      /*
       * H.264 rather than the H.265 default. After Effects and Premiere both
       * import it without a codec pack, and the panel's own preview decodes it
       * — an HEVC result would arrive as a card that says "video" forever, the
       * way the 4:4:4 Seedance outputs did.
       */
      H264_output: true,
    };

    /*
     * Frame interpolation is off unless asked for, and the panel does not ask.
     * Changing the frame rate of archive footage is a creative decision with a
     * strong opinion attached, and this is the lane that promises not to make
     * any — a restored clip has to cut against the original frame for frame.
     */
    if (typeof parameters.targetFps === "number" && parameters.targetFps > 0) {
      body.target_fps = Math.round(parameters.targetFps);
    }

    const submission = await this.queue.submit(this.model(), body, "Topaz");
    return {
      providerJobId: submission.requestId,
      state: { status: "queued" },
      rawRequest: body,
    };
  }

  async getJob(providerJobId: string): Promise<ProviderJobState> {
    const polled = await this.queue.poll<UpscaleResult>(
      this.model(),
      providerJobId,
      "Topaz",
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
          message: "Topaz reported success but returned no video",
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
    await this.queue.cancel(this.model(), providerJobId, "Topaz");
  }

  private model(): string {
    return this.config.model ?? DEFAULT_MODEL;
  }
}

/** The model names the endpoint documents, for a panel that wants to list them. */
export const TOPAZ_MODEL_NAMES: readonly string[] = TOPAZ_MODELS;

/**
 * A factor the endpoint will accept.
 *
 * Held to 1–4. Topaz documents no maximum, but the cost and the queue time
 * both scale with the pixel count and a mistyped 40 would be an expensive way
 * to find that out.
 */
function clampFactor(value: unknown): number {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) return 2;
  return Math.min(Math.max(factor, 1), 4);
}

/**
 * Documented controls only, each held to its documented range.
 *
 * Both halves matter. An undocumented key is dropped rather than forwarded,
 * because a field Topaz does not read looks identical to one it does until a
 * result comes back wrong — the same way `output_format` sat in the Seedance
 * request for months doing nothing. And a value outside the range is clamped
 * rather than refused, because the number came from a slider and the artist's
 * intent at 1.4 is obviously 1.
 */
function clampAll(source: unknown): Record<string, number> {
  if (!source || typeof source !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(source as Record<string, unknown>)) {
    const range = RANGES[key];
    if (!range) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out[key] = Math.min(Math.max(value, range[0]), range[1]);
  }
  return out;
}
