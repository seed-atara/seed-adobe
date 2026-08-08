import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SeedError,
  assetKindFromMimeType,
  type Asset,
  type AssetDraft,
} from "@seed-ae/domain";
import { decodePng, encodePng, fitWithin, readPngSize } from "@seed-ae/media";
import type { ProviderOutput } from "@seed-ae/providers";
import { toStorageUri, type AssetRepository, type WorkspaceLayout } from "@seed-ae/storage";

/** Refuse absurd downloads rather than filling the user's disk. */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
export const THUMBNAIL_MAX_EDGE = 512;

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/wav": ".wav",
  "audio/mpeg": ".mp3",
};

export interface IngestOptions {
  generationId: string;
  provider: string;
  model: string;
  /** Index within a multi-output generation, used for stable filenames. */
  index: number;
  fetchImpl?: typeof fetch;
}

/**
 * Takes a provider result and turns it into durable local media plus a
 * registered asset. Retries never overwrite an earlier result: each ingest
 * writes a new file.
 */
export class MediaIngestor {
  constructor(
    private readonly workspace: WorkspaceLayout,
    private readonly assets: AssetRepository,
  ) {}

  async ingest(output: ProviderOutput, options: IngestOptions): Promise<Asset> {
    const bytes = await this.readOutput(output, options.fetchImpl ?? fetch);

    if (bytes.length === 0) {
      throw new SeedError("provider_error", "provider returned an empty result");
    }
    if (bytes.length > MAX_OUTPUT_BYTES) {
      throw new SeedError(
        "provider_error",
        `provider result is ${bytes.length} bytes, over the ${MAX_OUTPUT_BYTES} byte limit`,
      );
    }

    const mimeType = output.mimeType || "application/octet-stream";
    const filename = buildFilename(options, mimeType);
    const target = path.join(this.workspace.generatedDir, filename);
    await writeFile(target, bytes, { flag: "wx" }).catch((cause: unknown) => {
      throw new SeedError("storage_error", `could not write ${filename}`, { cause });
    });

    const probed = readPngSize(bytes);
    const draft: AssetDraft = {
      kind: assetKindFromMimeType(mimeType),
      filename,
      mimeType,
      storageUri: toStorageUri(this.workspace, target),
      byteSize: bytes.length,
      generationId: options.generationId,
      source: {
        type: "generated",
        provider: options.provider,
        model: options.model,
        ...(output.url ? { sourceUrl: output.url } : {}),
      },
    };

    const width = output.width ?? probed?.width;
    const height = output.height ?? probed?.height;
    if (width !== undefined) draft.width = width;
    if (height !== undefined) draft.height = height;

    const asset = this.assets.create(draft);
    const thumbnailUri = await this.writeThumbnail(bytes, asset.id);
    return thumbnailUri ? this.assets.setThumbnail(asset.id, thumbnailUri) : asset;
  }

  /**
   * Generates a thumbnail when the bytes are a PNG we can decode. Failure is
   * not fatal — a missing thumbnail costs a nicer grid, not the asset.
   */
  async writeThumbnail(bytes: Buffer, assetId: string): Promise<string | undefined> {
    const decoded = decodePng(bytes);
    if (!decoded) return undefined;

    try {
      const small = fitWithin(decoded, THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
      const target = path.join(this.workspace.thumbnailsDir, `${assetId}.png`);
      await writeFile(target, encodePng(small.width, small.height, small.rgba));
      return toStorageUri(this.workspace, target);
    } catch {
      return undefined;
    }
  }

  private async readOutput(
    output: ProviderOutput,
    fetchImpl: typeof fetch,
  ): Promise<Buffer> {
    if (output.base64) return Buffer.from(output.base64, "base64");
    if (!output.url) {
      throw new SeedError("provider_error", "provider result had no url or data");
    }

    let url: URL;
    try {
      url = new URL(output.url);
    } catch (cause) {
      throw new SeedError("provider_error", "provider returned an invalid URL", {
        cause,
      });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new SeedError(
        "provider_error",
        `refusing to download from ${url.protocol}`,
      );
    }

    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok) {
      throw new SeedError(
        "provider_error",
        `downloading the result failed with HTTP ${response.status}`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

/**
 * Filenames are built from ids we control, never from provider-supplied names —
 * a provider filename is untrusted input on a path.
 */
function buildFilename(options: IngestOptions, mimeType: string): string {
  const extension = EXTENSIONS[mimeType] ?? ".bin";
  const shortId = options.generationId.replace(/^gen_/, "").slice(0, 8);
  const stamp = String(options.index).padStart(2, "0");
  return `${options.provider}_${shortId}_${stamp}${extension}`;
}
