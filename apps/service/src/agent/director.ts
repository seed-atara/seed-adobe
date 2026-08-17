import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  SeedError,
  type Asset,
  type ComposeRequest,
  type ComposedPlan,
  type GenerationOperation,
  type PlannedReference,
} from "@seed-ae/domain";
import { resolveStorageUri, type WorkspaceLayout } from "@seed-ae/storage";
import type { ProviderCapabilities } from "@seed-ae/providers";
import { loadPreview } from "./preview.js";

/**
 * The direction agent: a described scene becomes a reviewable generation plan.
 *
 * Two rules shape everything here.
 *
 * The model never names a provider or a model id. It decides what kind of
 * media the description calls for and writes the prompt; the concrete endpoint
 * comes from declared capabilities and runtime configuration. A plan therefore
 * cannot reference a model that does not exist, however confidently the model
 * might assert one.
 *
 * The plan is a proposal. It fills the panel's form and stops there — the user
 * presses Generate. The deterministic workflow stays theirs.
 */

/** What the model is asked to return. Deliberately provider-agnostic. */
export interface DraftPlan {
  mediaKind: "image" | "video";
  intent: "new" | "edit";
  prompt: string;
  negativePrompt: string | null;
  references: Array<{ candidateIndex: number; role: string }>;
  size: string | null;
  aspectRatio: string | null;
  durationSeconds: number | null;
  seed: number | null;
  rationale: string;
  concerns: string[];
}

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "mediaKind",
    "intent",
    "prompt",
    "negativePrompt",
    "references",
    "size",
    "aspectRatio",
    "durationSeconds",
    "seed",
    "rationale",
    "concerns",
  ],
  properties: {
    mediaKind: {
      type: "string",
      enum: ["image", "video"],
      description: "Whether the description asks for a still or moving image.",
    },
    intent: {
      type: "string",
      enum: ["new", "edit"],
      description:
        "'edit' transforms the first reference and keeps its composition; " +
        "'new' synthesises a frame that merely draws on the references.",
    },
    prompt: {
      type: "string",
      description:
        "The prompt to send to the generative model. Refers to references by " +
        "position ('Image 1'), never by filename or id.",
    },
    negativePrompt: {
      type: ["string", "null"],
      description: "What to keep out of frame, or null.",
    },
    references: {
      type: "array",
      description:
        "The candidates to attach, in the order the prompt refers to them. " +
        "Omit candidates that do not earn their place.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["candidateIndex", "role"],
        properties: {
          candidateIndex: {
            type: "integer",
            description: "1-based index of the candidate shown to you.",
          },
          role: {
            type: "string",
            description: "What this reference contributes, in one clause.",
          },
        },
      },
    },
    size: {
      type: ["string", "null"],
      description: "One of the offered sizes, or null to accept the default.",
    },
    aspectRatio: {
      type: ["string", "null"],
      description:
        "One of the offered aspect ratios, or null. Prefer the one closest to " +
        "the references' own shape unless the description asks otherwise — a " +
        "reframe is usually meant to keep the plate's proportions.",
    },
    durationSeconds: {
      type: ["number", "null"],
      description: "Video length within the offered range, or null.",
    },
    seed: {
      type: ["integer", "null"],
      description: "Only when the user asked to pin or vary the seed.",
    },
    rationale: {
      type: "string",
      description:
        "Two or three sentences for the artist: what you understood, and the " +
        "judgement calls you made. Plain prose, no headers.",
    },
    concerns: {
      type: "array",
      items: { type: "string" },
      description:
        "Anything the user should know before generating: an ambiguity you " +
        "resolved by choosing, or something asked for that is not available.",
    },
  },
} as const;

const SYSTEM_PROMPT = `You are the direction layer of a generative production tool that lives inside After Effects and Premiere. An artist describes a shot; you turn that into a prompt a generative image or video model will answer well, and you choose which of their reference frames to attach.

You are looking at the artist's actual footage. Read the references before writing — the lighting, lens, palette, and grade you can see in them are the facts of the shot, and the prompt should be consistent with what is there rather than with a generic idea of the subject.

How prompts reach the model:
- References are attached as an ordered list and the model knows them only by position. Write "Image 1", "the second reference" — a filename or an asset id means nothing to it.
- Order is yours to choose. For an edit, the frame being transformed is Image 1.
- Attach a reference only when it does work. An unused reference costs quality.

Writing the prompt:
- Lead with the subject and action, then framing and lens, then light, then palette and grade, then medium or film stock. Concrete nouns beat adjectives.
- Carry across what the artist already established in the references instead of restating it as instructions where showing is enough.
- Keep the artist's own terms when they used them. Their vocabulary is usually load-bearing.
- One paragraph. No lists, no headers, no "masterpiece, 8k, highly detailed" tag-soup.

The artist reviews everything before anything runs, so make the judgement calls rather than asking questions — and say in the rationale what you chose and why. Note real ambiguities as concerns instead of guessing silently.`;

export interface DirectorOptions {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fast?: boolean;
  workspace: WorkspaceLayout;
}

/**
 * How many candidates are shown as pictures.
 *
 * Every image is input tokens and latency, and this is a short creative task —
 * the artist is waiting on it with a comp open. The ones that matter are the
 * ones already attached or named; a long tail of recent captures adds seconds
 * for candidates the model will not choose anyway.
 */
const MAX_PICTURES = 4;

export interface ComposeInput {
  request: ComposeRequest;
  /** Candidate assets, already resolved and in the panel's order. */
  candidates: Asset[];
  providers: ProviderCapabilities[];
}


/** How an asset is described in words, alongside its picture. */
function describeCandidate(asset: Asset, index: number): string {
  const parts = [`Candidate ${index + 1}: ${asset.filename}`];
  parts.push(asset.kind);
  if (asset.width && asset.height) parts.push(`${asset.width}x${asset.height}`);
  if (asset.durationSeconds) parts.push(`${asset.durationSeconds}s`);

  const source = asset.source as Record<string, unknown> | undefined;
  const comp = source?.compName;
  if (typeof comp === "string") {
    const frame = source?.frameNumber;
    parts.push(
      typeof frame === "number" ? `from ${comp} frame ${frame}` : `from ${comp}`,
    );
  } else if (asset.generationId) {
    parts.push("generated by SEED");
  }
  return parts.join(" — ");
}

/**
 * Picks the provider that can actually do the work.
 *
 * A preference is honoured only when it fits: silently generating a still
 * because the video provider was not selected would be worse than saying so.
 */
function chooseProvider(
  providers: ProviderCapabilities[],
  mediaKind: "image" | "video",
  preferredId: string | undefined,
  warnings: string[],
): ProviderCapabilities {
  const wanted = (provider: ProviderCapabilities) =>
    mediaKind === "video"
      ? provider.textToVideo || provider.imageToVideo
      : provider.textToImage || provider.imageToImage;

  // Mock providers exist so the workflow can be exercised without credentials.
  // They are a fallback, never a default: planning a real shot onto a mock is
  // a silent downgrade the artist would only discover from the result.
  const capable = providers
    .filter(wanted)
    .sort(
      (a, b) => Number(a.id.startsWith("mock")) - Number(b.id.startsWith("mock")),
    );
  if (capable.length === 0) {
    throw new SeedError(
      "unsupported_capability",
      `no configured provider can generate ${mediaKind}. ` +
        (mediaKind === "video"
          ? "Configure a video provider, or describe a still frame."
          : "Configure an image provider."),
    );
  }

  const preferred = capable.find((provider) => provider.id === preferredId);
  if (preferred) return preferred;

  const chosen = capable[0] as ProviderCapabilities;
  if (preferredId && providers.some((p) => p.id === preferredId)) {
    warnings.push(
      `The description asks for ${mediaKind}, which ${preferredId} does not generate — planned for ${chosen.displayName} instead.`,
    );
  }
  return chosen;
}

/** Maps the draft onto what the chosen provider actually accepts. */
function fitToProvider(
  draft: DraftPlan,
  provider: ProviderCapabilities,
  candidates: Asset[],
  warnings: string[],
): ComposedPlan {
  const references: PlannedReference[] = [];
  for (const entry of draft.references) {
    const asset = candidates[entry.candidateIndex - 1];
    if (!asset) continue; // an index we never offered
    if (references.some((existing) => existing.assetId === asset.id)) continue;
    references.push({
      assetId: asset.id,
      label: `Image ${references.length + 1}`,
      role: entry.role,
    });
  }

  if (references.length > provider.maxImageReferences) {
    const dropped = references.splice(provider.maxImageReferences);
    warnings.push(
      `${provider.displayName} accepts ${provider.maxImageReferences} references; ` +
        `dropped ${dropped.map((reference) => reference.role).join(", ")}.`,
    );
  }

  const wantsVideo = draft.mediaKind === "video";
  let operation: GenerationOperation = wantsVideo
    ? "video.generate"
    : draft.intent === "edit" && references.length > 0
      ? "image.edit"
      : "image.generate";

  if (!provider.operations.includes(operation)) {
    const fallback = provider.operations[0];
    if (!fallback) {
      throw new SeedError(
        "unsupported_capability",
        `${provider.displayName} declares no operations.`,
      );
    }
    warnings.push(
      `${provider.displayName} does not support ${operation}; planned as ${fallback}.`,
    );
    operation = fallback;
  }

  let size: string | undefined;
  if (draft.size) {
    if (provider.sizes.length === 0 || provider.sizes.includes(draft.size)) {
      size = draft.size;
    } else {
      warnings.push(
        `${draft.size} is not offered by ${provider.displayName} — using its default.`,
      );
    }
  }

  let aspectRatio: string | undefined;
  if (draft.aspectRatio) {
    if (
      provider.aspectRatios.length === 0 ||
      provider.aspectRatios.includes(draft.aspectRatio)
    ) {
      aspectRatio = draft.aspectRatio;
    } else {
      warnings.push(
        `${draft.aspectRatio} is not an offered aspect ratio — omitted.`,
      );
    }
  }

  let durationSeconds: number | undefined;
  if (wantsVideo && draft.durationSeconds !== null) {
    const range = provider.durationSecondsRange;
    if (!range) durationSeconds = draft.durationSeconds;
    else {
      const [min, max] = range;
      const clamped = Math.min(Math.max(draft.durationSeconds, min), max);
      if (clamped !== draft.durationSeconds) {
        warnings.push(
          `${draft.durationSeconds}s is outside ${provider.displayName}'s ${min}–${max}s range — planned ${clamped}s.`,
        );
      }
      durationSeconds = clamped;
    }
  }

  const seed =
    draft.seed !== null && provider.seed ? draft.seed : undefined;
  if (draft.seed !== null && !provider.seed) {
    warnings.push(`${provider.displayName} does not accept a seed.`);
  }

  const model = provider.models[0];
  if (!model) {
    throw new SeedError(
      "unsupported_capability",
      `${provider.displayName} has no configured model id.`,
    );
  }

  return {
    providerId: provider.id,
    model,
    operation,
    prompt: draft.prompt.trim(),
    ...(draft.negativePrompt ? { negativePrompt: draft.negativePrompt } : {}),
    ...(size ? { size } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(seed !== undefined ? { seed } : {}),
    references,
    rationale: draft.rationale.trim(),
    warnings: [...warnings, ...draft.concerns],
  };
}

/** Everything the model is told about what it can ask for. */
function describeCapabilities(providers: ProviderCapabilities[]): string {
  return providers
    .map((provider) => {
      const can: string[] = [];
      if (provider.textToImage) can.push("text-to-image");
      if (provider.imageToImage) can.push("image-to-image");
      if (provider.textToVideo) can.push("text-to-video");
      if (provider.imageToVideo) can.push("image-to-video");

      const lines = [
        `- ${provider.displayName}: ${can.join(", ") || "nothing declared"}`,
        `  references: up to ${provider.maxImageReferences}`,
      ];
      if (provider.sizes.length > 0) {
        lines.push(`  sizes: ${provider.sizes.join(", ")}`);
      }
      if (provider.aspectRatios.length > 0) {
        lines.push(`  aspect ratios: ${provider.aspectRatios.join(", ")}`);
      }
      if (provider.durationSecondsRange) {
        const [min, max] = provider.durationSecondsRange;
        lines.push(`  duration: ${min}–${max}s`);
      }
      if (!provider.seed) lines.push("  no seed control");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Fits a draft onto a real provider.
 *
 * Separated from the model call so the rules that matter — which provider can
 * do the work, what gets clamped, what the artist is told — are testable
 * without a network round trip.
 */
export function planFromDraft(
  draft: DraftPlan,
  providers: ProviderCapabilities[],
  candidates: Asset[],
  preferredProviderId?: string,
): ComposedPlan {
  const warnings: string[] = [];
  const provider = chooseProvider(
    providers,
    draft.mediaKind,
    preferredProviderId,
    warnings,
  );
  return fitToProvider(draft, provider, candidates, warnings);
}

export class PromptDirector {
  private readonly client: Anthropic;

  constructor(private readonly options: DirectorOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async compose({
    request,
    candidates,
    providers,
  }: ComposeInput): Promise<ComposedPlan> {
    if (providers.length === 0) {
      throw new SeedError(
        "unsupported_capability",
        "no generation providers are configured.",
      );
    }

    const content: Anthropic.ContentBlockParam[] = [];

    if (candidates.length > 0) {
      content.push({
        type: "text",
        text:
          "The artist has attached these references, in this order. Write for " +
          "them: which images are used is their decision, already made. Say so " +
          "in a concern if one of them works against the description, rather " +
          "than quietly leaving it out.",
      });
      for (const [index, asset] of candidates.entries()) {
        content.push({ type: "text", text: describeCandidate(asset, index) });
        const preview =
          index < MAX_PICTURES
            ? await loadPreview(this.options.workspace, asset)
            : undefined;
        if (preview) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: preview.mediaType as "image/png",
              data: preview.data,
            },
          });
        }
      }
    }

    if (request.mentions.length > 0) {
      const named = request.mentions
        .map((mention) => {
          const index = candidates.findIndex(
            (asset) => asset.id === mention.assetId,
          );
          return index >= 0
            ? `@${mention.token} is Candidate ${index + 1}`
            : undefined;
        })
        .filter(Boolean);
      if (named.length > 0) {
        content.push({
          type: "text",
          text:
            `The artist named these directly, so they belong in the plan:\n` +
            named.join("\n"),
        });
      }
    }

    content.push({
      type: "text",
      text: `What is available to generate with:\n${describeCapabilities(providers)}`,
    });

    /*
     * Mentions are resolved before the description is shown. The token is how
     * the artist points at a picture in the panel; to the model it is a
     * filename in the middle of a sentence that it has to read past, and the
     * candidate it names is already listed above.
     */
    let described = request.description;
    for (const mention of request.mentions) {
      const index = candidates.findIndex((asset) => asset.id === mention.assetId);
      described = described
        .split(`@${mention.token}`)
        .join(index >= 0 ? `Candidate ${index + 1}` : mention.token);
    }

    content.push({
      type: "text",
      text: `The artist's description:\n\n${described}`,
    });

    if (request.parentAssetId) {
      content.push({
        type: "text",
        text: "This is a variation on an existing result — keep what works and change what they asked for.",
      });
    }

    const params = {
      model: this.options.model,
      max_tokens: 4000,
      thinking: { type: "adaptive" as const },
      system: SYSTEM_PROMPT,
      output_config: {
        // A short creative task: thinking hard about it mostly costs the
        // artist time while they wait with a comp open.
        effort: this.options.effort ?? "low",
        format: { type: "json_schema" as const, schema: DRAFT_SCHEMA },
      },
      messages: [{ role: "user" as const, content }],
    };

    let response: Anthropic.Message;
    try {
      response = this.options.fast
        ? ((await this.client.beta.messages.create({
            ...params,
            speed: "fast",
            betas: ["fast-mode-2026-02-01"],
          })) as unknown as Anthropic.Message)
        : await this.client.messages.create(params);
    } catch (cause) {
      if (cause instanceof Anthropic.AuthenticationError) {
        throw new SeedError(
          "provider_error",
          "ANTHROPIC_API_KEY was rejected — direction is unavailable.",
        );
      }
      if (cause instanceof Anthropic.RateLimitError) {
        throw new SeedError(
          "provider_error",
          "the direction model is rate limited; try again shortly.",
        );
      }
      throw new SeedError(
        "provider_error",
        `direction failed: ${(cause as Error).message}`,
      );
    }

    if (response.stop_reason === "refusal") {
      throw new SeedError(
        "bad_request",
        "the direction model declined this description.",
      );
    }

    const text = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === "text",
    )?.text;
    if (!text) {
      throw new SeedError(
        "provider_error",
        response.stop_reason === "max_tokens"
          ? "the direction model ran out of room before returning a plan."
          : "the direction model returned no plan.",
      );
    }

    let draft: DraftPlan;
    try {
      draft = JSON.parse(text) as DraftPlan;
    } catch {
      throw new SeedError(
        "provider_error",
        "the direction model returned something that was not a plan.",
      );
    }

    return planFromDraft(draft, providers, candidates, request.preferredProviderId);
  }
}
