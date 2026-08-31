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
import { alphaBounds, decodePng, readMp4Size, readPngSize, sniffMimeType } from "@seed-ae/media";
import { resolveStorageUri, toStorageUri } from "@seed-ae/storage";
import { toDisplayReferred } from "../media/displayReferred.js";
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

/**
 * Reads a file the host has just written.
 *
 * Media Encoder hands back a path while it still holds the file open, so a
 * straight read fails with EBUSY — and a file that merely exists may still be
 * growing. This waits for the size to settle, then reads, retrying while the
 * writer keeps its lock.
 */
async function readWhenSettled(
  filePath: string,
  options: { attempts?: number } = {},
): Promise<Buffer> {
  const attempts = options.attempts ?? 60;
  const delayMs = 250;
  let previousSize = -1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { size } = await stat(filePath);
      if (size > 0 && size === previousSize) {
        return await readFile(filePath);
      }
      previousSize = size;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      // EBUSY/EPERM mean the writer still owns it; ENOENT that it is not there
      // yet. Neither is fatal this early.
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOENT") throw cause;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new SeedError(
    "host_error",
    `the captured frame at ${filePath} was still locked or growing after ` +
      `${Math.round((attempts * delayMs) / 1000)}s`,
  );
}

async function registerCapturedFrame(
  deps: AppDeps,
  captured: CapturedMedia,
  format: "png" | "exr",
  includesAlpha: boolean,
): Promise<RegisteredCapture> {
  const bytes = await readWhenSettled(captured.path);
  const stats = { size: bytes.length };
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
/**
 * The working space, from whichever field the host recorded it in.
 *
 * `colorManagement.workingSpace` is the detailed record; `colorSpace` is the
 * flat one; `workingSpace` is what a newer host reports directly. Reading all
 * three means a panel and a service on different versions still agree.
 */
function workingSpaceOf(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const record = context as Record<string, unknown>;
  const management = record.colorManagement;
  if (management && typeof management === "object") {
    const nested = (management as Record<string, unknown>).workingSpace;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  for (const key of ["colorSpace", "workingSpace"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

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

    /*
     * Make the pixels display-referred before anything sees them.
     *
     * The host writes the frame in the project's working space, so a
     * colour-managed project hands us scene-referred data that reads as
     * near-black everywhere downstream — including in the plate sent to the
     * model. The working space is already in the provenance the panel sent, so
     * nothing extra had to be asked of After Effects to know this.
     *
     * Done before registration, while the file is still a temporary on its way
     * to being an asset: nothing immutable is rewritten, and a linear original
     * that nobody can view is not worth keeping.
     */
    const colour = await toDisplayReferred(
      absolutePath,
      workingSpaceOf(request.context),
      {
        ...(request.width !== undefined ? { width: request.width } : {}),
        ...(request.height !== undefined ? { height: request.height } : {}),
      },
    );
    if (colour.converted) {
      deps.logger.info("capture.converted_to_display_referred", {
        from: colour.from,
        meanLevel: colour.meanLevel,
      });
    } else if (colour.reason && !/nothing to do/.test(colour.reason)) {
      // Not fatal — a capture nobody can convert is still a capture — but the
      // artist deserves to know why it looks the way it does.
      deps.logger.warn("capture.not_converted", { reason: colour.reason });
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

const RegisterClipSchema = z.object({
  /** Absolute path the host rendered to; must be inside the workspace. */
  path: z.string().min(1),
  /**
   * A still of the clip's first frame, if the host could make one.
   *
   * There is no video decoder here, so without it the clip has no poster and
   * a library of grey cards is a library nobody picks a reference from.
   */
  posterPath: z.string().optional(),
  context: AeContextSchema,
  mimeType: z.string().default("video/mp4"),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  fps: z.number().positive().optional(),
});

/**
 * Registers a rendered span of the timeline as a video asset.
 *
 * The still path and this one stay separate on purpose: a clip carries a
 * duration and a frame rate, needs its bytes sniffed rather than assumed, and
 * gets its poster from a second file. Folding it into the frame route would
 * mean a function that is two functions with a flag.
 */
export function registerClipRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(RegisterClipSchema, body);

    // Round-tripping through the storage URI is the path validation.
    const storageUri = toStorageUri(deps.workspace, request.path);
    const absolutePath = resolveStorageUri(deps.workspace, storageUri);

    // After Effects hands back the path the moment the render finishes, and
    // the file can still be open; readWhenSettled waits it out.
    const bytes = await readWhenSettled(absolutePath);

    // Trust the bytes over anything declared: an output module template can be
    // changed, and a .mp4 holding something else would be registered as a lie.
    const sniffed = sniffMimeType(bytes);
    const mimeType = sniffed ?? request.mimeType;
    if (!mimeType.startsWith("video/")) {
      throw new SeedError(
        "bad_request",
        `${path.basename(absolutePath)} is ${mimeType}, not a video`,
      );
    }

    const probed = readMp4Size(bytes);
    const width = request.width ?? probed?.width;
    const height = request.height ?? probed?.height;
    // The host knows the span it asked for; the file knows what it got. They
    // agree unless the render was cut short, so the file wins.
    const durationSeconds = probed?.durationSeconds ?? request.durationSeconds;

    // Recorded on the asset, so a poster that could not be turned into a
    // thumbnail now is still findable later. It is the only first frame a clip
    // has here — nothing in this process can decode one out of the video.
    const posterUri = request.posterPath
      ? toStorageUri(deps.workspace, request.posterPath)
      : undefined;

    const draft: AssetDraft = {
      kind: "video",
      filename: path.basename(absolutePath),
      mimeType,
      storageUri,
      byteSize: bytes.length,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(durationSeconds ? { durationSeconds } : {}),
      ...(request.fps ? { fps: request.fps } : {}),
      source: {
        type: "after-effects",
        context: request.context,
        captureFormat: "mp4",
        includesAlpha: false,
        ...(posterUri ? { posterUri } : {}),
      },
    };

    const asset = deps.assets.create(draft);

    let registered = asset;
    if (posterUri) {
      // Settle rather than read once: the host writes the poster immediately
      // before answering, and a still being flushed is not a missing one.
      const poster = await readWhenSettled(
        resolveStorageUri(deps.workspace, posterUri),
        { attempts: 12 },
      ).catch(() => undefined);
      const thumbnailUri = poster
        ? await deps.ingestor.writeThumbnail(poster, asset.id)
        : undefined;
      if (thumbnailUri) registered = deps.assets.setThumbnail(asset.id, thumbnailUri);
      else {
        deps.logger.warn("ae.clip.poster_unusable", {
          assetId: asset.id,
          posterUri,
          reason: poster ? "no thumbnail could be written" : "the file never settled",
        });
      }
    }

    deps.logger.info("ae.clip.captured", {
      assetId: asset.id,
      compName: request.context.compName,
      durationSeconds,
      byteSize: bytes.length,
      hasPoster: registered.thumbnailUri !== undefined,
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
