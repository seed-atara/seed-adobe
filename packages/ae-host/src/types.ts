import type { AeContext, CapturedMedia } from "@seed-ae/domain";

export interface CaptureOptions {
  format?: "png" | "exr";
  includeAlpha?: boolean;
  /** Directory the host should write the rendered frame into. */
  outputDir?: string;
}

export interface ImportOptions {
  /** Project folder name to place the imported item in, when supported. */
  folder?: string;
}

export interface AeImportResult {
  projectItemId?: string;
  name: string;
}

export interface InsertOptions {
  trackAboveSelected?: boolean;
}

/**
 * The single boundary between SEED and After Effects. No Adobe scripting
 * object may escape an implementation of this interface, and no provider
 * networking may enter one.
 */
export interface AeHostAdapter {
  /** Identifies the implementation (`mock`, `cep`, `uxp`, ...). */
  readonly id: string;
  getActiveContext(): Promise<AeContext>;
  captureCurrentFrame(options?: CaptureOptions): Promise<CapturedMedia>;
  captureSelectedLayer?(options?: CaptureOptions): Promise<CapturedMedia>;
  importMedia(path: string, options?: ImportOptions): Promise<AeImportResult>;
  insertAtPlayhead?(
    projectItemId: string,
    options?: InsertOptions,
  ): Promise<void>;
}
