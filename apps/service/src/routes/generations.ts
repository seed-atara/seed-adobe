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

    return json({
      recipe: {
        providerId: generation.provider,
        model: generation.model,
        operation: generation.operation,
        prompt: generation.prompt,
        ...(generation.seed !== undefined ? { seed: generation.seed } : {}),
        ...(typeof parameters.size === "string" ? { size: parameters.size } : {}),
        inputAssetIds: generation.inputAssetIds,
        parentAssetId: asset.id,
        parentGenerationId: generation.id,
        parameters,
      },
      generation,
    });
  };
}
