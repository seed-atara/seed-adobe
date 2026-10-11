import { z } from "zod";
import { HOST_COMMANDS, HOST_READS, HOST_WRITES, POLL_HOLD_MS } from "../host/commands.js";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import type { RequestContext } from "../http/router.js";

/**
 * The service half of the host bridge — see `host/commands.ts` for why it is
 * a queue and why a command is a name rather than a script.
 *
 * Three endpoints and they face opposite directions, which is the thing to
 * keep straight when reading them: `/run` is a *caller* asking After Effects
 * to do something, while `/next` and `/result` are the *panel* fetching work
 * and reporting back. The panel is the only client of the latter two.
 */

const RunSchema = z.object({
  /** One of the panel's typed methods. Validated against the allowlist. */
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  /** How long to wait for the host before giving up. */
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
});

/** A caller asking After Effects to do one thing, and waiting for the answer. */
export function runHostCommandRoute(deps: AppDeps) {
  return async ({ req }: RequestContext) => {
    const request = parseWith(RunSchema, await readJsonBody(req));
    const result = await deps.hostCommands.run(
      request.name,
      request.args,
      request.timeoutMs,
    );
    /*
     * A host that refused is reported as a 200 carrying `ok: false`, not as an
     * HTTP error. The request reached the panel and the panel answered; "there
     * is no active composition" is an answer, and dressing it as a transport
     * failure would make a caller retry something that will never succeed.
     */
    return json(result);
  };
}

/**
 * The panel asking for work.
 *
 * Long-polls: holds the request open until a command arrives or the hold
 * expires, so an idle panel is not spinning and a queued command is picked up
 * in milliseconds rather than on the next tick of a timer.
 */
export function nextHostCommandRoute(deps: AppDeps) {
  return async () => {
    const command = await deps.hostCommands.next();
    return json(command ? { command } : { command: null }, 200);
  };
}

const ResultSchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().max(4000).optional(),
});

/** The panel reporting what After Effects said. */
export function hostCommandResultRoute(deps: AppDeps) {
  return async ({ req, params }: RequestContext) => {
    const request = parseWith(ResultSchema, await readJsonBody(req));
    deps.hostCommands.complete(params.id!, request);
    return json({ recorded: true });
  };
}

/**
 * What can be driven, and whether anything is listening.
 *
 * Exists so a caller can tell "the panel is closed" from "that command does
 * not exist" without guessing from a failure, and so the allowlist has one
 * published home rather than being rediscovered from error messages.
 */
export function hostStatusRoute(deps: AppDeps) {
  return () =>
    json({
      ...deps.hostCommands.stats(),
      holdMs: POLL_HOLD_MS,
      commands: { reads: HOST_READS, writes: HOST_WRITES, all: HOST_COMMANDS },
    });
}
