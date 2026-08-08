import { z } from "zod";
import { AssetDraftSchema, AssetSchema } from "./asset.js";
import { AeContextSchema } from "./ae.js";

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

export const ErrorResponseSchema = z.object({
  error: z.object({
    /** Stable machine-readable class, safe to branch on in the panel. */
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
