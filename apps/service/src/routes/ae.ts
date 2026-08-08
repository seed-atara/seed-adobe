import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  CaptureFrameRequestSchema,
  ImportAssetRequestSchema,
  SeedError,
  assetKindFromMimeType,
  type AssetDraft,
} from "@seed-ae/domain";
import { resolveStorageUri, toStorageUri } from "@seed-ae/storage";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

export function aeContextRoute(deps: AppDeps) {
  return async () => {
    const context = await deps.aeHost.getActiveContext();
    return json({ context, host: deps.aeHost.id });
  };
}

/**
 * The Milestone 0 vertical slice: ask the host for the visible frame, write it
 * into the workspace, and register it as an immutable source asset carrying
 * its AE provenance.
 */
export function captureFrameRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(CaptureFrameRequestSchema, body ?? {});

    const captured = await deps.aeHost.captureCurrentFrame({
      format: request.format,
      includeAlpha: request.includeAlpha,
      outputDir: deps.workspace.originalsDir,
    });

    const stats = await stat(captured.path);
    const draft: AssetDraft = {
      kind: assetKindFromMimeType(captured.mimeType),
      filename: path.basename(captured.path),
      mimeType: captured.mimeType,
      storageUri: toStorageUri(deps.workspace, captured.path),
      byteSize: stats.size,
      ...(captured.width !== undefined ? { width: captured.width } : {}),
      ...(captured.height !== undefined ? { height: captured.height } : {}),
      source: {
        type: "after-effects",
        context: captured.sourceContext,
        captureFormat: request.format,
        includesAlpha: request.includeAlpha,
      },
    };

    const asset = deps.assets.create(draft);
    const bytes = await readFile(captured.path);
    const thumbnailUri = await deps.ingestor.writeThumbnail(bytes, asset.id);
    const registered = thumbnailUri
      ? deps.assets.setThumbnail(asset.id, thumbnailUri)
      : asset;

    deps.logger.info("ae.frame.captured", {
      assetId: asset.id,
      host: deps.aeHost.id,
      compName: captured.sourceContext.compName,
      frameNumber: captured.sourceContext.frameNumber,
      byteSize: stats.size,
    });

    return json({ asset: registered }, 201);
  };
}

/**
 * Puts a SEED asset back into the AE project, optionally on the timeline at the
 * playhead. This is the step that makes generation part of the edit rather than
 * a folder of downloads.
 */
export function importAssetRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(ImportAssetRequestSchema, body);
    const asset = deps.assets.requireById(request.assetId);

    const absolutePath = resolveStorageUri(deps.workspace, asset.storageUri);
    const exists = await stat(absolutePath).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!exists) {
      deps.assets.updateStatus(asset.id, "missing");
      throw new SeedError("not_found", `media for asset ${asset.id} is missing`);
    }

    const imported = await deps.aeHost.importMedia(absolutePath, {
      ...(request.folder ? { folder: request.folder } : {}),
    });

    let insertedAtPlayhead = false;
    if (request.insertAtPlayhead) {
      if (!deps.aeHost.insertAtPlayhead) {
        throw new SeedError(
          "unsupported_capability",
          `AE host "${deps.aeHost.id}" cannot insert at the playhead`,
        );
      }
      if (!imported.projectItemId) {
        throw new SeedError(
          "host_error",
          "the host imported the media but returned no project item id",
        );
      }
      await deps.aeHost.insertAtPlayhead(imported.projectItemId);
      insertedAtPlayhead = true;
    }

    deps.logger.info("ae.asset.imported", {
      assetId: asset.id,
      host: deps.aeHost.id,
      insertedAtPlayhead,
    });

    return json({
      ...(imported.projectItemId ? { projectItemId: imported.projectItemId } : {}),
      name: imported.name,
      insertedAtPlayhead,
    });
  };
}
