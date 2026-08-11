import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SeedError,
  assetKindFromMimeType,
  type Asset,
  type AssetDraft,
} from "@seed-ae/domain";
import {
  decodeJpegPreview,
  decodePng,
  encodePng,
  fitWithin,
  readPngSize,
  sniffMimeType,
  readMp4Size,
} from "@seed-ae/media";
import type { ProviderOutput } from "@seed-ae/providers";
import {
  resolveStorageUri,
  toStorageUri,
  type AssetRepository,
  type WorkspaceLayout,
} from "@seed-ae/storage";

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
    /** Optional so tests can construct one bare. */
    private readonly onThumbnailFailure?: (reason: string, assetId: string) => void,
  ) {}

  async ingest(output: ProviderOutput, options: IngestOptions): Promise<Asset> {
    const downloaded = await this.readOutput(output, options.fetchImpl ?? fetch);
    const bytes = downloaded.bytes;

    if (bytes.length === 0) {
      throw new SeedError("provider_error", "provider returned an empty result");
    }
    if (bytes.length > MAX_OUTPUT_BYTES) {
      throw new SeedError(
        "provider_error",
        `provider result is ${bytes.length} bytes, over the ${MAX_OUTPUT_BYTES} byte limit`,
      );
    }

    // The bytes win. Ark's image endpoint returns JPEG through a response that
    // says nothing about format, so a provider-declared type is only a hint —
    // trusting it wrote `.png` files full of JPEG.
    const mimeType =
      sniffMimeType(bytes) ??
      concreteType(downloaded.contentType) ??
      concreteType(output.mimeType) ??
      "application/octet-stream";
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

    /*
     * A video's size is read from its sample description — plain 16-bit fields,
     * no decoder involved. Without it a generated clip is registered with no
     * dimensions, and anything placing it on a timeline has to guess its scale.
     * That guess is what left filled placeholders at the wrong size.
     */
    const video = mimeType.startsWith("video/") ? readMp4Size(bytes) : undefined;

    const width = output.width ?? probed?.width ?? video?.width;
    const height = output.height ?? probed?.height ?? video?.height;
    if (width !== undefined) draft.width = width;
    if (height !== undefined) draft.height = height;
    if (video?.durationSeconds !== undefined) {
      draft.durationSeconds = video.durationSeconds;
    }

    const asset = this.assets.create(draft);
    const thumbnailUri = await this.writeThumbnail(bytes, asset.id);
    return thumbnailUri ? this.assets.setThumbnail(asset.id, thumbnailUri) : asset;
  }

  /**
   * Generates a thumbnail from whatever we can decode. Failure is not fatal —
   * a missing thumbnail costs a nicer grid, not the asset.
   */
  async writeThumbnail(bytes: Buffer, assetId: string): Promise<string | undefined> {
    // JPEG comes back at 1/8 scale already, which is thumbnail-sized.
    const decoded = decodePng(bytes) ?? decodeJpegPreview(bytes);
    if (!decoded) {
      // Not fatal, but say so: a silent failure looks like a broken panel.
      this.onThumbnailFailure?.("no decoder for these bytes", assetId);
      return undefined;
    }

    try {
      const small = fitWithin(decoded, THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE);
      const target = path.join(this.workspace.thumbnailsDir, `${assetId}.png`);
      await writeFile(target, encodePng(small.width, small.height, small.rgba));
      return toStorageUri(this.workspace, target);
    } catch (cause) {
      this.onThumbnailFailure?.(
        cause instanceof Error ? cause.message : String(cause),
        assetId,
      );
      return undefined;
    }
  }

  /**
   * Gives a video the thumbnail of the frame it was generated from.
   *
   * There is no video decoder here, so a generated clip would otherwise sit in
   * the library as a grey box. For image-to-video the reference *is* the first
   * frame, so its thumbnail is an honest poster rather than a stand-in — and
   * the lineage already records where it came from.
   */
  async adoptPoster(videoAssetId: string, sourceAssetId: string): Promise<boolean> {
    const source = this.assets.getById(sourceAssetId);
    if (!source?.thumbnailUri) return false;

    try {
      const from = resolveStorageUri(this.workspace, source.thumbnailUri);
      const to = path.join(this.workspace.thumbnailsDir, `${videoAssetId}.png`);
      await copyFile(from, to);
      this.assets.setThumbnail(videoAssetId, toStorageUri(this.workspace, to));
      return true;
    } catch (cause) {
      this.onThumbnailFailure?.(
        cause instanceof Error ? cause.message : String(cause),
        videoAssetId,
      );
      return false;
    }
  }

  /**
   * Fills in thumbnails for assets that never got one — after a crash, or
   * after a decoder gains a format it previously could not read. Failures are
   * per-asset and never abort the sweep.
   */
  async backfillThumbnails(limit = 200): Promise<{ done: number; failed: number }> {
    let done = 0;
    let failed = 0;

    for (const asset of this.assets.listMissingThumbnails(limit)) {
      try {
        const absolute = resolveStorageUri(this.workspace, asset.storageUri);
        const bytes = await readFile(absolute);
        const uri = await this.writeThumbnail(bytes, asset.id);
        if (uri) {
          this.assets.setThumbnail(asset.id, uri);
          done += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }

    return { done, failed };
  }

  private async readOutput(
    output: ProviderOutput,
    fetchImpl: typeof fetch,
  ): Promise<{ bytes: Buffer; contentType?: string }> {
    if (output.base64) {
      return { bytes: Buffer.from(output.base64, "base64") };
    }
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
    const contentType = response.headers.get("content-type") ?? undefined;
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      ...(contentType ? { contentType } : {}),
    };
  }
}

/** Ignores placeholder types so they never beat a real sniff. */
function concreteType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const type = value.split(";")[0]?.trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream") {
    return undefined;
  }
  return type;
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
