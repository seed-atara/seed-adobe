import { z } from "zod";
import { AeContextSchema } from "./ae.js";
import { isIsoTimestamp } from "./time.js";

export const AssetKindSchema = z.enum(["image", "video", "audio", "other"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

/**
 * `registering` covers the window between "we know about this media" and "the
 * bytes are on disk and readable". `missing` means the row survived but the
 * file did not — provenance is never deleted because media went away.
 */
export const AssetStatusSchema = z.enum([
  "registering",
  "ready",
  "missing",
  "failed",
]);
export type AssetStatus = z.infer<typeof AssetStatusSchema>;

const IsoTimestampSchema = z
  .string()
  .refine(isIsoTimestamp, "expected ISO-8601 UTC timestamp");

/** Media rendered out of After Effects. */
export const AeAssetSourceSchema = z.object({
  type: z.literal("after-effects"),
  context: AeContextSchema,
  captureFormat: z.enum(["png", "exr", "jpg", "mov", "mp4", "other"]).optional(),
  includesAlpha: z.boolean().optional(),
  /**
   * The still rendered alongside a captured clip, as a storage URI.
   *
   * Recorded rather than inferred from the filename: nothing here can decode a
   * video, so this is the only honest first frame a clip has, and a thumbnail
   * that failed to be written at registration can be recovered from it later.
   */
  posterUri: z.string().optional(),
});

/** Media the user pointed at on disk. */
export const ImportedAssetSourceSchema = z.object({
  type: z.literal("imported"),
  originalPath: z.string().optional(),
});

/** Media returned by a provider. `generationId` on the asset carries the recipe. */
export const GeneratedAssetSourceSchema = z.object({
  type: z.literal("generated"),
  provider: z.string(),
  model: z.string(),
  sourceUrl: z.string().optional(),
});

export const AssetSourceSchema = z.discriminatedUnion("type", [
  AeAssetSourceSchema,
  ImportedAssetSourceSchema,
  GeneratedAssetSourceSchema,
]);
export type AssetSource = z.infer<typeof AssetSourceSchema>;

export const AssetSchema = z.object({
  id: z.string().min(1),
  kind: AssetKindSchema,
  status: AssetStatusSchema,
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  storageUri: z.string().min(1),
  thumbnailUri: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  fps: z.number().positive().optional(),
  byteSize: z.number().int().min(0).optional(),
  createdAt: IsoTimestampSchema,
  generationId: z.string().optional(),
  /**
   * The host project this belongs to, for filtering a shared library.
   *
   * Captured media knows its own; generated media inherits it from what it was
   * made from. Optional throughout, because plenty of assets have no project
   * at all — a clip adopted from disk before any project was open, anything
   * made outside a host.
   */
  project: z.string().optional(),
  source: AssetSourceSchema,
});

export type Asset = z.infer<typeof AssetSchema>;

/** Fields a caller supplies; the service owns id, status and createdAt. */
export const AssetDraftSchema = AssetSchema.omit({
  id: true,
  status: true,
  createdAt: true,
}).extend({
  status: AssetStatusSchema.optional(),
});

export type AssetDraft = z.infer<typeof AssetDraftSchema>;

const MIME_TO_KIND: Array<[RegExp, AssetKind]> = [
  [/^image\//, "image"],
  [/^video\//, "video"],
  [/^audio\//, "audio"],
];

export function assetKindFromMimeType(mimeType: string): AssetKind {
  for (const [pattern, kind] of MIME_TO_KIND) {
    if (pattern.test(mimeType)) return kind;
  }
  return "other";
}
