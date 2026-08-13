import { readFile } from "node:fs/promises";
import { SeedError, type Asset } from "@seed-ae/domain";
import { resolveStorageUri, type WorkspaceLayout } from "@seed-ae/storage";
import type { MaterializedInput, PublicUrlPublisher } from "@seed-ae/providers";

/** Guard against sending an enormous frame to a provider by accident. */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

/**
 * The same guard for media that is hosted rather than inlined.
 *
 * Higher because nothing is being base64-encoded into a request body, and
 * still a limit because Ark's own ceiling for a reference video is not
 * documented anywhere and an accidental 4GB plate should fail here rather than
 * after a long upload.
 */
export const MAX_HOSTED_INPUT_BYTES = 256 * 1024 * 1024;

export type MaterializeKind = "base64" | "dataUrl" | "url";

export interface MaterializeOptions {
  /**
   * Send video as a fetchable URL instead of inline.
   *
   * Ark refuses an inline video outright — `reference_video must be provided as
   * a web url` — while accepting images as data URLs, so this is per-kind
   * rather than per-request. See docs/research/MODEL_API_NOTES.md.
   */
  hostVideo?: boolean;
}

/**
 * Turns a local asset into something a provider will accept.
 *
 * This exists because AE renders to the local filesystem while provider APIs
 * take URLs or inline data — a local path is never a valid provider input.
 * Where a provider will not take bytes at all, the publisher puts them
 * somewhere it can fetch from and hands back a short-lived link.
 */
export class InputMaterializer {
  constructor(
    private readonly workspace: WorkspaceLayout,
    private readonly publisher?: PublicUrlPublisher,
  ) {}

  /** Whether hosted (`url`) materialization is available at all. */
  get canHost(): boolean {
    return this.publisher !== undefined;
  }

  async materialize(
    asset: Asset,
    kind: MaterializeKind = "base64",
  ): Promise<MaterializedInput> {
    const absolutePath = resolveStorageUri(this.workspace, asset.storageUri);
    const bytes = await readFile(absolutePath).catch((cause: unknown) => {
      throw new SeedError(
        "not_found",
        `media for asset ${asset.id} is missing on disk`,
        { cause },
      );
    });

    const limit = kind === "url" ? MAX_HOSTED_INPUT_BYTES : MAX_INPUT_BYTES;
    if (bytes.length > limit) {
      throw new SeedError(
        "bad_request",
        `asset ${asset.id} is ${bytes.length} bytes, over the ${limit} byte input limit`,
      );
    }

    if (kind === "url") {
      const publisher = this.publisher;
      if (!publisher) {
        throw new SeedError(
          "unsupported_capability",
          `${asset.kind === "video" ? "A video reference" : "This reference"} has to be ` +
            "fetchable over https, and no bucket is configured. Set SEED_R2_ENDPOINT, " +
            "SEED_R2_BUCKET, SEED_R2_ACCESS_KEY_ID and SEED_R2_SECRET_ACCESS_KEY.",
        );
      }
      const published = await publisher.publish({
        bytes,
        filename: asset.filename,
        mimeType: asset.mimeType,
      });
      return {
        kind: "url",
        value: published.url,
        mimeType: asset.mimeType,
        assetId: asset.id,
      };
    }

    const base64 = bytes.toString("base64");
    return kind === "dataUrl"
      ? {
          kind: "dataUrl",
          value: `data:${asset.mimeType};base64,${base64}`,
          mimeType: asset.mimeType,
          assetId: asset.id,
        }
      : { kind: "base64", value: base64, mimeType: asset.mimeType, assetId: asset.id };
  }

  async materializeAll(
    assets: Asset[],
    kind: MaterializeKind = "base64",
    options: MaterializeOptions = {},
  ): Promise<MaterializedInput[]> {
    return Promise.all(
      assets.map((asset) =>
        this.materialize(asset, this.kindFor(asset, kind, options)),
      ),
    );
  }

  private kindFor(
    asset: Asset,
    kind: MaterializeKind,
    options: MaterializeOptions,
  ): MaterializeKind {
    if (options.hostVideo && asset.kind === "video") return "url";
    return kind;
  }
}
