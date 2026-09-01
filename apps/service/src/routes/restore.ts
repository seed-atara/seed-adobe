import {
  RESTORE_ORDER,
  RESTORE_PRESETS,
  RestoreTreatmentSchema,
  SeedError,
  bestQualitySize,
  restorePrompt,
} from "@seed-ae/domain";
import { z } from "zod";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Restoration — archive footage made usable without being changed.
 *
 * The route is deliberately thin, because almost everything that makes a
 * restoration different from a generation is expressed by what it *does not*
 * send:
 *
 *   no duration    — Seedance reads a reference clip with no stated duration as
 *                    an edit and sends `duration: -1`, which makes the output
 *                    follow the input's length exactly. Stating a duration is
 *                    how a restoration silently becomes a re-cut.
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
  treatments: z.array(RestoreTreatmentSchema).min(1).max(4),
  /** What the footage *is* — a period, a place, the colour of a uniform. */
  note: z.string().max(600).optional(),
  /** Defaults to the first Seedance the registry has. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** Resolution tier. Defaults to the best the provider offers. */
  size: z.string().optional(),
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

    const started = [];
    for (const treatment of request.treatments) {
      const job = await deps.generation.start(
        {
          providerId,
          ...(request.model ? { model: request.model } : {}),
          operation: "video.generate",
          prompt: restorePrompt(treatment, request.note),
          ...(request.seed !== undefined && capabilities.seed
            ? { seed: request.seed }
            : {}),
          ...sizeFor(request.size, capabilities.sizes),
          inputAssetIds: [source.id],
          /*
           * The whole guarantee, in one field. A lone clip is already read as a
           * reference by the Seedance adapter, but saying so explicitly is what
           * stops a later change to that inference turning every restoration
           * into an animation of its own first frame.
           */
          inputRoles: ["reference"],
          itemMentions: [],
          parentAssetId: source.id,
          ...(request.project ? { project: request.project } : {}),
          parameters: {
            /* What makes a restoration findable, and re-runnable. */
            seedRestore: treatment,
            seedRestoreSource: source.id,
            ...(request.note?.trim() ? { seedRestoreNote: request.note.trim() } : {}),
          },
        },
        `restore_${treatment}_${source.id}`,
      );

      started.push({
        treatment,
        /** The same shape /v1/generations returns, so the panel can reuse it. */
        job: { job: job.job, generation: job.generation, outputs: [] as never[] },
      });
    }

    return json({ started }, 202);
  };
}

/**
 * The treatments, with what each can promise.
 *
 * Served rather than duplicated in the panel so the fidelity wording — the
 * sentence an artist reads before committing a shot to a cut — has exactly one
 * author.
 */
export function restorePresetsRoute() {
  return () =>
    json({
      presets: RESTORE_ORDER.map((treatment) => {
        const preset = RESTORE_PRESETS[treatment];
        return {
          treatment,
          label: preset.label,
          purpose: preset.purpose,
          fidelity: preset.fidelity,
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
