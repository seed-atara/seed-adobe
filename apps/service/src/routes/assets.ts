import { createReadStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import {
  ListAssetsQuerySchema,
  RegisterAssetRequestSchema,
  SeedError,
  nowIso,
} from "@seed-ae/domain";
import { resolveStorageUri } from "@seed-ae/storage";
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
    return json({ path: await ensurePlaceholder(deps.workspace, width, height) });
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
