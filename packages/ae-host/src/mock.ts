import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SeedError, type AeContext, type CapturedMedia } from "@seed-ae/domain";
import { encodePng } from "./png.js";
import type {
  AeHostAdapter,
  AeImportResult,
  CaptureOptions,
  ImportOptions,
  InsertOptions,
} from "./types.js";

export interface MockAeHostOptions {
  /** Where captured frames are written. */
  outputDir: string;
  /** Overrides for the fake comp context. */
  context?: Partial<AeContext>;
}

const DEFAULT_CONTEXT: AeContext = {
  projectName: "Mock Project.aep",
  projectPath: "C:/Mock Projects/Mock Project.aep",
  projectFingerprint: "mock-project-fingerprint",
  compName: "HERO_SHOT_v003",
  compId: "mock-comp-1",
  width: 1920,
  height: 1080,
  fps: 24,
  timeSeconds: 2.5,
  frameNumber: 60,
  durationSeconds: 10,
  colorSpace: "sRGB IEC61966-2.1",
  selectedLayers: [{ id: "mock-layer-3", name: "HERO_PLATE" }],
};

/**
 * Dev/test implementation of the AE host contract. It renders a deterministic
 * gradient frame so the capture → register → library loop can be exercised and
 * tested with no Adobe application installed.
 */
export class MockAeHostAdapter implements AeHostAdapter {
  readonly id = "mock";

  private readonly outputDir: string;
  private context: AeContext;
  private captureCount = 0;

  readonly importedMedia: Array<{ path: string; options?: ImportOptions }> = [];
  readonly insertions: Array<{
    projectItemId: string;
    options?: InsertOptions;
  }> = [];

  constructor(options: MockAeHostOptions) {
    this.outputDir = options.outputDir;
    this.context = { ...DEFAULT_CONTEXT, ...options.context };
  }

  /** Test helper: move the fake playhead. */
  setContext(context: Partial<AeContext>): void {
    this.context = { ...this.context, ...context };
  }

  async getActiveContext(): Promise<AeContext> {
    return { ...this.context };
  }

  async captureCurrentFrame(
    options: CaptureOptions = {},
  ): Promise<CapturedMedia> {
    if (options.format === "exr") {
      throw new SeedError(
        "unsupported_capability",
        "the mock AE host renders PNG only",
      );
    }

    const width = this.context.width ?? 1920;
    const height = this.context.height ?? 1080;
    const frameNumber = this.context.frameNumber ?? 0;
    const includeAlpha = options.includeAlpha ?? false;

    const pixels = renderGradient(width, height, frameNumber, includeAlpha);
    const dir = options.outputDir ?? this.outputDir;
    await mkdir(dir, { recursive: true });

    // Never overwrite a previous capture: each one is an immutable source.
    this.captureCount += 1;
    const filename = `${sanitize(this.context.compName ?? "comp")}_f${String(
      frameNumber,
    ).padStart(5, "0")}_${String(this.captureCount).padStart(3, "0")}.png`;
    const target = path.join(dir, filename);
    await writeFile(target, encodePng(width, height, pixels));

    return {
      path: target,
      mimeType: "image/png",
      width,
      height,
      sourceContext: { ...this.context },
    };
  }

  async importMedia(
    mediaPath: string,
    options?: ImportOptions,
  ): Promise<AeImportResult> {
    this.importedMedia.push({ path: mediaPath, ...(options ? { options } : {}) });
    return {
      projectItemId: `mock-item-${this.importedMedia.length}`,
      name: path.basename(mediaPath),
    };
  }

  async insertAtPlayhead(
    projectItemId: string,
    options?: InsertOptions,
  ): Promise<void> {
    this.insertions.push({ projectItemId, ...(options ? { options } : {}) });
  }
}

/** Frame-dependent gradient so consecutive captures are visibly different. */
function renderGradient(
  width: number,
  height: number,
  frameNumber: number,
  includeAlpha: boolean,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const phase = (frameNumber % 120) / 120;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = Math.round(255 * ((x / width + phase) % 1));
      pixels[i + 1] = Math.round(255 * (y / height));
      pixels[i + 2] = Math.round(255 * phase);
      pixels[i + 3] = includeAlpha
        ? Math.round(255 * (1 - y / height))
        : 255;
    }
  }
  return pixels;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64) || "comp";
}
