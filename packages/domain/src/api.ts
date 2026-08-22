import { z } from "zod";
import { AssetDraftSchema, AssetSchema } from "./asset.js";
import { AeContextSchema } from "./ae.js";
import { GenerationOperationSchema, GenerationSchema, JobStatusSchema } from "./generation.js";
import {
  ItemAuthorisationSchema,
  ItemDetailSchema,
  ItemKindSchema,
  ItemLookBindingSchema,
  ItemMentionSchema,
  ItemPlateSchema,
  ItemSchema,
  ItemTraitSchema,
  ItemVariantSchema,
  PlateRoleSchema,
  PlateShotSchema,
  ResolvedBundleSchema,
} from "./item.js";

/**
 * Wire contracts shared by the panel and the local service. Both sides parse
 * with the same schema so a drift shows up as a validation error rather than
 * an undefined field three layers deep.
 */

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.literal("seed-ae"),
  version: z.string(),
  uptimeSeconds: z.number().min(0),
  database: z.object({
    path: z.string(),
    schemaVersion: z.number().int().min(0),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const RegisterAssetRequestSchema = AssetDraftSchema;
export type RegisterAssetRequest = z.infer<typeof RegisterAssetRequestSchema>;

export const AssetResponseSchema = z.object({ asset: AssetSchema });
export type AssetResponse = z.infer<typeof AssetResponseSchema>;

export const ListAssetsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  kind: z.enum(["image", "video", "audio", "other"]).optional(),
  /** Narrows a shared library to one host project. */
  project: z.string().min(1).optional(),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuerySchema>;

export const ListAssetsResponseSchema = z.object({
  assets: z.array(AssetSchema),
  total: z.number().int().min(0),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type ListAssetsResponse = z.infer<typeof ListAssetsResponseSchema>;

export const AeContextResponseSchema = z.object({
  context: AeContextSchema,
  /** Which host adapter answered — `mock` until a real AE route is verified. */
  host: z.string(),
});
export type AeContextResponse = z.infer<typeof AeContextResponseSchema>;

export const CaptureFrameRequestSchema = z.object({
  format: z.enum(["png", "exr"]).default("png"),
  includeAlpha: z.boolean().default(false),
});
export type CaptureFrameRequest = z.infer<typeof CaptureFrameRequestSchema>;

export const StartGenerationRequestSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  operation: GenerationOperationSchema,
  prompt: z.string().min(1).max(8000),
  seed: z.union([z.number().int(), z.string()]).optional(),
  size: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  /** Video soundtrack. Off unless asked for. */
  generateAudio: z.boolean().optional(),
  aspectRatio: z.string().optional(),
  /**
   * Reference assets, in order. The first is the edit subject for image.edit.
   *
   * The ceiling is the most any configured provider accepts, not a judgement
   * about what is useful — Seedance takes many, and each provider's own
   * capabilities narrow it further.
   */
  inputAssetIds: z.array(z.string()).max(30).default([]),
  /**
   * What each input is for, positionally matched to inputAssetIds.
   *
   * Providers distinguish anchoring a shot to a frame from drawing on a
   * reference, and they are mutually exclusive modes rather than degrees of the
   * same thing. Without this the service can only guess from the count, which
   * makes an end frame impossible to ask for.
   */
  /**
   * `loop` puts one still in *both* frame slots, so the shot ends where it
   * began — the seamless cycle a motion graphic wants. Ark has a mode of its
   * own for it (`flf2v`) and accepts the same image twice, measured
   * 2026-08-17; two *first* frames is refused by count, which is what makes
   * this a role rather than a duplicated reference.
   */
  inputRoles: z
    .array(z.enum(["first", "last", "reference", "loop"]))
    .max(30)
    .optional(),
  /**
   * `@item` mentions in the prompt, resolved by the panel to ids.
   *
   * The service expands these itself rather than trusting an expansion sent to
   * it: the resolved bundle is the reproducibility record, and a panel that
   * built its own would be a second implementation of the rules that matter
   * most, drifting against the one that gets persisted.
   */
  itemMentions: z.array(ItemMentionSchema).max(12).default([]),
  /** Spend past the provider's stable reference range, knowingly. */
  allowBeyondStable: z.boolean().optional(),
  /**
   * The host project open when this was started.
   *
   * A result takes its project from its references, which is right when there
   * are any. Text-to-video has none, so the output landed with no project at
   * all and the library — which filters with `project = ?`, and SQL never
   * matches NULL — hid it completely. Two finished clips, paid for, invisible.
   *
   * Only a fallback: inheritance still wins where it applies, because a
   * result belongs with the plates it was made from.
   */
  project: z.string().min(1).optional(),
  /** Set when this generation descends from an existing asset/recipe. */
  parentAssetId: z.string().optional(),
  parentGenerationId: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type StartGenerationRequest = z.infer<typeof StartGenerationRequestSchema>;

/* ------------------------------------------------------------------ *
 * Items
 * ------------------------------------------------------------------ */

export const CreateItemRequestSchema = z.object({
  handle: z.string().min(1).max(48),
  kind: ItemKindSchema,
  name: z.string().min(1).max(120),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  project: z.string().min(1).optional(),
  realPerson: z.boolean().default(false),
});
export type CreateItemRequest = z.infer<typeof CreateItemRequestSchema>;

export const UpdateItemRequestSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  kind: ItemKindSchema.optional(),
  project: z.string().min(1).optional(),
  realPerson: z.boolean().optional(),
  authorisation: ItemAuthorisationSchema.optional(),
});
export type UpdateItemRequest = z.infer<typeof UpdateItemRequestSchema>;

export const RenameItemRequestSchema = z.object({
  handle: z.string().min(1).max(48),
});
export type RenameItemRequest = z.infer<typeof RenameItemRequestSchema>;

export const CreateVariantRequestSchema = z.object({
  slug: z.string().min(1).max(48),
  name: z.string().min(1).max(120),
  parentVariantId: z.string().optional(),
});
export type CreateVariantRequest = z.infer<typeof CreateVariantRequestSchema>;

/** A new revision. Never an edit — the previous one stays exactly as it was. */
export const AddRevisionRequestSchema = z.object({
  variantId: z.string().min(1).optional(),
  message: z.string().max(500).optional(),
  traits: z.array(ItemTraitSchema).max(40).optional(),
  avoid: z.array(z.string().min(1).max(120)).max(20).optional(),
  plates: z.array(ItemPlateSchema).max(40).optional(),
  attributes: z.record(z.string(), z.string()).optional(),
  seedHint: z.number().int().optional(),
  look: ItemLookBindingSchema.optional(),
});
export type AddRevisionRequest = z.infer<typeof AddRevisionRequestSchema>;

/**
 * Make an item out of assets already in the library.
 *
 * The commonest way an item is really born: the artist has just captured the
 * frame that made them want the character.
 */
export const AdoptItemRequestSchema = z.object({
  handle: z.string().min(1).max(48),
  kind: ItemKindSchema,
  name: z.string().min(1).max(120),
  project: z.string().min(1).optional(),
  realPerson: z.boolean().default(false),
  plates: z
    .array(
      z.object({
        assetId: z.string().min(1),
        role: PlateRoleSchema.default("reference"),
        notes: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(40),
  traits: z.array(ItemTraitSchema).max(40).default([]),
});
export type AdoptItemRequest = z.infer<typeof AdoptItemRequestSchema>;

/**
 * Ask a model to read an item's plates and propose what to write down.
 *
 * A proposal, never an application — the artist edits it before anything is
 * saved. See ADR 0007.
 */
export const DescribeItemRequestSchema = z.object({
  kind: ItemKindSchema,
  name: z.string().max(120).optional(),
  plates: z
    .array(
      z.object({
        assetId: z.string().min(1),
        role: PlateRoleSchema.default("reference"),
      }),
    )
    .min(1)
    .max(12),
});
export type DescribeItemRequest = z.infer<typeof DescribeItemRequestSchema>;

export const DescribeItemResponseSchema = z.object({
  /**
   * What each plate turned out to show, in the order they were sent.
   *
   * Reading the plates is the only moment anything knows this, and it is the
   * whole input to sending the profile close-up to a profile close-up.
   */
  plates: z.array(PlateShotSchema).optional(),
  traits: z.array(ItemTraitSchema),
  avoid: z.array(z.string()),
  /** One sentence for the artist, including any disagreement between plates. */
  summary: z.string(),
});
export type DescribeItemResponse = z.infer<typeof DescribeItemResponseSchema>;

export const ItemResponseSchema = z.object({ item: ItemDetailSchema });
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

export const ListItemsQuerySchema = z.object({
  kind: ItemKindSchema.optional(),
  project: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListItemsQuery = z.infer<typeof ListItemsQuerySchema>;

export const ListItemsResponseSchema = z.object({
  items: z.array(ItemSchema),
  total: z.number().int().min(0),
});
export type ListItemsResponse = z.infer<typeof ListItemsResponseSchema>;

export const VariantResponseSchema = z.object({ variant: ItemVariantSchema });
export type VariantResponse = z.infer<typeof VariantResponseSchema>;

/**
 * What a prompt would actually send, without sending it.
 *
 * The panel draws its prompt preview from this, and `scripts/item.ts resolve`
 * prints it. When a shot comes back wrong this is the first thing to look at,
 * and it costs nothing.
 */
export const ResolvePromptRequestSchema = z.object({
  prompt: z.string().max(8000),
  providerId: z.string().min(1),
  itemMentions: z.array(ItemMentionSchema).max(12).default([]),
  attachedAssetIds: z.array(z.string()).max(30).default([]),
  attachedRoles: z.array(z.enum(["first", "last", "reference"])).max(30).optional(),
  allowBeyondStable: z.boolean().optional(),
});
export type ResolvePromptRequest = z.infer<typeof ResolvePromptRequestSchema>;

export const ResolvePromptResponseSchema = z.object({
  bundle: ResolvedBundleSchema,
});
export type ResolvePromptResponse = z.infer<typeof ResolvePromptResponseSchema>;

export const JobSchema = z.object({
  id: z.string(),
  kind: z.literal("generation"),
  provider: z.string(),
  model: z.string(),
  operation: GenerationOperationSchema,
  providerJobId: z.string().optional(),
  status: JobStatusSchema,
  progress: z.number().optional(),
  generationId: z.string().optional(),
  correlationId: z.string(),
  attempts: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  errorClass: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type JobDto = z.infer<typeof JobSchema>;

export const JobResponseSchema = z.object({
  job: JobSchema,
  generation: GenerationSchema.optional(),
  outputs: z.array(AssetSchema).default([]),
});
export type JobResponse = z.infer<typeof JobResponseSchema>;

export const LineageResponseSchema = z.object({
  rootAssetId: z.string(),
  assets: z.array(AssetSchema),
  generations: z.array(GenerationSchema),
  edges: z.array(
    z.object({
      fromAssetId: z.string(),
      toAssetId: z.string(),
      generationId: z.string(),
    }),
  ),
});
export type LineageResponse = z.infer<typeof LineageResponseSchema>;

export const ImportAssetRequestSchema = z.object({
  assetId: z.string().min(1),
  /** Also place it on the timeline at the current playhead. */
  insertAtPlayhead: z.boolean().default(false),
  folder: z.string().optional(),
});
export type ImportAssetRequest = z.infer<typeof ImportAssetRequestSchema>;

export const ImportAssetResponseSchema = z.object({
  projectItemId: z.string().optional(),
  name: z.string(),
  insertedAtPlayhead: z.boolean(),
});
export type ImportAssetResponse = z.infer<typeof ImportAssetResponseSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    /** Stable machine-readable class, safe to branch on in the panel. */
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
