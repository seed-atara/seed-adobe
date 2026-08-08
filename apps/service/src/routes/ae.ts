import { stat } from "node:fs/promises";
import path from "node:path";
import {
  CaptureFrameRequestSchema,
  assetKindFromMimeType,
  type AssetDraft,
} from "@seed-ae/domain";
import { toStorageUri } from "@seed-ae/storage";
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
    deps.logger.info("ae.frame.captured", {
      assetId: asset.id,
      host: deps.aeHost.id,
      compName: captured.sourceContext.compName,
      frameNumber: captured.sourceContext.frameNumber,
      byteSize: stats.size,
    });

    return json({ asset }, 201);
  };
}
