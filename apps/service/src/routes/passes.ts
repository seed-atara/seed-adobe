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
  applyLighting,
  estimateLighting,
  measureCamera,
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
  /** Relief scale for the normal map, from the depth. Higher is more shape. */
  strength: z.number().min(0.25).max(16).default(4),
  /**
   * How much surface detail to take from the picture itself.
   *
   * Depth is smooth, so it gives a silhouette and no surface. The fur, weave
   * and pores are in the photograph, and this is how much of them reaches the
   * normal map.
   */
  detail: z.number().min(0).max(40).default(8),
  /** Below this, the picture is shape rather than surface. In pixels. */
  detailRadius: z.number().min(1).max(64).default(3),
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
          normalsFromDepth(depth, request.strength, {
            // The source frame, so the surface comes from the picture.
            image: still,
            amount: request.detail,
            radius: request.detailRadius,
          }),
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

const LightTransferSchema = z.object({
  /** The shot whose lighting is wanted, and its passes. */
  referenceAssetId: z.string().min(1),
  referenceAlbedoId: z.string().min(1),
  referenceNormalId: z.string().min(1),
  /** The shot to light that way, and its passes. */
  targetAlbedoId: z.string().min(1),
  targetNormalId: z.string().min(1),
  /** 0–1. A full transfer imposes the reference's key direction outright. */
  amount: z.number().min(0).max(1).default(1),
  project: z.string().min(1).optional(),
});

/**
 * Light one shot the way another shot is lit.
 *
 * The thing a library makes possible and a single image does not. Beeble
 * relights one frame to an HDRI you author; here the lighting is *solved off a
 * reference shot* — nine spherical-harmonic coefficients per channel, ordinary
 * least squares — and applied to another. "Make these two cut together" stops
 * being a matching exercise by eye and becomes a measurement.
 *
 * The residual is returned rather than hidden. Second-order harmonics carry
 * soft light and cannot carry a hard shadow edge, so a high residual means the
 * reference has lighting this method genuinely cannot express, and the artist
 * should know that before trusting the result.
 */
export function lightTransferRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(LightTransferSchema, await readJsonBody(req));

    const reference = await stillFor(deps, request.referenceAssetId);
    const referenceAlbedo = await stillFor(deps, request.referenceAlbedoId);
    const referenceNormals = await stillFor(deps, request.referenceNormalId);

    const solution = estimateLighting(reference, referenceNormals, referenceAlbedo);
    if (solution.samples < 32) {
      throw new SeedError(
        "bad_request",
        "there was not enough surface variation in that reference to solve its " +
          "lighting — a flat card cannot say where the light is",
      );
    }

    const targetAlbedo = await stillFor(deps, request.targetAlbedoId);
    const targetNormals = await stillFor(deps, request.targetNormalId);
    const lit = applyLighting(targetAlbedo, targetNormals, solution, request.amount);

    const stem = deps.assets
      .requireById(request.targetAlbedoId)
      .filename.replace(/\.[^.]+$/, "");
    const asset = await keep(deps, lit, `${stem}_lit.png`, request.project);

    return json(
      {
        asset,
        residual: solution.residual,
        samples: solution.samples,
        note:
          solution.residual > 0.25
            ? "The reference has lighting this cannot express — hard shadows or " +
              "strong occlusion. The soft part transferred; the rest did not."
            : "The reference's lighting solved cleanly.",
      },
      201,
    );
  };
}

const CameraTransferSchema = z.object({
  /** The shot whose camera is wanted. */
  referenceAssetId: z.string().min(1),
  /** Optional: the shot to match, so the settings are a *difference*. */
  targetAssetId: z.string().min(1).optional(),
  /** Below this, a measurement is reported but not turned into a setting. */
  minimumConfidence: z.number().min(0).max(1).default(0.3),
});

/**
 * The camera out of a shot, as film-look settings.
 *
 * Lighting is half of why two shots refuse to cut together; the camera is the
 * other half — corner falloff, channel separation towards the edge, grain in
 * the midtones, red bleeding around a clipped highlight. A colourist matches
 * those by eye because no tool offers to measure them, and SEED already has an
 * engine with exactly these parameters.
 *
 * With a target as well as a reference, the answer is the *difference*: what to
 * add to the target to make it look as though the reference's camera shot it.
 * A shot that already has grain does not want the reference's grain on top.
 *
 * Nothing below the confidence threshold becomes a setting. A frame with no
 * clipped highlights cannot speak about halation, and applying a confident
 * zero would be worse than applying nothing.
 */
export function cameraTransferRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(CameraTransferSchema, await readJsonBody(req));

    const reference = measureCamera(await stillFor(deps, request.referenceAssetId));
    const target = request.targetAssetId
      ? measureCamera(await stillFor(deps, request.targetAssetId))
      : undefined;

    const floor = request.minimumConfidence;
    const settings: Record<string, number> = {};
    const skipped: string[] = [];

    const consider = (
      name: string,
      from: { value: number; confidence: number },
      to?: { value: number; confidence: number },
    ) => {
      if (from.confidence < floor) {
        skipped.push(`${name}: the reference frame could not answer`);
        return;
      }
      if (to && to.confidence < floor) {
        skipped.push(`${name}: the target frame could not answer, so no difference could be taken`);
        return;
      }
      // The difference where there is a target; the raw value otherwise.
      const value = to ? Math.max(0, from.value - to.value) : from.value;
      settings[name] = Number(value.toFixed(4));
    };

    consider("vignette", reference.vignette, target?.vignette);
    consider("ca_lateral", reference.aberration, target?.aberration);
    consider("grain_scale", reference.grain, target?.grain);
    consider("halation_scale", reference.halation, target?.halation);
    // Size is a property of the grain, not an amount, so it is never a
    // difference — a coarse grain does not become fine by adding more.
    if (reference.grainSize.confidence >= floor) {
      settings.grain_size = Number(reference.grainSize.value.toFixed(4));
    }

    return json({
      settings,
      skipped,
      reference,
      ...(target ? { target } : {}),
      note:
        Object.keys(settings).length === 0
          ? "This frame could not measure anything confidently. Try one with midtone, edges away from the centre, and a clipped highlight."
          : request.targetAssetId
            ? "These are differences — what to add to the target so the reference's camera appears to have shot it."
            : "These are the reference's own values, to apply to a shot that has none of its own.",
    });
  };
}
