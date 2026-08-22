import {
  PASS_ORDER,
  PASS_PRESETS,
  PassKindSchema,
  SeedError,
  passPrompt,
  type PassKind,
} from "@seed-ae/domain";
import { z } from "zod";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeJpegPreview,
  decodePng,
  encodePng,
  normalsFromDepth,
  relight,
  type RasterImage,
} from "@seed-ae/media";
import { resolveStorageUri } from "@seed-ae/storage";
import { estimateDepth } from "../passes/depth.js";
import { adoptFileIntoLibrary } from "./assets.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Render passes from a shot — "switcharoo".
 *
 * A pass is an ordinary generation with a very particular prompt and the plate
 * attached as a reference. Nothing here is a new pipeline: the same provider,
 * the same job machinery, the same lineage. What is new is that the request is
 * built rather than typed, so the prompt that makes a usable albedo is written
 * once and not remembered by whoever is at the keyboard.
 *
 * The pass kind is recorded in the generation's parameters, which is what lets
 * a pass be found again later — and what lets an albedo be offered as an
 * identity plate rather than sitting in the library looking like a washed-out
 * copy of a shot.
 */

const StartPassSchema = z.object({
  /** The shot to derive from. Travels as a reference, never as a frame. */
  sourceAssetId: z.string().min(1),
  kinds: z.array(PassKindSchema).min(1).max(6),
  providerId: z.string().min(1),
  model: z.string().min(1).optional(),
  size: z.string().optional(),
  /** Only `relight` uses this. */
  lighting: z.string().max(600).optional(),
  seed: z.union([z.number().int(), z.string()]).optional(),
  project: z.string().min(1).optional(),
});

export function startPassesRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(StartPassSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);

    if (source.kind !== "video" && source.kind !== "image") {
      throw new SeedError(
        "bad_request",
        `a pass needs a still or a clip to derive from, and ${source.filename} is ${source.kind}`,
      );
    }

    const started = [];
    for (const kind of request.kinds) {
      const job = await deps.generation.start(
        {
          providerId: request.providerId,
          ...(request.model ? { model: request.model } : {}),
          operation: source.kind === "video" ? "video.generate" : "image.edit",
          prompt: passPrompt(kind, request.lighting),
          ...(request.size ? { size: request.size } : {}),
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          inputAssetIds: [source.id],
          /*
           * A reference, not a first frame. A frame anchors the shot's geometry
           * and then the model animates *away* from it, which is the opposite of
           * what a pass wants — and on Seedance a lone still would be read as a
           * first frame automatically.
           */
          inputRoles: ["reference"],
          itemMentions: [],
          parentAssetId: source.id,
          ...(request.project ? { project: request.project } : {}),
          parameters: {
            /* Read back by listPassesRoute; what makes a pass findable. */
            seedPass: kind,
            seedPassSource: source.id,
          },
        },
        `pass_${kind}_${source.id}`,
      );
      started.push({ kind, job });
    }

    return json({ started }, 202);
  };
}

/**
 * What has already been derived from a shot.
 *
 * Read off the generations rather than stored on the assets: a pass is a
 * *relationship* between two pieces of media, and the generation record is
 * where SEED already keeps relationships. Adding a column to assets would put
 * the same fact in two places.
 */
export function listPassesRoute(deps: AppDeps) {
  return ({ url }: RequestContext) => {
    const sourceId = url.searchParams.get("sourceAssetId");
    if (!sourceId) {
      throw new SeedError("bad_request", "sourceAssetId is required");
    }

    const passes: Array<{
      kind: PassKind;
      generationId: string;
      status: string;
      assetIds: string[];
      createdAt: string;
    }> = [];

    /*
     * Asked of the source asset rather than by scanning recent generations:
     * consumersOf is an index lookup and it cannot miss a pass made a thousand
     * shots ago, which a fixed window would.
     */
    for (const generation of deps.generations.consumersOf(sourceId)) {
      const parameters = generation.parameters as Record<string, unknown>;
      if (parameters?.seedPassSource !== sourceId) continue;
      const kind = parameters?.seedPass;
      if (typeof kind !== "string") continue;
      passes.push({
        kind: kind as PassKind,
        generationId: generation.id,
        status: generation.status,
        assetIds: generation.outputAssetIds,
        createdAt: generation.createdAt,
      });
    }

    return json({ sourceAssetId: sourceId, passes });
  };
}

/** The catalogue, so the panel does not carry its own copy of the prompts. */
export function passPresetsRoute() {
  return () =>
    json({
      presets: PASS_ORDER.map((kind) => ({
        kind,
        label: PASS_PRESETS[kind].label,
        purpose: PASS_PRESETS[kind].purpose,
        usableAsIdentity: PASS_PRESETS[kind].usableAsIdentity,
        /* Shown, not hidden: an artist should be able to read what was asked. */
        prompt: PASS_PRESETS[kind].prompt,
      })),
    });
}

/* ------------------------------------------------------------- derived --- */

/**
 * The still behind an asset, whatever kind it is.
 *
 * A clip is read through its poster: nothing here decodes video, and the
 * poster is a real frame from the shot.
 */
async function stillFor(deps: AppDeps, assetId: string): Promise<RasterImage> {
  const asset = deps.assets.requireById(assetId);
  const poster =
    asset.source.type === "after-effects" ? asset.source.posterUri : undefined;
  const uri = asset.kind === "video" ? (poster ?? asset.thumbnailUri) : asset.storageUri;
  if (!uri) {
    throw new SeedError(
      "bad_request",
      `${asset.filename} has no still to work from`,
    );
  }
  const bytes = await readFile(resolveStorageUri(deps.workspace, uri));
  const image = decodePng(bytes) ?? decodeJpegPreview(bytes);
  if (!image) {
    throw new SeedError("bad_request", `${asset.filename} could not be decoded`);
  }
  return image;
}

/** Writes an image into the library, through the one ingest path. */
async function keep(
  deps: AppDeps,
  image: RasterImage,
  name: string,
  project?: string,
) {
  const file = path.join(deps.workspace.originalsDir, name);
  await writeFile(file, encodePng(image.width, image.height, image.rgba));
  return adoptFileIntoLibrary(deps, file, project);
}

const DeriveSchema = z.object({
  sourceAssetId: z.string().min(1),
  /** `depth` runs a model; `normal` is arithmetic on the depth. */
  kinds: z.array(z.enum(["depth", "normal"])).min(1),
  /** Relief scale for the normal map. Higher is more pronounced. */
  strength: z.number().min(0.25).max(16).default(4),
  model: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
});

/**
 * Depth and normals, measured rather than asked for.
 *
 * Depth comes from Depth Anything V2 running in this process through ONNX —
 * no provider, no cost, no network once the weights are cached. Normals are
 * then arithmetic on that depth, which makes them a measurement rather than a
 * drawing: the difference between a normal map that can drive relighting and
 * one that merely looks like a normal map.
 *
 * Synchronous rather than a job. It takes about a second a frame, and a job
 * for something that finishes before the panel could poll it would be
 * ceremony.
 */
export function derivePassesRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(DeriveSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);
    const still = await stillFor(deps, request.sourceAssetId);
    const stem = source.filename.replace(/\.[^.]+$/, "");

    // Normals need depth, so it is computed whenever either was asked for.
    const depth = await estimateDepth(still, request.model);

    const made: Array<{ kind: string; asset: unknown }> = [];
    if (request.kinds.includes("depth")) {
      made.push({
        kind: "depth",
        asset: await keep(deps, depth, `${stem}_depth.png`, request.project),
      });
    }
    if (request.kinds.includes("normal")) {
      made.push({
        kind: "normal",
        asset: await keep(
          deps,
          normalsFromDepth(depth, request.strength),
          `${stem}_normal.png`,
          request.project,
        ),
      });
    }

    return json({ sourceAssetId: source.id, made }, 201);
  };
}

const RelightSchema = z.object({
  albedoAssetId: z.string().min(1),
  normalAssetId: z.string().min(1),
  roughnessAssetId: z.string().min(1).optional(),
  occlusionAssetId: z.string().min(1).optional(),
  light: z
    .object({ x: z.number(), y: z.number(), z: z.number() })
    .default({ x: -0.4, y: -0.6, z: 0.7 }),
  intensity: z.number().min(0).max(4).default(1),
  ambient: z.number().min(0).max(2).default(0.25),
  specular: z.number().min(0).max(2).default(0.2),
  shininess: z.number().min(1).max(200).default(24),
  lightColour: z.tuple([z.number(), z.number(), z.number()]).optional(),
  project: z.string().min(1).optional(),
});

/**
 * Albedo and normals, lit again.
 *
 * The recombination step — Lambert plus Blinn-Phong, the same diffuse and
 * specular split Beeble computes with Cook-Torrance, and deliberately not
 * claiming to be it. Deterministic and instant: no model runs here at all.
 */
export function relightRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(RelightSchema, await readJsonBody(req));

    const albedo = await stillFor(deps, request.albedoAssetId);
    const normals = await stillFor(deps, request.normalAssetId);
    const roughness = request.roughnessAssetId
      ? await stillFor(deps, request.roughnessAssetId)
      : undefined;
    const occlusion = request.occlusionAssetId
      ? await stillFor(deps, request.occlusionAssetId)
      : undefined;

    const lit = relight(albedo, normals, {
      light: request.light,
      intensity: request.intensity,
      ambient: request.ambient,
      specular: request.specular,
      shininess: request.shininess,
      ...(roughness ? { roughness } : {}),
      ...(occlusion ? { occlusion } : {}),
      ...(request.lightColour ? { lightColour: request.lightColour } : {}),
    });

    const stem = deps.assets
      .requireById(request.albedoAssetId)
      .filename.replace(/\.[^.]+$/, "");
    const asset = await keep(deps, lit, `${stem}_relit.png`, request.project);
    return json({ asset }, 201);
  };
}
