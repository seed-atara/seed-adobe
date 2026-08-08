import { readFile } from "node:fs/promises";
import { SeedError, type Asset } from "@seed-ae/domain";
import { resolveStorageUri, type WorkspaceLayout } from "@seed-ae/storage";
import type { MaterializedInput } from "@seed-ae/providers";

/** Guard against sending an enormous frame to a provider by accident. */
export const MAX_INPUT_BYTES = 32 * 1024 * 1024;

export type MaterializeKind = "base64" | "dataUrl";

/**
 * Turns a local asset into something a provider will accept.
 *
 * This exists because AE renders to the local filesystem while provider APIs
 * take URLs or inline data — a local path is never a valid provider input. When
 * object storage is added, a third `url` strategy joins this class and nothing
 * else has to change.
 */
export class InputMaterializer {
  constructor(private readonly workspace: WorkspaceLayout) {}

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

    if (bytes.length > MAX_INPUT_BYTES) {
      throw new SeedError(
        "bad_request",
        `asset ${asset.id} is ${bytes.length} bytes, over the ${MAX_INPUT_BYTES} byte input limit`,
      );
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
  ): Promise<MaterializedInput[]> {
    return Promise.all(assets.map((asset) => this.materialize(asset, kind)));
  }
}
