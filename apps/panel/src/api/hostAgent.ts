import type { CepAeBridge } from "./cep.ts";
import type { SeedClient } from "./client.ts";

/**
 * The panel as a worker, so something that is not a mouse can drive the host.
 *
 * Everything SEED can do inside After Effects already exists — sixty-odd
 * functions in `seed-host.jsx` that cut regions, add effects, import, insert
 * at the playhead, capture a range. None of it could ever be called without a
 * human clicking, because only the panel can reach a host and nothing could
 * reach the panel. The service's own `aeHost` adapter is a mock and always
 * has been.
 *
 * This closes the loop, in the only direction CEP allows: a panel is not a
 * server and cannot be dialled, so it *asks*. Long-poll the service for a
 * command, run it through the bridge the panel already uses for its own
 * buttons, post the answer back, repeat.
 *
 * ## What this is not
 *
 * It is **not** an ExtendScript endpoint. The dispatch table below is the
 * whole vocabulary, and a name that is not in it was already refused by the
 * service before it got here. Both ends hold the same line on purpose: the
 * panel runs inside the artist's project with their filesystem, and a
 * generated line of script that meant something slightly different is not
 * something a project file should find out about. Adding a capability is a
 * deliberate two-line change here and in the service allowlist.
 *
 * ## Unverified inside Adobe
 *
 * The loop and the dispatch are ordinary TypeScript and are covered by tests.
 * What those tests cannot cover is the part that matters: whether a long poll
 * held open for twenty-five seconds inside a CEP panel survives, and whether
 * running `evalScript` off a timer rather than off a click behaves the same.
 * Neither has been run in After Effects yet. Until it has, this is a
 * mechanism that should work, not one that is known to.
 */

/** What the service queued. */
export interface HostCommand {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Name to bridge call.
 *
 * Deliberately explicit rather than `(bridge as any)[name](...)`. A reflective
 * lookup would quietly widen the vocabulary to every method the bridge ever
 * gains, including ones added later for the panel's own use and never
 * considered as something an agent should be able to trigger. The allowlist
 * has to be a decision, which means it has to be typed out.
 */
export function dispatch(
  bridge: CepAeBridge,
  command: HostCommand,
): Promise<unknown> | undefined {
  const args = command.args;

  switch (command.name) {
    // Reads — safe to run against a project nobody is expecting to change.
    case "ping":
      return bridge.ping();
    case "getContext":
      return bridge.getContext();
    case "rangeInfo":
      return bridge.rangeInfo();
    case "listRegions":
      return bridge.listRegions();
    case "selectedMedia":
      return bridge.selectedMedia();

    // Writes — these change the artist's project.
    case "captureFrame":
      return bridge.captureFrame();
    case "createRegion":
      return bridge.createRegion(Number(args.size ?? 1024), String(args.aspect ?? "1:1"));
    case "setRegionAspect":
      return bridge.setRegionAspect(String(args.name), String(args.aspect));
    case "setRegionContain":
      return bridge.setRegionContain(String(args.name), Boolean(args.contained));
    case "setProjectDepth":
      return bridge.setProjectDepth(depthOf(args.bits));

    default:
      return undefined;
  }
}

/** The three the host accepts, with 32 as the default this project prefers. */
function depthOf(value: unknown): 8 | 16 | 32 {
  return value === 8 ? 8 : value === 16 ? 16 : 32;
}

export interface HostAgentOptions {
  client: SeedClient;
  bridge: CepAeBridge;
  /** Reports a command as it runs, so the panel can show what is happening. */
  onActivity?: (name: string | undefined) => void;
}

/**
 * Runs the loop until stopped. Returns the stop function.
 *
 * Errors are swallowed back into the loop rather than ending it. A service
 * that went away for a moment, a poll that timed out in transit, a host call
 * that threw — none of those are reasons for the panel to stop being
 * available, and a worker that silently stops is the failure mode that looks
 * exactly like a hung request on the other end.
 */
export function startHostAgent({ client, bridge, onActivity }: HostAgentOptions): () => void {
  let running = true;

  void (async () => {
    while (running) {
      let command: HostCommand | undefined;
      try {
        command = await client.nextHostCommand();
      } catch {
        /*
         * Back off before retrying. Without this, a service that is down turns
         * the loop into a tight spin that will happily saturate a core inside
         * the artist's host application.
         */
        await pause(2000);
        continue;
      }

      if (!command) continue;
      if (!running) break;

      onActivity?.(command.name);
      try {
        const pending = dispatch(bridge, command);
        if (!pending) {
          await client.hostCommandResult(command.id, {
            ok: false,
            error: `the panel has no handler for ${command.name}.`,
          });
        } else {
          await client.hostCommandResult(command.id, { ok: true, value: await pending });
        }
      } catch (cause) {
        await client
          .hostCommandResult(command.id, {
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          })
          .catch(() => {
            // The caller will time out and say so. Nothing better to do here,
            // and throwing would take the loop down with it.
          });
      } finally {
        onActivity?.(undefined);
      }
    }
  })();

  return () => {
    running = false;
  };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
