import {
  PASS_ORDER,
  PASS_PRESETS,
  PassKindSchema,
  SeedError,
  passPrompt,
  type PassKind,
} from "@seed-ae/domain";
import { z } from "zod";
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
