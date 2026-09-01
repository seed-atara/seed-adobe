import {
  DEFAULT_FREEDOM,
  RESTORE_ORDER,
  RESTORE_PRESETS,
  RestorePresetSchema,
  SeedError,
  bestQualitySize,
  restorePrompt,
} from "@seed-ae/domain";
import { z } from "zod";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { resolveStorageUri } from "@seed-ae/storage";
import { keyframePrompt } from "@seed-ae/domain";
import { extractFrame } from "../media/frame.js";
import { adoptFileIntoLibrary } from "./assets.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Restoration — crappy footage re-rendered at the quality it should have had.
 *
 * The route is deliberately thin. What makes a restoration different from a
 * generation is the prompt shape (see `restorePrompt`) and what this does
 * *not* send:
 *
 *   no duration    — Ark classifies a request carrying a reference clip by
 *                    what the prompt asks for, and only an *edit* may send
 *                    `duration: -1`, which is what keeps the result attached
 *                    to the source rather than becoming a new shot of an
 *                    arbitrary length. Stating a duration forfeits that.
 *   no aspect      — for the same reason. The ratio follows the clip.
 *   no first frame — the role is pinned to `reference`. A still handed over as
 *                    a first frame anchors the opening and lets the model
 *                    animate away from it, which is the one thing a
 *                    restoration must never do.
 *
 * Those three omissions are the feature, and each is a one-line change from
 * being undone. What it *does* send is the top of the provider's resolution
 * ladder — that is the upscale.
 *
 * Everything else is the ordinary job machinery, which is the point: a
 * restored clip lands in the library with a recipe and a parent like anything
 * else, so it can be found, compared and traced back to the footage it came
 * from.
 */

const StartRestoreSchema = z.object({
  /** The clip to restore. Travels as a reference, never as a frame. */
  sourceAssetId: z.string().min(1),
  /**
   * The look to render — stock, optics, grain, palette, era.
   *
   * The artist's own words, not a preset id. A preset only fills this field in
   * the panel; by the time it arrives here it is text the artist has seen and
   * can have edited, which is the difference between a control and a hidden
   * prompt.
   */
  look: z.string().min(1).max(2000),
  /** Which preset it started from, recorded so a render can be found again. */
  preset: RestorePresetSchema.optional(),
  /**
   * How far the render may depart from the source, 0 to 100.
   *
   * Prompt strength, not an API parameter — Ark documents no weight for a
   * reference video, and asserting one would be inventing a contract. It
   * selects the latitude wording; the framing, camera and timing stay held at
   * every value.
   */
  freedom: z.number().min(0).max(100).default(DEFAULT_FREEDOM),
  /** What the footage *is* — a period, a place, the colour of a uniform. */
  note: z.string().max(600).optional(),
  /** Defaults to the first Seedance the registry has. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** Resolution tier. Defaults to the best the provider offers. */
  size: z.string().optional(),
  /**
   * A sharp still to render *towards*, made by `/v1/restore/keyframe`.
   *
   * Travels as a `reference_image` beside the clip's `reference_video` —
   * verified to combine. Not a `first_frame`: frames are refused beside
   * reference media, and the clip has to be reference media for its motion to
   * be read at all.
   */
  keyframeAssetId: z.string().min(1).optional(),
  seed: z.union([z.number().int(), z.string()]).optional(),
  project: z.string().min(1).optional(),
});

export function startRestoreRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(StartRestoreSchema, await readJsonBody(req));
    const source = deps.assets.requireById(request.sourceAssetId);

    if (source.kind !== "video") {
      throw new SeedError(
        "bad_request",
        `a restoration works on a clip, and ${source.filename} is ${source.kind}. ` +
          "Capture the work area rather than a single frame.",
      );
    }

    const providerId = request.providerId ?? defaultProvider(deps);
    if (!providerId) {
      throw new SeedError(
        "unsupported_capability",
        "Restoring a clip needs Seedance. Set ARK_API_KEY and a Seedance model " +
          "id under Keys.",
      );
    }

    const capabilities = await deps.registry.get(providerId).capabilities();
    /*
     * Checked here rather than left to the generation service, which would
     * refuse each job separately and report it as a failed render. A
     * restoration is nothing but a clip as a reference, so a provider that
     * cannot take one is a wrong choice rather than a failure.
     */
    if (!capabilities.videoReferences) {
      throw new SeedError(
        "unsupported_capability",
        `${capabilities.displayName} does not take a clip as a reference, and a ` +
          "restoration is nothing but a clip as a reference.",
      );
    }

    const job = await deps.generation.start(
      {
        providerId,
        ...(request.model ? { model: request.model } : {}),
        operation: "video.generate",
        prompt: restorePrompt(request.look, {
          freedom: request.freedom,
          ...(request.note ? { note: request.note } : {}),
        }),
        ...(request.seed !== undefined && capabilities.seed
          ? { seed: request.seed }
          : {}),
        ...sizeFor(request.size, capabilities.sizes),
        inputAssetIds: [
          source.id,
          ...(request.keyframeAssetId ? [request.keyframeAssetId] : []),
        ],
        /*
         * The whole guarantee, in one field. A lone clip is already read as a
         * reference by the Seedance adapter, but saying so explicitly is what
         * stops a later change to that inference turning every restoration
         * into an animation of its own first frame.
         */
        inputRoles: request.keyframeAssetId
          ? ["reference", "reference"]
          : ["reference"],
        itemMentions: [],
        parentAssetId: source.id,
        ...(request.project ? { project: request.project } : {}),
        parameters: {
          /* What makes a restoration findable, and re-runnable. */
          seedRestore: request.preset ?? "custom",
          seedRestoreSource: source.id,
          seedRestoreLook: request.look,
          seedRestoreFreedom: request.freedom,
          ...(request.keyframeAssetId
            ? { seedRestoreKeyframe: request.keyframeAssetId }
            : {}),
          ...(request.note?.trim() ? { seedRestoreNote: request.note.trim() } : {}),
        },
      },
      `restore_${request.preset ?? "custom"}_${source.id}`,
    );

    const started = [
      {
        preset: request.preset ?? "custom",
        /** The same shape /v1/generations returns, so the panel can reuse it. */
        job: { job: job.job, generation: job.generation, outputs: [] as never[] },
      },
    ];

    return json({ started }, 202);
  };
}

const KeyframeSchema = z.object({
  /** The clip to take a frame from. */
  sourceAssetId: z.string().min(1),
  /** Where in the clip. The middle is usually more representative than 0. */
  atSeconds: z.number().min(0).default(0),
  /** The look to render towards — the artist's own words. */
  look: z.string().min(1).max(2000),
  /** What the footage is, as background. */
  note: z.string().max(600).optional(),
  /** The image provider. Defaults to the first Seedream configured. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  size: z.string().optional(),
  seed: z.union([z.number().int(), z.string()]).optional(),
  project: z.string().min(1).optional(),
});

/**
 * One frame of the clip, rendered properly by an image model.
 *
 * This is where the detail comes from, and it is the half of the feature that
 * was missing. A video model handed a degraded clip re-renders it and cannot
 * exceed what the source resolved — held faithful it adds grain and calls it
 * detail, turned loose it melts faces, and neither beats scaling the clip in
 * After Effects. Seedream given the same frame paints a real photograph of the
 * scene, because that is what image models are for.
 *
 * Deliberately a separate request from the animation. A still comes back in
 * seconds and costs almost nothing, so the expensive part is only paid for
 * once the artist has looked at what the quality will actually be.
 *
 * The extracted frame is registered as an asset in its own right rather than
 * kept in a temp file: it is the input to a generation, so lineage has to be
 * able to point at it.
 */
export function keyframeRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(KeyframeSchema, await readJsonBody(req));
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
        "Making a key frame needs Seedream. Set ARK_API_KEY and a Seedream " +
          "model id under Keys.",
      );
    }
    const capabilities = await deps.registry.get(providerId).capabilities();
    if (!capabilities.imageToImage) {
      throw new SeedError(
        "unsupported_capability",
        `${capabilities.displayName} cannot render from an existing image.`,
      );
    }

    // Pulled at native resolution into a temp file, then adopted — which
    // copies it into the library and gives it an id, a thumbnail and a path
    // the materializer can reach.
    const scratch = await mkdtemp(nodePath.join(tmpdir(), "seed keyframe "));
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
        prompt: keyframePrompt(request.look, request.note),
        ...(request.seed !== undefined && capabilities.seed
          ? { seed: request.seed }
          : {}),
        ...sizeFor(request.size, capabilities.sizes),
        inputAssetIds: [frame.id],
        inputRoles: ["reference"],
        itemMentions: [],
        parentAssetId: frame.id,
        ...(request.project ? { project: request.project } : {}),
        parameters: {
          seedKeyframe: true,
          seedRestoreSource: source.id,
          seedKeyframeAt: request.atSeconds,
          seedRestoreLook: request.look,
          ...(request.note?.trim() ? { seedRestoreNote: request.note.trim() } : {}),
        },
      },
      `keyframe_${source.id}`,
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

/** The Seedream to use when the panel did not name one. */
function imageProvider(deps: AppDeps): string | undefined {
  return deps.registry.ids().find((id) => id.startsWith("seedream"));
}

/**
 * The look presets, as starting text rather than hidden prompts.
 *
 * Served rather than duplicated in the panel because the panel drops the
 * `look` straight into an editable field: what the artist sees is what gets
 * sent, and there is one author for the wording.
 */
export function restorePresetsRoute() {
  return () =>
    json({
      presets: RESTORE_ORDER.map((id) => {
        const preset = RESTORE_PRESETS[id];
        return {
          id,
          label: preset.label,
          purpose: preset.purpose,
          look: preset.look,
        };
      }),
    });
}

/**
 * The best resolution tier the provider offers, unless one was asked for.
 *
 * Upscaling is the point, so the default is the top of the ladder rather than
 * the provider's own default — which on Seedance is the bottom, and would make
 * a "restoration" that came back smaller than it went in.
 */
function sizeFor(requested: string | undefined, sizes: string[]): { size?: string } {
  if (requested) return { size: requested };
  const best = bestQualitySize(sizes);
  return best ? { size: best } : {};
}

/**
 * The Seedance to use when the panel did not name one.
 *
 * Matched on the id prefix because that is what `seedanceProviderId` builds
 * from a model name, and a registry may hold several — 2.0 and 2.5 are
 * registered separately, and either can restore.
 */
function defaultProvider(deps: AppDeps): string | undefined {
  return deps.registry.ids().find((id) => id.startsWith("seedance"));
}
