import { readFile } from "node:fs/promises";
import type { Asset } from "@seed-ae/domain";
import { resolveStorageUri, type WorkspaceLayout } from "@seed-ae/storage";

/**
 * Reading a thumbnail for a model to look at.
 *
 * Shared by every agent that shows the artist's own media to a model, because
 * the rules are the same each time and subtly awkward: prefer the thumbnail,
 * never send a video's own bytes as an image, and skip anything unreadable
 * rather than failing the whole request over one missing file.
 */
/** Reads a thumbnail for the model to look at. Missing ones are simply skipped. */
export async function loadPreview(
  workspace: WorkspaceLayout,
  asset: Asset,
): Promise<{ data: string; mediaType: string } | undefined> {
  const uri = asset.thumbnailUri ?? asset.storageUri;
  if (!uri) return undefined;
  // A video's own bytes are not an image; only its poster is worth sending.
  if (!asset.thumbnailUri && asset.kind !== "image") return undefined;

  try {
    const bytes = await readFile(resolveStorageUri(workspace, uri));
    const mediaType = asset.thumbnailUri
      ? "image/png"
      : (asset.mimeType ?? "image/png");
    if (!/^image\/(png|jpeg|gif|webp)$/.test(mediaType)) return undefined;
    return { data: bytes.toString("base64"), mediaType };
  } catch {
    return undefined;
  }
}
