import { z } from "zod";
import { GenerationOperationSchema } from "./generation.js";

/**
 * Direction is the agent layer: a described scene plus some references becomes
 * a concrete, reviewable generation request.
 *
 * The division of labour is deliberate. The model does what a model is good at
 * — reading the description, looking at the references, and writing a prompt in
 * the register the image and video models actually respond to. It does not pick
 * provider endpoints or model ids; those come from runtime configuration and
 * declared capabilities, so a plan can never name a model that does not exist.
 */

/** How the author referred to an asset in prose. */
export const MentionSchema = z.object({
  /** The text typed, without the leading `@`. */
  token: z.string().min(1),
  assetId: z.string().min(1),
});
export type Mention = z.infer<typeof MentionSchema>;

export const ComposeRequestSchema = z.object({
  /**
   * What the user wants, in their own words. May contain `@name` mentions of
   * library assets, which the panel resolves before sending.
   */
  description: z.string().min(1).max(4000),
  /** Assets available as references, in the order the panel offered them. */
  candidateAssetIds: z.array(z.string()).max(12).default([]),
  mentions: z.array(MentionSchema).max(12).default([]),
  /** Honoured when the provider can do the work the description implies. */
  preferredProviderId: z.string().optional(),
  /** Set when the user is varying an existing recipe rather than starting new. */
  parentAssetId: z.string().optional(),
  parentGenerationId: z.string().optional(),
});
export type ComposeRequest = z.infer<typeof ComposeRequestSchema>;

/** One reference, with the slot label the prompt refers to it by. */
export const PlannedReferenceSchema = z.object({
  assetId: z.string(),
  /** "Image 1", "Image 2" — the positional name the prompt uses. */
  label: z.string(),
  /** Why this asset is in the plan, in one clause. */
  role: z.string(),
});
export type PlannedReference = z.infer<typeof PlannedReferenceSchema>;

/**
 * A proposal, never an execution.
 *
 * The panel fills its form from this and waits for the user to press Generate.
 * Nothing here starts a job, and nothing here touches the timeline — the
 * deterministic workflow stays in the user's hands.
 */
export const ComposedPlanSchema = z.object({
  providerId: z.string(),
  model: z.string(),
  operation: GenerationOperationSchema,
  /** The rewritten prompt, referring to references by position. */
  prompt: z.string().min(1),
  negativePrompt: z.string().optional(),
  size: z.string().optional(),
  aspectRatio: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  seed: z.number().int().optional(),
  references: z.array(PlannedReferenceSchema).default([]),
  /** One short paragraph explaining the choices, shown above the form. */
  rationale: z.string(),
  /**
   * Where the plan was adjusted to fit what the provider actually supports, or
   * where the description asked for something unavailable. Surfaced verbatim:
   * a silently clamped plan is a plan the user cannot trust.
   */
  warnings: z.array(z.string()).default([]),
});
export type ComposedPlan = z.infer<typeof ComposedPlanSchema>;

export const ComposeResponseSchema = z.object({
  plan: ComposedPlanSchema,
});
export type ComposeResponse = z.infer<typeof ComposeResponseSchema>;
