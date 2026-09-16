import {
  DEFAULT_DEPTH,
  SeedError,
  TRANSFORM_ORDER,
  TRANSFORM_PRESETS,
  TransformPresetSchema,
  depthFor,
  transformKeyframePrompt,
  transformPrompt,
} from "@seed-ae/domain";
import { z } from "zod";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { resolveStorageUri } from "@seed-ae/storage";
import { extractFrame } from "../media/frame.js";
import { plateAgreement } from "../media/agreement.js";
import { adoptFileIntoLibrary } from "./assets.js";
import {
  aspectOf,
  defaultProvider,
  imageProvider,
  sizeFor,
} from "./restore.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Transformation — the same plate, in a different season, hour or weather.
 *
 * Shares restoration's wire exactly, and for the same reasons: no duration, no
 * aspect ratio, the clip pinned to a `reference` role, and a key frame sent as
 * a second reference rather than a first frame. Those omissions are what keep
 * Ark classifying the request as an *edit*, which is the only thing tying the
 * output to the source rather than letting it become a new shot of an
 * arbitrary length. See `startRestoreRoute` for the long version.
 *
 * What differs is the prompt — see `transformPrompt`, which separates the one
 * axis that may change from the invariants that may not — and one addition
 * that restoration had no need of: **this route can measure its own output
 * against the plate**. Restoration is judged by eye because "is it sharper" is
 * a taste question. A transformation is judged by wiping it against the
 * original, and "did anything move" is not a taste question at all. So it gets
 * a number, and the artist gets it before the expensive half of the job.
 */

const StartTransformSchema = z.object({
  /** The plate. Travels as a reference, never as a frame. */
  sourceAssetId: z.string().min(1),
  /**
   * What changes — the artist's own words, not a preset id.
   *
   * A preset only fills this field in the panel. By the time it arrives here
   * it is text the artist has seen and can have edited, which is the
   * difference between a control and a hidden prompt.
   */
  change: z.string().min(1).max(2000),
  /** Which preset it started from, recorded so a render can be found again. */
  preset: TransformPresetSchema.optional(),
  /**
   * How far into the scene the change reaches, 0 to 100.
   *
   * Prompt strength, not an API parameter — Ark documents no weight for a
   * reference video, and asserting one would be inventing a contract. Note
   * that this is *not* restoration's freedom slider under a new name: freedom
   * licensed the whole picture, depth licenses one axis, and the plate lock
   * holds at every value of this one.
   */
  depth: z.number().min(0).max(100).default(DEFAULT_DEPTH),
  /** What the plate *is* — a place, a period, a time of year. */
  note: z.string().max(600).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  size: z.string().optional(),
  /** A transformed still to render towards, from `/v1/transform/keyframe`. */
  keyframeAssetId: z.string().min(1).optional(),
  seed: z.union([z.number().int(), z.string()]).optional(),
  project: z.string().min(1).optional(),
});

export function startTransformRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(StartTransformSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);

    if (source.kind !== "video") {
      throw new SeedError(
        "bad_request",
        `a transformation works on a plate, and ${source.filename} is ${source.kind}. ` +
          "Capture the work area rather than a single frame.",
      );
    }

    const providerId = request.providerId ?? defaultProvider(deps);
    if (!providerId) {
      throw new SeedError(
        "unsupported_capability",
        "Transforming a plate needs Seedance. Set ARK_API_KEY and a Seedance " +
          "model id under Keys.",
      );
    }

    const capabilities = await deps.registry.get(providerId).capabilities();
    if (!capabilities.videoReferences) {
      throw new SeedError(
        "unsupported_capability",
        `${capabilities.displayName} does not take a clip as a reference, and a ` +
          "transformation is the plate as a reference plus one named change.",
      );
    }

    const job = await deps.generation.start(
      {
        providerId,
        ...(request.model ? { model: request.model } : {}),
        operation: "video.generate",
        prompt: transformPrompt(request.change, {
          depth: request.depth,
          ...(request.note ? { note: request.note } : {}),
        }),
        ...(request.seed !== undefined && capabilities.seed
          ? { seed: request.seed }
          : {}),
        ...sizeFor(request.size, capabilities.sizes, aspectOf(source)),
        inputAssetIds: [
          source.id,
          ...(request.keyframeAssetId ? [request.keyframeAssetId] : []),
        ],
        inputRoles: request.keyframeAssetId
          ? ["reference", "reference"]
          : ["reference"],
        itemMentions: [],
        parentAssetId: source.id,
        ...(request.project ? { project: request.project } : {}),
        parameters: {
          seedTransform: request.preset ?? "custom",
          seedTransformSource: source.id,
          seedTransformChange: request.change,
          seedTransformDepth: request.depth,
          seedTransformDepthBand: depthFor(request.depth).label,
          ...(request.keyframeAssetId
            ? { seedTransformKeyframe: request.keyframeAssetId }
            : {}),
          ...(request.note?.trim() ? { seedTransformNote: request.note.trim() } : {}),
        },
      },
      `transform_${request.preset ?? "custom"}_${source.id}`,
    );

    return json(
      {
        started: [
          {
            preset: request.preset ?? "custom",
            job: { job: job.job, generation: job.generation, outputs: [] as never[] },
          },
        ],
      },
      202,
    );
  };
}

const TransformKeyframeSchema = z.object({
  sourceAssetId: z.string().min(1),
  /** Where in the plate to take the frame. */
  atSeconds: z.number().min(0).default(0),
  change: z.string().min(1).max(2000),
  depth: z.number().min(0).max(100).default(DEFAULT_DEPTH),
  note: z.string().max(600).optional(),
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  size: z.string().optional(),
  seed: z.union([z.number().int(), z.string()]).optional(),
  project: z.string().min(1).optional(),
});

/**
 * One frame of the plate, transformed by the image model.
 *
 * The same two-step as restoration and for the same measured reason: a video
 * model in edit mode cannot exceed what its source resolved, so the quality
 * has to come from an image model and the video pass animates towards it.
 *
 * It earns its keep twice over here. A transformation is the step most likely
 * to go wrong in a way that is expensive to discover, so judging one still —
 * seconds, and nearly free — before paying for a clip is worth more than it
 * was for a restoration. And the extracted plate frame is kept as an asset,
 * which is what makes `/v1/transform/agreement` possible: the comparison needs
 * the exact frame that was transformed, not a frame near it.
 */
export function transformKeyframeRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(TransformKeyframeSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);

    if (source.kind !== "video") {
      throw new SeedError(
        "bad_request",
        `a key frame comes out of a clip, and ${source.filename} is ${source.kind}.`,
      );
    }

    const providerId = request.providerId ?? imageProvider(deps);
    if (!providerId) {
      throw new SeedError(
        "unsupported_capability",
        "Transforming a key frame needs Seedream. Set ARK_API_KEY and a " +
          "Seedream model id under Keys.",
      );
    }
    const capabilities = await deps.registry.get(providerId).capabilities();
    if (!capabilities.imageToImage) {
      throw new SeedError(
        "unsupported_capability",
        `${capabilities.displayName} cannot render from an existing image.`,
      );
    }

    const scratch = await mkdtemp(nodePath.join(tmpdir(), "seed transform "));
    const file = nodePath.join(
      scratch,
      `${nodePath.parse(source.filename).name} f${Math.round(request.atSeconds * 1000)}.png`,
    );
    await extractFrame(resolveStorageUri(deps.workspace, source.storageUri), file, {
      atSeconds: request.atSeconds,
      env: process.env,
    });
    const frame = await adoptFileIntoLibrary(deps, file, request.project);

    const job = await deps.generation.start(
      {
        providerId,
        ...(request.model ? { model: request.model } : {}),
        operation: "image.edit",
        prompt: transformKeyframePrompt(request.change, {
          depth: request.depth,
          ...(request.note ? { note: request.note } : {}),
        }),
        ...(request.seed !== undefined && capabilities.seed
          ? { seed: request.seed }
          : {}),
        ...sizeFor(request.size, capabilities.sizes, aspectOf(frame)),
        inputAssetIds: [frame.id],
        inputRoles: ["reference"],
        itemMentions: [],
        parentAssetId: frame.id,
        ...(request.project ? { project: request.project } : {}),
        parameters: {
          seedTransformKeyframe: true,
          seedTransformSource: source.id,
          seedTransformPlateFrame: frame.id,
          seedKeyframeAt: request.atSeconds,
          seedTransformChange: request.change,
          seedTransformDepth: request.depth,
          ...(request.note?.trim() ? { seedTransformNote: request.note.trim() } : {}),
        },
      },
      `transform_keyframe_${source.id}`,
    );

    return json(
      {
        frame,
        job: { job: job.job, generation: job.generation, outputs: [] as never[] },
      },
      202,
    );
  };
}

const AgreementSchema = z.object({
  /** The plate frame — what was handed to the model. */
  plateAssetId: z.string().min(1),
  /** What came back. An image, or a clip to sample. */
  resultAssetId: z.string().min(1),
  /** Where to sample, when the result is a clip. */
  atSeconds: z.number().min(0).optional(),
  /** Grid across the frame. More tiles localise better and cost more. */
  grid: z.number().int().min(2).max(24).optional(),
});

/**
 * How far the picture moved — the answer to the question a review actually asks.
 *
 * A transformed plate is reviewed by wiping against the original, and what
 * gets work rejected is never the season; it is a roof line that slid, a
 * horizon that rose, a face that became someone else's. This measures that
 * directly and reports it in plate pixels, with the worst region named.
 *
 * Deliberately **not** a similarity score. A correct summer-to-winter
 * transformation is supposed to be dissimilar — bare branches carry far more
 * edge detail than foliage, snow erases ground texture entirely — so scoring
 * similarity would punish the model for doing the job and argue for the timid
 * result over the right one. See `plateAgreement` for what it measures
 * instead, and for why tiles with nothing in them are excluded rather than
 * averaged in.
 */
export function agreementRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(AgreementSchema, await readJsonBody(req));
    const plate = deps.assets.requireById(request.plateAssetId);
    const result = deps.assets.requireById(request.resultAssetId);

    if (plate.kind !== "image") {
      throw new SeedError(
        "bad_request",
        `the plate side of a comparison is the frame that was transformed, and ` +
          `${plate.filename} is ${plate.kind}.`,
      );
    }

    const platePath = resolveStorageUri(deps.workspace, plate.storageUri);
    const scratch = await mkdtemp(nodePath.join(tmpdir(), "seed agreement "));

    /*
     * A clip is sampled rather than refused. The obvious use is comparing the
     * key frame to its plate, but the same question is worth asking of the
     * finished animation — and there the interesting sample is rarely the
     * first frame, because drift accumulates.
     */
    let resultPath = resolveStorageUri(deps.workspace, result.storageUri);
    if (result.kind === "video") {
      const sampled = nodePath.join(scratch, "result.png");
      await extractFrame(resultPath, sampled, {
        atSeconds: request.atSeconds ?? 0,
        env: process.env,
      });
      resultPath = sampled;
    }

    const agreement = await plateAgreement(platePath, resultPath, {
      ...(request.grid ? { grid: request.grid } : {}),
      // The asset record knows the plate's real width, so displacement comes
      // back in the pixels the artist is looking at.
      ...(plate.width ? { plateWidth: plate.width } : {}),
      env: process.env,
    });

    return json({
      plate: { id: plate.id, filename: plate.filename },
      result: { id: result.id, filename: result.filename, kind: result.kind },
      ...(result.kind === "video" ? { atSeconds: request.atSeconds ?? 0 } : {}),
      agreement,
    });
  };
}

/**
 * The change presets, as starting text rather than hidden prompts.
 *
 * Served rather than duplicated in the panel because the panel drops the
 * `change` straight into an editable field: what the artist sees is what gets
 * sent, and there is one author for the wording.
 */
export function transformPresetsRoute() {
  return () =>
    json({
      presets: TRANSFORM_ORDER.map((id) => {
        const preset = TRANSFORM_PRESETS[id];
        return {
          id,
          label: preset.label,
          purpose: preset.purpose,
          change: preset.change,
        };
      }),
    });
}
