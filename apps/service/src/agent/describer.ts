import Anthropic from "@anthropic-ai/sdk";
import { SeedError, type Asset, type ItemKind, type ItemTrait } from "@seed-ae/domain";
import type { WorkspaceLayout } from "@seed-ae/storage";
import { loadPreview } from "./preview.js";

/**
 * Reading an item's plates and proposing what to write down about it.
 *
 * The temptation is to caption the pictures. That would be worse than nothing:
 * the plates are *sent with every generation*, so describing what they plainly
 * show spends prompt tokens restating something the model can already see, and
 * every word of it competes with the shot direction.
 *
 * What is worth writing down is the opposite — the detail a reference **loses**.
 * These models reconstruct a subject rather than copying it, and what survives
 * reconstruction is face, proportion, palette. What quietly disappears is the
 * discrete and nameable: a scar, a tattoo, a logo, an asymmetry, a count, an
 * exact colour, text on a garment. Those are the traits worth spending words
 * on, and marking them is the whole job.
 *
 * A proposal, never an application. ADR 0007's boundary: the model drafts, the
 * artist edits, nothing is saved until they say so.
 */

const SYSTEM_PROMPT = `You are helping a film production write down what it needs to remember about a recurring subject — a character, a location, a prop, or a look.

You are shown that subject's REFERENCE PLATES. Those exact images are attached to every future generation, so the model will always be able to see them.

Because of that, your job is NOT to describe the pictures. Describing what a plate plainly shows wastes prompt space on something already visible, and every wasted word competes with the shot direction the artist is writing.

Write down what a reference LOSES.

These image models reconstruct a subject rather than copying it. What survives reconstruction: overall face, build, proportion, palette, silhouette. What quietly disappears, shot after shot, is the discrete and nameable:
- scars, moles, tattoos, chipped teeth, a broken nose
- asymmetries — one sleeve rolled, a crooked collar, a limp
- counts — three buttons, two rings, a double-pierced ear
- text and marks — a logo, a badge number, a sign, a sticker
- exact colours where "close" is wrong — acid yellow rather than lemon
- specific materials — waxed cotton rather than "a jacket"

Mark those \`driftProne: true\`. They are the ones that get spent when prompt space is tight, and they are the reason this feature exists.

Also record the obvious attributes — hair, wardrobe, age, the shape of a room — with \`driftProne: false\`. They are useful to the artist as a written record and as a fallback when no plate can travel, but they will rarely be sent.

Rules:
- Each trait is a short fragment, not a sentence. "faint scar through the left eyebrow", not "She has a faint scar...".
- Be specific or say nothing. "Distinctive face" is worthless. Six good traits beat twenty vague ones.
- Only what you can actually see. Do not invent a backstory, a name, or a detail that is not in the plates.
- \`priority\` orders them: 0 is the most important thing to preserve.
- Put in \`avoid\` only things that would clearly be wrong for this subject and are likely to appear anyway — a modern logo on a period costume, sunglasses hiding a face you need. Leave it empty if nothing qualifies.
- \`summary\` is one plain sentence for the artist, saying what you saw and what you think matters most.

If the plates disagree with each other — different people, different rooms — say so in \`summary\` rather than averaging them into a subject that does not exist.`;

const TRAIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["traits", "avoid", "summary"],
  properties: {
    traits: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "facet", "priority", "driftProne"],
        properties: {
          text: { type: "string", maxLength: 120 },
          facet: {
            type: "string",
            enum: [
              "face",
              "hair",
              "body",
              "age",
              "wardrobe",
              "material",
              "scale",
              "setting",
              "light",
              "grade",
              "optics",
              "grain",
              "mood",
              "other",
            ],
          },
          priority: { type: "integer", minimum: 0 },
          driftProne: { type: "boolean" },
        },
      },
    },
    avoid: { type: "array", maxItems: 8, items: { type: "string", maxLength: 80 } },
    summary: { type: "string", maxLength: 400 },
  },
} as const;

export interface DescriberOptions {
  apiKey: string;
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fast?: boolean;
  workspace: WorkspaceLayout;
}

export interface DescribeInput {
  kind: ItemKind;
  /** What the artist called it, when they have already typed a name. */
  name?: string;
  plates: Array<{ asset: Asset; role: string }>;
}

export interface DescribeResult {
  traits: ItemTrait[];
  avoid: string[];
  summary: string;
}

/**
 * How many plates are shown.
 *
 * Every image is input tokens and latency, and the artist is waiting on this
 * with a dialog open. Six is more than enough to find what the plates have in
 * common, which is what this is looking for.
 */
const MAX_PLATES = 6;

export class ItemDescriber {
  private readonly client: Anthropic;

  constructor(private readonly options: DescriberOptions) {
    this.client = new Anthropic({ apiKey: options.apiKey });
  }

  async describe(input: DescribeInput): Promise<DescribeResult> {
    const content: Anthropic.ContentBlockParam[] = [];
    const shown = input.plates.slice(0, MAX_PLATES);

    let pictures = 0;
    for (const { asset, role } of shown) {
      const preview = await loadPreview(this.options.workspace, asset);
      if (!preview) continue;
      pictures += 1;
      content.push({
        type: "text",
        text: `Plate ${pictures} — role: ${role}`,
      });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: preview.mediaType as "image/png",
          data: preview.data,
        },
      });
    }

    if (pictures === 0) {
      throw new SeedError(
        "bad_request",
        "none of the selected plates could be read as an image, so there is nothing to look at",
      );
    }

    content.push({
      type: "text",
      text: [
        `This is a ${input.kind}${input.name ? ` the artist is calling "${input.name}"` : ""}.`,
        `You are looking at ${pictures} of its reference plates.`,
        "Write down what these plates will lose.",
      ].join(" "),
    });

    const params = {
      model: this.options.model,
      max_tokens: 2000,
      thinking: { type: "adaptive" as const },
      system: SYSTEM_PROMPT,
      output_config: {
        effort: this.options.effort ?? "low",
        format: { type: "json_schema" as const, schema: TRAIT_SCHEMA },
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
          "ANTHROPIC_API_KEY was rejected — describing an item is unavailable.",
        );
      }
      throw new SeedError(
        "provider_error",
        `could not describe these plates: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    let parsed: DescribeResult;
    try {
      parsed = JSON.parse(text) as DescribeResult;
    } catch {
      throw new SeedError("provider_error", "the description came back unreadable");
    }

    return {
      traits: (parsed.traits ?? []).map((trait, index) => ({
        text: trait.text,
        facet: trait.facet,
        priority: trait.priority ?? index,
        driftProne: trait.driftProne ?? false,
      })),
      avoid: parsed.avoid ?? [],
      summary: parsed.summary ?? "",
    };
  }
}
