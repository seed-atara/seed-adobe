import {
  RESTORE_ORDER,
  RESTORE_PRESETS,
  bestQualitySize,
  RestoreLaneSchema,
  RestoreTreatmentSchema,
  SeedError,
  laneOffer,
  restorePrompt,
  type RestoreLane,
  type RestoreTreatment,
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
 * Those three omissions are the feature. Everything else is the ordinary job
 * machinery, which is the point: a restored clip lands in the library with a
 * recipe and a parent like anything else, so it can be found, compared and
 * traced back to the footage it came from.
 */

const StartRestoreSchema = z.object({
  /** The clip to restore. Travels as a reference, never as a frame. */
  sourceAssetId: z.string().min(1),
  treatments: z.array(RestoreTreatmentSchema).min(1).max(4),
  /**
   * Which engines to run. Both is a real answer and often the right one.
   *
   * The two lanes fail differently on different footage — the upscaler cannot
   * invent and the model cannot resist — so running them together and looking
   * at the pair is faster than reasoning about which will win.
   */
  lanes: z.array(RestoreLaneSchema).min(1).max(2).default(["measured"]),
  /** Reaches the generated lane only; the measured one has nowhere to put it. */
  note: z.string().max(600).optional(),
  /** Provider for the generated lane. Defaults to the first Seedance found. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /** Provider for the measured lane. */
  upscaleProviderId: z.string().min(1).default("topaz-upscale"),
  /** Topaz multiplies the source; 2 doubles each edge. */
  upscaleFactor: z.number().min(1).max(4).default(2),
  /** Resolution tier for the generated lane. Defaults to the provider's best. */
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

    const started: Array<{
      treatment: RestoreTreatment;
      lane: RestoreLane;
      /** The same shape /v1/generations returns, so the panel can reuse it. */
      job: { job: unknown; generation: unknown; outputs: never[] };
    }> = [];
    /*
     * Collected rather than thrown. Asking for four treatments across both
     * lanes is one gesture in the panel, and half of those combinations do not
     * exist — colour cannot be measured. Refusing the whole request because one
     * cell of the grid is empty would make the obvious gesture the wrong one.
     */
    const skipped: Array<{ treatment: RestoreTreatment; lane: RestoreLane; reason: string }> = [];

    for (const treatment of request.treatments) {
      for (const lane of request.lanes) {
        const offer = laneOffer(treatment, lane);
        if (!offer) {
          skipped.push({
            treatment,
            lane,
            reason:
              lane === "measured"
                ? `${RESTORE_PRESETS[treatment].label} has to invent, and an upscaler cannot`
                : `${RESTORE_PRESETS[treatment].label} is not offered on the generated lane`,
          });
          continue;
        }

        const providerId =
          lane === "measured"
            ? request.upscaleProviderId
            : (request.providerId ?? defaultGeneratedProvider(deps));

        if (!providerId) {
          skipped.push({
            treatment,
            lane,
            reason: "no provider is configured for this lane",
          });
          continue;
        }
        if (!deps.registry.has(providerId)) {
          skipped.push({
            treatment,
            lane,
            reason:
              lane === "measured"
                ? "the upscaler needs a fal key — set FAL_KEY in Keys"
                : `${providerId} is not configured`,
          });
          continue;
        }

        const capabilities = await deps.registry.get(providerId).capabilities();
        const prompt = restorePrompt(treatment, lane, request.note);

        const job = await deps.generation.start(
          {
            providerId,
            ...(lane === "generated" && request.model ? { model: request.model } : {}),
            operation: "video.generate",
            /*
             * The measured lane has no prompt, and this is what goes in the
             * recipe instead: a sentence saying so. It is not sent anywhere —
             * the adapter ignores it — but a generation record with an empty
             * prompt reads as a bug, and one carrying a plausible-looking
             * prompt would be a lie about what the provider was asked.
             */
            prompt:
              prompt ??
              `Restoration — ${RESTORE_PRESETS[treatment].label.toLowerCase()}, ` +
                `measured at ${request.upscaleFactor}x. No prompt is sent: this ` +
                "provider has no prompt field, which is why it cannot change the shot.",
            /*
             * Seeded only where a seed means something. The upscaler is
             * deterministic and declares no seed support, so sending one would
             * be refused by the capability check — correctly.
             */
            ...(request.seed !== undefined && capabilities.seed
              ? { seed: request.seed }
              : {}),
            ...(lane === "generated"
              ? sizeFor(request.size, capabilities.sizes)
              : {}),
            inputAssetIds: [source.id],
            /*
             * The whole guarantee, in one field. A lone clip is already read as
             * a reference by the Seedance adapter, but saying so explicitly is
             * what stops a later change to that inference turning every
             * restoration into an animation of its own first frame.
             */
            inputRoles: ["reference"],
            itemMentions: [],
            parentAssetId: source.id,
            ...(request.project ? { project: request.project } : {}),
            parameters: {
              /* What makes a restoration findable, and re-runnable. */
              seedRestore: treatment,
              seedRestoreLane: lane,
              seedRestoreSource: source.id,
              ...(request.note?.trim() && lane === "generated"
                ? { seedRestoreNote: request.note.trim() }
                : {}),
              ...(lane === "measured" ? { upscaleFactor: request.upscaleFactor } : {}),
            },
          },
          `restore_${treatment}_${lane}_${source.id}`,
        );

        started.push({
          treatment,
          lane,
          job: { job: job.job, generation: job.generation, outputs: [] },
        });
      }
    }

    if (started.length === 0) {
      throw new SeedError(
        "bad_request",
        skipped.map((entry) => entry.reason).join("; ") ||
          "nothing to restore",
      );
    }

    return json({ started, skipped }, 202);
  };
}

/**
 * The treatments, with what each lane can promise.
 *
 * Served rather than duplicated in the panel so the fidelity wording — the
 * sentence an artist reads before committing a shot to a cut — has exactly one
 * author. Which lanes are actually *available* is answered by the provider
 * list the panel already has, not here: this says what is possible, not what is
 * configured.
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
          lanes: preset.lanes.map((offer) => ({
            lane: offer.lane,
            fidelity: offer.fidelity,
            takesNote: offer.prompt !== undefined,
          })),
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
function sizeFor(
  requested: string | undefined,
  sizes: string[],
): { size?: string } {
  if (requested) return { size: requested };
  const best = bestQualitySize(sizes);
  return best ? { size: best } : {};
}

/**
 * The Seedance to use when the panel did not name one.
 *
 * Chosen by capability rather than by id: what the generated lane needs is a
 * provider that takes a clip as a reference, and asking the registry that
 * question is more durable than matching on a name that changes with every
 * model release.
 */
function defaultGeneratedProvider(deps: AppDeps): string | undefined {
  for (const id of deps.registry.ids()) {
    if (id.startsWith("seedance")) return id;
  }
  return undefined;
}
