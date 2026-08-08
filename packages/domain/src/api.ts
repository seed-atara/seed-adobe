import { z } from "zod";
import { AssetDraftSchema, AssetSchema } from "./asset.js";
import { AeContextSchema } from "./ae.js";
import { GenerationOperationSchema, GenerationSchema, JobStatusSchema } from "./generation.js";

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
  aspectRatio: z.string().optional(),
  /** Reference assets, in order. The first is the edit subject for image.edit. */
  inputAssetIds: z.array(z.string()).max(8).default([]),
  /** Set when this generation descends from an existing asset/recipe. */
  parentAssetId: z.string().optional(),
  parentGenerationId: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
});
export type StartGenerationRequest = z.infer<typeof StartGenerationRequestSchema>;

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
