import { SeedError, StartGenerationRequestSchema } from "@seed-ae/domain";
import { buildLineage } from "@seed-ae/storage";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

export function listProvidersRoute(deps: AppDeps) {
  return async () => json({ providers: await deps.registry.describeAll() });
}

export function startGenerationRoute(deps: AppDeps) {
  return async ({ req, correlationId }: RequestContext) => {
    const body = await readJsonBody(req);
    const request = parseWith(StartGenerationRequestSchema, body);
    // Returns as soon as the job is durable; the provider call happens after.
    const { job, generation } = await deps.generation.start(request, correlationId);
    return json({ job, generation, outputs: [] }, 202);
  };
}

export function getJobRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const job = deps.jobs.requireById(params.id as string);
    const generation = job.generationId
      ? deps.generations.getById(job.generationId)
      : undefined;
    const outputs = (generation?.outputAssetIds ?? [])
      .map((id) => deps.assets.getById(id))
      .filter((asset) => asset !== undefined);
    return json({ job, ...(generation ? { generation } : {}), outputs });
  };
}

export function listJobsRoute(deps: AppDeps) {
  return ({ url }: RequestContext) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100);
    return json({ jobs: deps.jobs.listRecent(limit) });
  };
}

export function cancelJobRoute(deps: AppDeps) {
  return async ({ params }: RequestContext) => {
    const job = await deps.generation.cancel(params.id as string);
    return json({ job, outputs: [] });
  };
}

export function getGenerationRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const generation = deps.generations.requireById(params.id as string);
    const outputs = generation.outputAssetIds
      .map((id) => deps.assets.getById(id))
      .filter((asset) => asset !== undefined);
    const inputs = generation.inputAssetIds
      .map((id) => deps.assets.getById(id))
      .filter((asset) => asset !== undefined);
    return json({ generation, inputs, outputs });
  };
}

export function listGenerationsRoute(deps: AppDeps) {
  return ({ url }: RequestContext) => {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    return json(deps.generations.list(limit, offset));
  };
}

/** The "where did this come from, what came from it" view. */
export function lineageRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const graph = buildLineage(deps.assets, deps.generations, params.id as string);
    return json(graph);
  };
}

/**
 * Reopens a recipe: everything needed to run it again, with the original
 * generation as the parent so a variation branches rather than overwrites.
 */
export function recipeRoute(deps: AppDeps) {
  return ({ params }: RequestContext) => {
    const asset = deps.assets.requireById(params.id as string);
    if (!asset.generationId) {
      throw new SeedError(
        "not_found",
        `asset ${asset.id} was not generated, so it has no recipe`,
      );
    }
    const generation = deps.generations.requireById(asset.generationId);
    const parameters = generation.parameters as Record<string, unknown>;

    /*
     * Lift the parameters the form has fields for back to the top level.
     *
     * They are all in `parameters` too, but a caller reconstructing a form
     * should not have to know which of them the service happened to flatten —
     * and when it did have to, the ones it did not know about were silently
     * dropped, so reopening a video recipe quietly changed its length.
     */
    const roles = Array.isArray(parameters.inputRoles)
      ? parameters.inputRoles.filter(
          (role): role is "first" | "last" | "reference" =>
            role === "first" || role === "last" || role === "reference",
        )
      : undefined;

    return json({
      recipe: {
        providerId: generation.provider,
        model: generation.model,
        operation: generation.operation,
        prompt: generation.prompt,
        ...(generation.seed !== undefined ? { seed: generation.seed } : {}),
        ...(typeof parameters.size === "string" ? { size: parameters.size } : {}),
        ...(typeof parameters.durationSeconds === "number"
          ? { durationSeconds: parameters.durationSeconds }
          : {}),
        ...(typeof parameters.aspectRatio === "string"
          ? { aspectRatio: parameters.aspectRatio }
          : {}),
        ...(parameters.generateAudio === true ? { generateAudio: true } : {}),
        ...(roles && roles.length > 0 ? { inputRoles: roles } : {}),
        inputAssetIds: generation.inputAssetIds,
        parentAssetId: asset.id,
        parentGenerationId: generation.id,
        parameters,
      },
      generation,
    });
  };
}
