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

/** A square of a larger comp, as a region guide currently defines it. */
export const AeRegionRefSchema = z.object({
  name: z.string(),
  centerX: z.number(),
  centerY: z.number(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type AeRegionRef = z.infer<typeof AeRegionRefSchema>;

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
  /**
   * How the host was managing colour when this frame was made.
   *
   * Recorded because a treatment chain has to know what it is being handed.
   * The film look assumes sRGB-encoded 0..1; run it against a linearised
   * 32-bit project and the result is double-gamma, which reads as "too
   * contrasty" and gets corrected with a grade that makes it worse. Recording
   * this at capture time is the only chance to know — the PNG itself cannot
   * say which working space produced it.
   *
   * Every field stays optional: Premiere does not expose an equivalent, and
   * older After Effects builds lack some of these. Absent means unknown, which
   * is a different claim from sRGB and must not be collapsed into it.
   */
  colorSpace: z.string().optional(),
  colorManagement: z
    .object({
      /** 8, 16 or 32. The optical half of a look is meaningless below 32. */
      bitsPerChannel: z.union([z.literal(8), z.literal(16), z.literal(32)]).optional(),
      /** Project working space profile name; empty string in AE means None. */
      workingSpace: z.string().optional(),
      /** 2.2 or 2.4 when a working space is set. */
      workingGamma: z.number().positive().optional(),
      linearBlending: z.boolean().optional(),
      linearizeWorkingSpace: z.boolean().optional(),
      compensateForSceneReferredProfiles: z.boolean().optional(),
    })
    .optional(),
  selectedLayers: z.array(AeLayerRefSchema).optional(),
  /**
   * Which part of a larger plate a region capture came from, in comp pixels.
   *
   * Without this the crop cannot be put back where it belongs, and a library
   * full of squares says nothing about where any of them came from.
   */
  region: AeRegionRefSchema.optional(),
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
