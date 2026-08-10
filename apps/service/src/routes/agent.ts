import { ComposeRequestSchema, SeedError } from "@seed-ae/domain";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * Composes a generation plan from a described scene.
 *
 * Returns a proposal and nothing else — no job is created and nothing is
 * written. The panel fills its form from the plan and the user presses
 * Generate, which keeps every irreversible step deliberate.
 */
export function composeRoute(deps: AppDeps) {
  return async ({ req, correlationId }: RequestContext) => {
    if (!deps.director) {
      throw new SeedError(
        "unsupported_capability",
        "direction is unavailable: set ANTHROPIC_API_KEY and restart the service.",
      );
    }

    const request = parseWith(ComposeRequestSchema, await readJsonBody(req));

    // Only assets that exist are offered; a stale id from the panel would
    // otherwise shift every candidate index the model was shown.
    const candidates = request.candidateAssetIds
      .map((id) => deps.assets.getById(id))
      .filter((asset) => asset !== undefined);

    const startedAt = Date.now();
    const plan = await deps.director.compose({
      request,
      candidates,
      providers: await deps.registry.describeAll(),
    });

    deps.logger.info("agent.composed", {
      correlationId,
      durationMs: Date.now() - startedAt,
      provider: plan.providerId,
      operation: plan.operation,
      candidateCount: candidates.length,
      referenceCount: plan.references.length,
      warningCount: plan.warnings.length,
    });

    return json({ plan });
  };
}
