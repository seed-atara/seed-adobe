import { SeedError } from "@seed-ae/domain";
import { z } from "zod";
import {
  applyLighting,
  compositeOver,
  expandFromShot,
  fullMatte,
  lightingFromEnvironment,
  matteCoverage,
  matteFromDepth,
  measureCoverage,
  normalsFromDepth,
  resize,
  type RasterImage,
} from "@seed-ae/media";
import { estimateDepth } from "../passes/depth.js";
import { keepImage, stillFor } from "./passes.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Expanding a shot, and switching what is around the subject.
 *
 * Two features whose commercial equivalents — Luma Reframe and Beeble SwitchX —
 * both work by inventing pixels. These do the measurable part first and only
 * hand over what genuinely has to be imagined.
 */

/** `16:9`, `21:9`, or a plain number. Named aspects are how people speak. */
const AspectSchema = z.union([z.string().min(3), z.number().positive()]);

function aspectValue(input: string | number): number {
  if (typeof input === "number") return input;
  const match = /^(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)$/.exec(input.trim());
  if (!match) {
    throw new SeedError(
      "bad_request",
      `aspect must be like "16:9" or a number, received "${input}"`,
    );
  }
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (h === 0) throw new SeedError("bad_request", "aspect height cannot be zero");
  return w / h;
}

const RectSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
});

const ExpandSchema = z.object({
  /**
   * The shot, in order, as stills.
   *
   * Frames rather than a clip because nothing here decodes video. After Effects
   * can render a sequence and `POST /v1/ae/register-capture` puts each one in
   * the library, which is the route that exists today.
   */
  frameAssetIds: z.array(z.string().min(1)).min(1).max(600),
  aspect: AspectSchema,
  /** Where the original sits in the new canvas. Defaults to centred. */
  sourceRect: RectSchema.optional(),
  minConfidence: z.number().min(0).max(1).default(0.15),
  project: z.string().min(1).optional(),
});

async function loadFrames(deps: AppDeps, ids: string[]): Promise<RasterImage[]> {
  const frames: RasterImage[] = [];
  for (const id of ids) frames.push(await stillFor(deps, id));

  const first = frames[0] as RasterImage;
  return frames.map((frame) =>
    frame.width === first.width && frame.height === first.height
      ? frame
      : resize(frame, first.width, first.height),
  );
}

/** Turns the numbers into the sentence an artist actually decides on. */
function verdictFor(coverage: number, travelX: number, travelY: number): string {
  if (travelX === 0 && travelY === 0) {
    return "This shot never moves, so none of the new area was ever photographed. Expansion here is pure invention — send it straight to a generator.";
  }
  if (coverage >= 0.85) {
    return "Almost all of the new area is recoverable from the footage itself. Recover it and there is little left to invent.";
  }
  if (coverage >= 0.4) {
    return "A useful share of the new area was photographed. Recover that and hand the remainder over, rather than inventing the whole edge.";
  }
  if (coverage > 0.05) {
    return "The camera moved, but not far enough to cover much of the new area. Recovery will help at one edge only — check the per-edge numbers.";
  }
  return "The camera moved, but not across the area being added. A generator will have to invent nearly all of it.";
}

/**
 * How much of an expansion the footage can pay for.
 *
 * The cheap question asked before the expensive one. Luma bills per source
 * second whether or not the result was recoverable for free, so knowing the
 * number first is worth something on its own — and where coverage is high, the
 * generator is being asked to finish a picture instead of imagine one.
 */
export function expandCoverageRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(ExpandSchema, await readJsonBody(req));
    const frames = await loadFrames(deps, request.frameAssetIds);

    const coverage = measureCoverage(
      frames,
      {
        aspect: aspectValue(request.aspect),
        ...(request.sourceRect ? { sourceRect: request.sourceRect } : {}),
      },
      { minConfidence: request.minConfidence },
    );

    return json({
      coverage,
      verdict: verdictFor(coverage.coverage, coverage.travel.x, coverage.travel.y),
    });
  };
}

/**
 * The recovered plate, and the hole that is left.
 *
 * Fills the expanded canvas with pixels the camera actually saw, and returns
 * the remainder as a mask. Both are registered, so the mask can be handed to a
 * generator and the result carries its lineage like anything else.
 */
export function expandRecoverRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(ExpandSchema, await readJsonBody(req));
    const frames = await loadFrames(deps, request.frameAssetIds);
    const source = deps.assets.requireById(request.frameAssetIds[0] as string);
    const stem = source.filename.replace(/\.[^.]+$/, "");

    const result = expandFromShot(
      frames,
      {
        aspect: aspectValue(request.aspect),
        ...(request.sourceRect ? { sourceRect: request.sourceRect } : {}),
      },
      { minConfidence: request.minConfidence },
    );

    const plate = await keepImage(
      deps,
      result.mosaic,
      `${stem}_expanded.png`,
      request.project,
    );
    const residual = await keepImage(
      deps,
      result.residual,
      `${stem}_expanded_residual.png`,
      request.project,
    );

    deps.logger.info("expand.recovered", {
      sourceAssetId: source.id,
      coverage: result.coverage.coverage,
      framesUsed: result.coverage.framesUsed,
      framesRejected: result.coverage.framesRejected,
    });

    return json(
      {
        coverage: result.coverage,
        verdict: verdictFor(
          result.coverage.coverage,
          result.coverage.travel.x,
          result.coverage.travel.y,
        ),
        plate,
        residual,
      },
      201,
    );
  };
}

const SwitchSchema = z.object({
  sourceAssetId: z.string().min(1),
  /** The new surroundings. Drives both the backdrop and the light on the subject. */
  referenceAssetId: z.string().min(1),
  /**
   * Which pixels are kept.
   *
   * `auto` derives the matte from measured depth, `custom` uses one supplied,
   * `fill` keeps the whole frame and relights it without replacing anything.
   */
  alphaMode: z.enum(["auto", "custom", "fill"]).default("auto"),
  alphaAssetId: z.string().min(1).optional(),
  /** Softens the matte edge, in pixels. */
  feather: z.number().min(0).max(64).default(2),
  /** How near is bright in the depth pass. */
  nearIsBright: z.boolean().default(true),
  /** Manual depth cut, 0–255. Otsu picks one when this is omitted. */
  threshold: z.number().min(0).max(255).optional(),
  /** How fully the reference's light is imposed, 0..1. */
  lightAmount: z.number().min(0).max(1).default(0.85),
  /** How much of the sphere the reference plate is taken to speak for. */
  wrap: z.number().min(0.1).max(1).default(0.6),
  exposure: z.number().min(0.1).max(4).default(1),
  /** Relief scale when normals are derived for the relight. */
  strength: z.number().min(0.25).max(16).default(4),
  model: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
});

/**
 * Switch the surroundings, keep the performance.
 *
 * The same job Beeble's SwitchX does, done by measurement instead of
 * generation, which changes what it can promise:
 *
 * - The light on the subject is **solved** from the reference — the plate is
 *   projected onto nine spherical harmonics and those coefficients shade the
 *   subject's own normals. Nothing about the subject is resynthesised, so
 *   identity cannot drift, because there is no identity being guessed at.
 * - The matte is **measured** from depth rather than inferred, and can be
 *   replaced wholesale by a roto or a key the artist already trusts.
 * - The matte comes back as its own asset, so the result is a comp with parts
 *   rather than a flat render.
 *
 * What it does *not* do, plainly: it cannot invent a wardrobe, add contact
 * shadows the geometry does not imply, or repair a subject the matte cut badly.
 * Second-order harmonics carry soft light and no hard shadow edge — the
 * residual is returned so a reference whose lighting this cannot express says
 * so instead of quietly producing a wrong answer. Where the job is genuinely
 * "invent a new scene", a generator is the right tool and this is not it.
 */
export function switchRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(SwitchSchema, await readJsonBody(req));
    if (request.alphaMode === "custom" && !request.alphaAssetId) {
      throw new SeedError(
        "bad_request",
        'alphaAssetId is required when alphaMode is "custom"',
      );
    }

    const source = deps.assets.requireById(request.sourceAssetId);
    const still = await stillFor(deps, request.sourceAssetId);
    const reference = await stillFor(deps, request.referenceAssetId);
    const stem = source.filename.replace(/\.[^.]+$/, "");

    // 1. The matte: what survives.
    let matte: RasterImage;
    if (request.alphaMode === "fill") {
      matte = fullMatte(still.width, still.height);
    } else if (request.alphaMode === "custom") {
      const supplied = await stillFor(deps, request.alphaAssetId as string);
      matte =
        supplied.width === still.width && supplied.height === still.height
          ? supplied
          : resize(supplied, still.width, still.height);
    } else {
      const depth = await estimateDepth(still, request.model);
      matte = matteFromDepth(depth, {
        nearIsBright: request.nearIsBright,
        feather: request.feather,
        ...(request.threshold !== undefined ? { threshold: request.threshold } : {}),
      });
    }

    // 2. The light, solved off the reference rather than described in a prompt.
    const lighting = lightingFromEnvironment(reference, {
      wrap: request.wrap,
      exposure: request.exposure,
    });

    /*
     * 3. Shade the subject with its own surface.
     *
     * Normals come from measured depth, so the shading follows the actual
     * geometry of the shot. The source frame stands in for albedo, which is an
     * approximation and a known one: a lit plate carries its original light,
     * so a full-strength transfer double-lights it. That is what `lightAmount`
     * is for, and why it defaults below 1.
     */
    const depthForNormals = await estimateDepth(still, request.model);
    const normals = normalsFromDepth(depthForNormals, request.strength, {
      image: still,
    });
    const relit = applyLighting(still, normals, lighting, request.lightAmount);

    // 4. Put it in the new surroundings.
    const render =
      request.alphaMode === "fill" ? relit : compositeOver(relit, matte, reference);

    const renderAsset = await keepImage(
      deps,
      render,
      `${stem}_switch.png`,
      request.project,
    );
    const matteAsset = await keepImage(
      deps,
      matte,
      `${stem}_switch_matte.png`,
      request.project,
    );

    const kept = matteCoverage(matte);
    deps.logger.info("switch.rendered", {
      sourceAssetId: source.id,
      referenceAssetId: request.referenceAssetId,
      alphaMode: request.alphaMode,
      matteCoverage: kept,
      lightingResidual: lighting.residual,
    });

    return json(
      {
        render: renderAsset,
        matte: matteAsset,
        alphaMode: request.alphaMode,
        matteCoverage: kept,
        lighting: {
          residual: lighting.residual,
          samples: lighting.samples,
          /*
           * Surfaced rather than buried: a high residual means the reference's
           * lighting is not something nine harmonics can express — a hard
           * shadow edge, most often — and the relight will be soft where the
           * reference is sharp.
           */
          expressible: lighting.residual < 0.12,
        },
        /*
         * Optics are the other half of matching two shots and are deliberately
         * a separate step, because a shot that already has grain does not want
         * the reference's grain on top of its own.
         */
        optics: {
          route: "/v1/passes/camera-transfer",
          note: "Measure and transfer vignette, aberration, grain and halation separately.",
        },
      },
      201,
    );
  };
}
