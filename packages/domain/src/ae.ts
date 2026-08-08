import { z } from "zod";

/**
 * Context describing what After Effects was showing when something was captured.
 *
 * Every field beyond `compName` is optional on purpose: AE object ids are not
 * guaranteed stable across project edits, and some hosts/routes cannot report
 * colour space or work area. Provenance degrades gracefully rather than
 * blocking a capture.
 */
export const AeLayerRefSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
});

export const AeContextSchema = z.object({
  projectName: z.string().optional(),
  projectPath: z.string().optional(),
  /** Hash of the project path/name, used when the .aep itself may move. */
  projectFingerprint: z.string().optional(),
  compName: z.string().optional(),
  compId: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  timeSeconds: z.number().min(0).optional(),
  frameNumber: z.number().int().min(0).optional(),
  durationSeconds: z.number().min(0).optional(),
  workAreaStartSeconds: z.number().min(0).optional(),
  workAreaDurationSeconds: z.number().min(0).optional(),
  colorSpace: z.string().optional(),
  selectedLayers: z.array(AeLayerRefSchema).optional(),
});

export type AeLayerRef = z.infer<typeof AeLayerRefSchema>;
export type AeContext = z.infer<typeof AeContextSchema>;

export const CapturedMediaSchema = z.object({
  path: z.string().min(1),
  mimeType: z.string().min(1),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  sourceContext: AeContextSchema,
});

export type CapturedMedia = z.infer<typeof CapturedMediaSchema>;
