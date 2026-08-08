import { z } from "zod";
import { isIsoTimestamp } from "./time.js";

const IsoTimestampSchema = z
  .string()
  .refine(isIsoTimestamp, "expected ISO-8601 UTC timestamp");

/**
 * Operations are normalized names, not provider endpoint names. A provider
 * declares which ones it supports through its capabilities.
 */
export const GenerationOperationSchema = z.enum([
  "image.generate",
  "image.edit",
  "video.generate",
]);
export type GenerationOperation = z.infer<typeof GenerationOperationSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * A generation is the recipe plus the result relationship — never the media
 * itself. Raw provider payloads are kept alongside the normalized record so a
 * generation can be reproduced or debugged after the adapter changes.
 */
export const GenerationSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  operation: GenerationOperationSchema,
  prompt: z.string(),
  seed: z.union([z.number(), z.string()]).optional(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  inputAssetIds: z.array(z.string()).default([]),
  outputAssetIds: z.array(z.string()).default([]),
  parentAssetId: z.string().optional(),
  parentGenerationId: z.string().optional(),
  jobId: z.string().min(1),
  status: JobStatusSchema,
  createdAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.optional(),
  errorClass: z.string().optional(),
  errorMessage: z.string().optional(),
  rawRequest: z.unknown().optional(),
  rawResponse: z.unknown().optional(),
});

export type Generation = z.infer<typeof GenerationSchema>;
