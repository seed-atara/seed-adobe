import { createReadStream } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type Asset,
  ListAssetsQuerySchema,
  RegisterAssetRequestSchema,
  SeedError,
  assetKindFromMimeType,
  nowIso,
} from "@seed-ae/domain";
import {
  colourDistance,
  decodeJpegPreview,
  decodePng,
  encodePng,
  measureColour,
  readMp4Size,
  readPngSize,
  sniffMimeType,
  type ColourStats,
} from "@seed-ae/media";
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

const PosterSchema = z.object({
  /** A PNG of the clip's first frame, base64, decoded by whoever can. */
  png: z.string().min(1),
});

/**
 * Gives a clip a poster extracted from the clip itself.
 *
 * Nothing in this process can decode H.264 — there is no video decoder here
 * and adding one to write a thumbnail would be absurd. The panel, however, is
 * Chromium: it already has a decoder, it already has the bytes, and a `<video>`
 * seeked to its first frame and drawn into a canvas is a real extract rather
 * than a borrowed still. So the decoding happens where the decoder is, and
 * this route stores the result.
 *
 * That matters most for a reskin: the borrowed poster shows the *source* clip,
 * which is precisely the thing the generation was asked to change.
 */
export function setPosterRoute(deps: AppDeps) {
  return async ({ req, params }: RequestContext) => {
    const asset = deps.assets.requireById(params.id as string);
    if (asset.kind !== "video") {
      throw new SeedError(
        "bad_request",
        `asset ${asset.id} is ${asset.kind}; only a clip needs a poster`,
      );
    }

    const body = await readJsonBody(req);
    const { png } = parseWith(PosterSchema, body);
    const bytes = Buffer.from(png, "base64");

    // Trust the bytes: a poster is only ever a PNG the panel drew.
    if (sniffMimeType(bytes) !== "image/png") {
      throw new SeedError("bad_request", "a poster has to be a PNG");
    }

    const thumbnailUri = await deps.ingestor.writeThumbnail(bytes, asset.id);
    if (!thumbnailUri) {
      throw new SeedError("storage_error", "the poster could not be written");
    }

    deps.logger.info("asset.poster_extracted", {
      assetId: asset.id,
      byteSize: bytes.length,
    });
    return json({ asset: deps.assets.setThumbnail(asset.id, thumbnailUri) });
  };
}

const ColourMatchSchema = z.object({
  /** The shots to compare, in cut order. Posters are used for video. */
  assetIds: z.array(z.string().min(1)).min(1).max(200),
  /** The shot everything is measured against. Defaults to the first. */
  referenceId: z.string().min(1).optional(),
});

/**
 * How far each shot sits from the reference, in Lab.
 *
 * Generative shots drift: two clips from the same plates, the same Item and
 * the same prompt come back at different exposures and different casts, and
 * cut together they read as two different days. Nothing noticed, because
 * nothing measured.
 *
 * This measures. It deliberately does not correct — a grade belongs in the
 * host where the artist can see it, and the number is what tells them whether
 * they need one and on which shot.
 */
export function colourMatchRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(ColourMatchSchema, await readJsonBody(req));

    const measured: Array<{
      assetId: string;
      filename: string;
      stats?: ColourStats;
      reason?: string;
    }> = [];

    for (const id of request.assetIds) {
      const asset = deps.assets.requireById(id);
      /*
       * A clip is measured through its poster. Nothing here decodes video,
       * and the poster is a real frame from the shot — which is the right
       * sample anyway, since it is what the artist sees on the card.
       */
      const poster =
        asset.source.type === "after-effects" ? asset.source.posterUri : undefined;
      const uri = asset.kind === "video" ? (poster ?? asset.thumbnailUri) : asset.storageUri;
      if (!uri) {
        measured.push({
          assetId: id,
          filename: asset.filename,
          reason: "no still to measure — this clip has no poster",
        });
        continue;
      }

      const bytes = await readFile(resolveStorageUri(deps.workspace, uri)).catch(
        () => undefined,
      );
      const image = bytes ? (decodePng(bytes) ?? decodeJpegPreview(bytes)) : undefined;
      if (!image) {
        measured.push({
          assetId: id,
          filename: asset.filename,
          reason: "could not be decoded",
        });
        continue;
      }
      measured.push({ assetId: id, filename: asset.filename, stats: measureColour(image) });
    }

    const reference =
      measured.find((entry) => entry.assetId === request.referenceId && entry.stats) ??
      measured.find((entry) => entry.stats);

    if (!reference?.stats) {
      throw new SeedError(
        "bad_request",
        "none of those assets could be measured, so there is nothing to compare",
      );
    }

    const referenceStats = reference.stats;
    return json({
      referenceId: reference.assetId,
      shots: measured.map((entry) => ({
        assetId: entry.assetId,
        filename: entry.filename,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.stats
          ? {
              distance: Number(colourDistance(entry.stats, referenceStats).toFixed(2)),
              lightness: Number(entry.stats.mean[0].toFixed(1)),
              /*
               * Signed, so the panel can say "warmer" rather than only "off".
               * a is green-to-red, b is blue-to-yellow.
               */
              a: Number(entry.stats.mean[1].toFixed(1)),
              b: Number(entry.stats.mean[2].toFixed(1)),
            }
          : {}),
      })),
    });
  };
}

const SolidAssetSchema = z.object({
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  /** 0..255 per channel. Black unless asked otherwise. */
  red: z.number().int().min(0).max(255).default(0),
  green: z.number().int().min(0).max(255).default(0),
  blue: z.number().int().min(0).max(255).default(0),
  project: z.string().min(1).optional(),
});

/**
 * A flat colour frame, as a real asset.
 *
 * A shot that fades up from black needs an opening frame that *is* black, and
 * Seedance refuses a closing frame with nothing to animate from. Asking the
 * artist to make a black PNG in another application, save it somewhere and
 * import it is three steps of nothing.
 *
 * It goes through the same adopt path as any other file rather than being
 * special-cased into the library: it gets a thumbnail, a project, provenance
 * and an id like everything else, and only one ingest path has to stay
 * correct.
 */
export function solidAssetRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(SolidAssetSchema, body);

    const pixels = new Uint8Array(request.width * request.height * 4);
    for (let at = 0; at < pixels.length; at += 4) {
      pixels[at] = request.red;
      pixels[at + 1] = request.green;
      pixels[at + 2] = request.blue;
      pixels[at + 3] = 255;
    }

    const hex =
      request.red === 0 && request.green === 0 && request.blue === 0
        ? "black"
        : `${request.red.toString(16).padStart(2, "0")}${request.green
            .toString(16)
            .padStart(2, "0")}${request.blue.toString(16).padStart(2, "0")}`;
    const name = `solid-${hex}_${request.width}x${request.height}.png`;

    /*
     * Written into the workspace first so adopt copies it the same way it
     * copies anything else. The name is deterministic, so asking twice reuses
     * the same bytes rather than filling the library with identical squares.
     */
    const staging = path.join(deps.workspace.originalsDir, name);
    await writeFile(staging, encodePng(request.width, request.height, pixels));

    const asset = await adoptFileIntoLibrary(deps, staging, request.project);
    return json({ asset }, 201);
  };
}

const AdoptFileSchema = z.object({
  /** Any absolute path the user picked; copied in, never referenced in place. */
  path: z.string().min(1),
  /** The project open when it was added, so a filtered library still finds it. */
  project: z.string().min(1).optional(),
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
    const asset = await adoptFileIntoLibrary(deps, request.path, request.project);
    return json({ asset }, 201);
  };
}

/**
 * Copies a file on disk into the library and registers it by what its bytes
 * actually are.
 *
 * Shared with pack import, which needs exactly this and must not grow a second
 * slightly different version of it — two ingest paths is how a `.png` full of
 * JPEG gets registered correctly in one place and wrongly in the other.
 */
export async function adoptFileIntoLibrary(
  deps: AppDeps,
  filePath: string,
  project?: string,
): Promise<Asset> {
  {
    const request = { path: filePath, ...(project ? { project } : {}) };
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
      ...(request.project ? { project: request.project } : {}),
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

    return registered;
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
      ...(deps.config.pproQualityPreset
        ? { pproQualityPreset: deps.config.pproQualityPreset }
        : {}),
      ...(deps.config.pproVideoPreset
        ? { pproVideoPreset: deps.config.pproVideoPreset }
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
