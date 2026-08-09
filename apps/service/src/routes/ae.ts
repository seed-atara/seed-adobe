import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  AeContextSchema,
  CaptureFrameRequestSchema,
  ImportAssetRequestSchema,
  SeedError,
  assetKindFromMimeType,
  type Asset,
  type AssetDraft,
  type CapturedMedia,
} from "@seed-ae/domain";
import { alphaBounds, decodePng, readPngSize } from "@seed-ae/media";
import { resolveStorageUri, toStorageUri } from "@seed-ae/storage";
import { z } from "zod";
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
 * Registers a rendered frame as an immutable source asset carrying its AE
 * provenance. Shared by the service-driven capture and the CEP panel, which
 * renders the frame itself and then hands over the path.
 */
export interface RegisteredCapture {
  asset: Asset;
  /** Set when the frame came back only partly rendered. */
  warning?: string;
}

/**
 * Flags a frame that After Effects only partly rendered.
 *
 * A Region of Interest leaves everything outside it fully transparent, which
 * reads downstream as a broken image — and a model given such a reference will
 * faithfully work from the empty part too. Better to say so at capture time.
 */
function describePartialRender(bytes: Buffer): string | undefined {
  const decoded = decodePng(bytes);
  if (!decoded) return undefined;

  const { box, coverage } = alphaBounds(decoded);
  if (!box) return "The captured frame is fully transparent - nothing rendered.";
  if (coverage > 0.995) return undefined;

  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  return (
    `Only ${Math.round(coverage * 100)}% of this frame was rendered ` +
    `(${width}x${height} at ${box.minX},${box.minY} of ${decoded.width}x${decoded.height}). ` +
    `The rest is transparent - a Region of Interest in the composition viewer ` +
    `is the usual cause.`
  );
}

async function registerCapturedFrame(
  deps: AppDeps,
  captured: CapturedMedia,
  format: "png" | "exr",
  includesAlpha: boolean,
): Promise<RegisteredCapture> {
  const stats = await stat(captured.path);
  const bytes = await readFile(captured.path);
  const probed = readPngSize(bytes);

  const draft: AssetDraft = {
    kind: assetKindFromMimeType(captured.mimeType),
    filename: path.basename(captured.path),
    mimeType: captured.mimeType,
    storageUri: toStorageUri(deps.workspace, captured.path),
    byteSize: stats.size,
    ...(captured.width ?? probed?.width
      ? { width: (captured.width ?? probed?.width) as number }
      : {}),
    ...(captured.height ?? probed?.height
      ? { height: (captured.height ?? probed?.height) as number }
      : {}),
    source: {
      type: "after-effects",
      context: captured.sourceContext,
      captureFormat: format,
      includesAlpha,
    },
  };

  const asset = deps.assets.create(draft);
  const thumbnailUri = await deps.ingestor.writeThumbnail(bytes, asset.id);
  const registered = thumbnailUri
    ? deps.assets.setThumbnail(asset.id, thumbnailUri)
    : asset;

  const warning = describePartialRender(bytes);

  deps.logger.info("ae.frame.captured", {
    assetId: asset.id,
    compName: captured.sourceContext.compName,
    frameNumber: captured.sourceContext.frameNumber,
    byteSize: stats.size,
    ...(warning ? { partialRender: true } : {}),
  });

  return { asset: registered, ...(warning ? { warning } : {}) };
}

/**
 * The Milestone 0 vertical slice: ask the host for the visible frame, write it
 * into the workspace, and register it. Used when the service owns the host
 * adapter (mock, or a future out-of-process bridge).
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

    const registered = await registerCapturedFrame(
      deps,
      captured,
      request.format,
      request.includeAlpha,
    );
    return json(registered, 201);
  };
}

const RegisterCaptureSchema = z.object({
  /** Absolute path the host wrote to; must be inside the workspace. */
  path: z.string().min(1),
  context: AeContextSchema,
  mimeType: z.string().default("image/png"),
  format: z.enum(["png", "exr"]).default("png"),
  includeAlpha: z.boolean().default(false),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

/**
 * Used by the CEP panel: After Effects scripting lives in the panel, so the
 * panel renders the frame and posts the path here for registration. The path
 * is validated against the workspace before anything reads it.
 */
export function registerCaptureRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(RegisterCaptureSchema, body);

    // Round-tripping through the storage URI is the path validation: anything
    // outside the workspace cannot be expressed as one.
    const storageUri = toStorageUri(deps.workspace, request.path);
    const absolutePath = resolveStorageUri(deps.workspace, storageUri);

    const exists = await stat(absolutePath).then(
      (stats) => stats.isFile(),
      () => false,
    );
    if (!exists) {
      throw new SeedError("not_found", `no file at ${request.path}`);
    }

    const captured: CapturedMedia = {
      path: absolutePath,
      mimeType: request.mimeType,
      ...(request.width !== undefined ? { width: request.width } : {}),
      ...(request.height !== undefined ? { height: request.height } : {}),
      sourceContext: request.context,
    };

    const registered = await registerCapturedFrame(
      deps,
      captured,
      request.format,
      request.includeAlpha,
    );
    return json(registered, 201);
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
