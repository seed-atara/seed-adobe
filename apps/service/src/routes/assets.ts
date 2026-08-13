import { createReadStream } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ListAssetsQuerySchema,
  RegisterAssetRequestSchema,
  SeedError,
  assetKindFromMimeType,
  nowIso,
} from "@seed-ae/domain";
import { readMp4Size, readPngSize, sniffMimeType } from "@seed-ae/media";
import { resolveStorageUri, toStorageUri } from "@seed-ae/storage";
import { z } from "zod";
import { MAX_OUTPUT_BYTES } from "../generation/mediaIngestor.js";
import { ensurePlaceholder } from "../placeholder.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

export function registerAssetRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const draft = parseWith(RegisterAssetRequestSchema, body);
    // Reject anything pointing outside the workspace before it reaches SQLite.
    resolveStorageUri(deps.workspace, draft.storageUri);
    const asset = deps.assets.create(draft);
    deps.logger.info("asset.registered", {
      assetId: asset.id,
      kind: asset.kind,
      sourceType: asset.source.type,
    });
    return json({ asset }, 201);
  };
}

export function listAssetsRoute(deps: AppDeps) {
  return ({ url }: RequestContext) => {
    const query = parseWith(
      ListAssetsQuerySchema,
      Object.fromEntries(url.searchParams),
    );
    const { assets, total } = deps.assets.list(query);
    return json({ assets, total, limit: query.limit, offset: query.offset });
  };
}

export function getAssetRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const id = params.id as string;
    return json({ asset: deps.assets.requireById(id) });
  };
}

/**
 * Removes an asset from the library and reclaims its bytes.
 *
 * The row stays. Recipes that used this frame as an input still name it, and a
 * dangling id explains nothing — so the asset becomes what a missing file
 * already meant, status 'missing', with a timestamp saying it was deliberate.
 * The library stops showing it.
 *
 * The media is deleted, so this is not undoable. It is the artist's call to
 * make, and the panel says what it costs before asking them to make it.
 */
export function removeAssetRoute(deps: AppDeps) {
  return async ({ params }: RequestContext) => {
    const asset = deps.assets.requireById(params.id as string);
    const usedBy = deps.assets.usedByCount(asset.id);

    const removed: string[] = [];
    for (const uri of [asset.storageUri, asset.thumbnailUri]) {
      if (!uri) continue;
      try {
        await unlink(resolveStorageUri(deps.workspace, uri));
        removed.push(uri);
      } catch (cause) {
        // Already gone is the outcome we wanted; anything else is worth saying.
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
          deps.logger.warn("asset.remove_file_failed", {
            assetId: asset.id,
            uri,
            reason: (cause as Error).message,
          });
        }
      }
    }

    deps.assets.hide(asset.id, nowIso());
    deps.logger.info("asset.removed", {
      assetId: asset.id,
      filename: asset.filename,
      filesRemoved: removed.length,
      usedByGenerations: usedBy,
    });

    return json({ id: asset.id, filesRemoved: removed.length, usedBy });
  };
}

const AdoptFileSchema = z.object({
  /** Any absolute path the user picked; copied in, never referenced in place. */
  path: z.string().min(1),
});

/**
 * Takes a file from anywhere on disk into the library.
 *
 * The manual half of video references: an artist who has already exported a
 * clip — from the render queue, from Media Encoder, from another application
 * entirely — should be able to use it as a reference without SEED having
 * rendered it. It is also the fallback for any host SEED cannot drive.
 *
 * The bytes are copied rather than linked. An asset is immutable and the
 * library owns its media; referencing a file in someone's Downloads folder
 * would make provenance depend on a path that can move or change underneath it.
 */
export function adoptFileRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(AdoptFileSchema, body);
    const source = path.resolve(request.path);

    const info = await stat(source).catch(() => undefined);
    if (!info?.isFile()) {
      throw new SeedError("not_found", `no file at ${request.path}`);
    }
    if (info.size === 0) {
      throw new SeedError("bad_request", `${path.basename(source)} is empty`);
    }
    if (info.size > MAX_OUTPUT_BYTES) {
      throw new SeedError(
        "bad_request",
        `${path.basename(source)} is ${info.size} bytes, over the ` +
          `${MAX_OUTPUT_BYTES} byte limit`,
      );
    }

    const bytes = await readFile(source);
    // The bytes decide what this is. A .mp4 that is really a MOV, or a .png
    // holding JPEG, would otherwise be registered as whatever it was named.
    const mimeType = sniffMimeType(bytes) ?? "application/octet-stream";
    const kind = assetKindFromMimeType(mimeType);
    if (kind === "other") {
      throw new SeedError(
        "bad_request",
        `${path.basename(source)} is ${mimeType}, which SEED has no use for as a reference`,
      );
    }

    const stem = path
      .basename(source, path.extname(source))
      .replace(/[^A-Za-z0-9._-]+/g, "_")
      .slice(0, 48);
    const extension = path.extname(source).toLowerCase() || extensionFor(mimeType);

    // Never overwrite: two files of the same name are two different assets.
    let target = "";
    for (let attempt = 1; attempt < 1000; attempt += 1) {
      const suffix = String(attempt).padStart(3, "0");
      target = path.join(deps.workspace.originalsDir, `${stem}_${suffix}${extension}`);
      try {
        await writeFile(target, bytes, { flag: "wx" });
        break;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new SeedError("storage_error", `could not write ${target}`, { cause });
        }
        target = "";
      }
    }
    if (!target) {
      throw new SeedError("storage_error", `could not find a free name for ${stem}`);
    }

    const video = kind === "video" ? readMp4Size(bytes) : undefined;
    const image = kind === "image" ? readPngSize(bytes) : undefined;
    const width = image?.width ?? video?.width;
    const height = image?.height ?? video?.height;

    const asset = deps.assets.create({
      kind,
      filename: path.basename(target),
      mimeType,
      storageUri: toStorageUri(deps.workspace, target),
      byteSize: bytes.length,
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(video?.durationSeconds ? { durationSeconds: video.durationSeconds } : {}),
      source: { type: "imported", originalPath: source },
    });

    // Images get a real thumbnail; a clip gets none, because nothing here can
    // decode one. The panel shows a video badge rather than a broken picture.
    const thumbnailUri = await deps.ingestor.writeThumbnail(bytes, asset.id);
    const registered = thumbnailUri
      ? deps.assets.setThumbnail(asset.id, thumbnailUri)
      : asset;

    deps.logger.info("asset.adopted", {
      assetId: asset.id,
      kind,
      mimeType,
      byteSize: bytes.length,
    });

    return json({ asset: registered }, 201);
  };
}

/** A sensible extension for a file that arrived without one. */
function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
  };
  return known[mimeType] ?? "";
}

/**
 * The card used to hold a cut open, in the shape the render will be.
 *
 * The host needs a real file on disk to place, and it has to be the right shape
 * or the artist is framing against something that will not be there.
 */
export function placeholderRoute(deps: AppDeps) {
  return async ({ url }: RequestContext) => {
    const width = Number(url.searchParams.get("width")) || 1920;
    const height = Number(url.searchParams.get("height")) || 1080;
    const tag = url.searchParams.get("tag") ?? undefined;
    return json({
      path: await ensurePlaceholder(deps.workspace, width, height, tag),
    });
  };
}

/**
 * Absolute on-disk paths for the workspace.
 *
 * A CEP panel runs inside After Effects and drives it through ExtendScript, so
 * it needs real paths to render frames into and import from. Only ever served
 * over the authenticated loopback API.
 */
export function workspaceRoute(deps: AppDeps) {
  return async () =>
    json({
      workspace: {
        projectRoot: deps.workspace.projectRoot,
        root: deps.workspace.root,
        originalsDir: deps.workspace.originalsDir,
        generatedDir: deps.workspace.generatedDir,
      },
      aeHost: deps.aeHost.id,
      // The panel hides direction rather than offering a button that 501s.
      director: deps.director !== undefined,
      // The card a host uses to hold a cut open while a video renders.
      placeholder: await ensurePlaceholder(deps.workspace),
      ...(deps.config.pproStillPreset
        ? { pproStillPreset: deps.config.pproStillPreset }
        : {}),
    });
}

/** Absolute path of one asset, for handing to the AE import call. */
export function getAssetPathRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const asset = deps.assets.requireById(params.id as string);
    return json({
      assetId: asset.id,
      path: resolveStorageUri(deps.workspace, asset.storageUri),
      filename: asset.filename,
    });
  };
}

/** Serves asset bytes to the panel; the panel never touches the filesystem. */
export function getAssetFileRoute(deps: AppDeps) {
  return async ({ params, url, res, correlationId }: RequestContext) => {
    const asset = deps.assets.requireById(params.id as string);

    // A grid of full-resolution renders is the difference between a snappy
    // panel and a stalled one, so the thumbnail is served when asked for.
    const wantsThumbnail =
      url.searchParams.get("variant") === "thumbnail" && asset.thumbnailUri;
    const storageUri = wantsThumbnail
      ? (asset.thumbnailUri as string)
      : asset.storageUri;
    const contentType = wantsThumbnail ? "image/png" : asset.mimeType;
    const absolutePath = resolveStorageUri(deps.workspace, storageUri);

    const stats = await stat(absolutePath).catch(() => undefined);
    if (!stats?.isFile()) {
      // Only the original going missing invalidates the asset; a lost
      // thumbnail is a cache problem, not a provenance problem.
      if (!wantsThumbnail) deps.assets.updateStatus(asset.id, "missing");
      throw new SeedError(
        "not_found",
        `media for asset ${asset.id} is missing`,
      );
    }

    res.writeHead(200, {
      "content-type": contentType,
      "content-length": stats.size,
      "x-seed-correlation-id": correlationId,
      "cache-control": "no-store",
    });
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(absolutePath);
      stream.on("error", reject);
      stream.on("end", resolve);
      stream.pipe(res);
    });
    return undefined;
  };
}
