import { SeedError } from "@seed-ae/domain";

/**
 * A way for something that is not a mouse to drive After Effects.
 *
 * Everything in After Effects that SEED can do already exists, in
 * `apps/extension/jsx/seed-host.jsx` — sixty-odd functions that cut regions,
 * add effects, import, insert at the playhead, render a range. What has never
 * existed is a way to call one without a human clicking a button, because the
 * direction of the wire only ever went one way: the panel does the work and
 * tells the service what happened. `deps.aeHost` on the service side is a
 * mock and always has been.
 *
 * This is the missing direction, and it is deliberately a *queue* rather than
 * a socket. CEP panels are not servers and cannot be dialled; what a panel can
 * do is ask. So the service holds work, the panel long-polls for it, runs it
 * through the bridge it already has, and posts the answer back.
 *
 * ## The rule that shapes the whole design
 *
 * **A command is a name and typed arguments. It is never a script.**
 *
 * The temptation, once an agent is on the other end, is to let it send
 * ExtendScript and be done — one endpoint, infinite capability. That would
 * make the panel an arbitrary code execution service running inside the
 * artist's project with their filesystem, and `CLAUDE.md` forbids exactly it:
 * *do not execute text returned by an LLM/model*. The panel's own typed
 * methods are the allowlist, and a name that is not one of them is refused
 * here before it ever reaches a host.
 *
 * The cost is real — a capability has to be added deliberately rather than
 * improvised — and it is the right cost. A project file is not somewhere to
 * find out that a generated line of script meant something else.
 */

/** What a caller asked for. */
export interface HostCommand {
  id: string;
  /** One of the panel bridge's typed methods. Never a script. */
  name: string;
  args: Record<string, unknown>;
  createdAt: number;
}

export interface HostResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface Pending {
  command: HostCommand;
  /** Resolved when the panel posts a result, or when the wait runs out. */
  settle: (result: HostResult) => void;
  settled: boolean;
  timer: NodeJS.Timeout;
}

/**
 * The operations a panel is allowed to be asked for.
 *
 * Names, matching the bridge's own method names, so the panel's executor is a
 * lookup rather than a translation layer that could drift. Adding a capability
 * is a two-line change in two files and that is on purpose — see the header.
 *
 * Read-only operations are separated from ones that change the artist's
 * project, because the distinction matters to whoever is deciding whether to
 * let an agent loose on it, and burying it in a single flat list would make
 * that decision harder than it needs to be.
 */
export const HOST_READS = [
  "ping",
  "getContext",
  "rangeInfo",
  "listRegions",
  "selectedMedia",
  "compTree",
  "projectComps",
  "layerBounds",
] as const;

export const HOST_WRITES = [
  "captureFrame",
  "createRegion",
  "setRegionAspect",
  "setRegionContain",
  "setProjectDepth",
  "precompose",
  "regionFromLayer",
  "setLayerSolo",
  "captureRegion",
  "insertRegion",
  "setActiveComp",
  "addSolid",
  "applyEffects",
  "setLayerEnabled",
  "insertIntoComp",
  "repeatToFill",
  "replaceFootage",
  "saveVersion",
] as const;

export const HOST_COMMANDS: readonly string[] = [...HOST_READS, ...HOST_WRITES];

/**
 * How long a panel's long-poll is held open before it is told to ask again.
 *
 * Long enough that an idle panel is not hammering the service, short enough
 * that a CEP request does not hit whatever timeout sits between them. The
 * panel reconnects immediately, so this is a heartbeat rather than a limit on
 * how long a command can wait.
 */
export const POLL_HOLD_MS = 25_000;

/** After this with no poll, the panel is treated as gone. */
const PANEL_IDLE_MS = 60_000;

/** How long a caller waits for the host before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;

export class HostCommandQueue {
  private readonly waiting: Pending[] = [];
  private readonly inFlight = new Map<string, Pending>();
  /** Panels parked on a long poll, waiting for something to do. */
  private readonly listeners: Array<(command: HostCommand) => void> = [];
  private lastPolledAt = 0;

  /** Whether a panel has asked for work recently enough to count as present. */
  connected(now = Date.now()): boolean {
    return now - this.lastPolledAt < PANEL_IDLE_MS;
  }

  /**
   * Queue a command and wait for the panel to answer it.
   *
   * Refuses up front when no panel is listening rather than queueing into a
   * void. A caller that is told "no panel" can open one; a caller left hanging
   * for two minutes learns nothing and has wasted the time of whoever is
   * watching.
   */
  async run(
    name: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<HostResult> {
    if (!HOST_COMMANDS.includes(name)) {
      throw new SeedError(
        "bad_request",
        `${name} is not a host command. The panel exposes: ${HOST_COMMANDS.join(", ")}. ` +
          "Commands are named operations, never scripts.",
      );
    }
    if (!this.connected()) {
      throw new SeedError(
        "unsupported_capability",
        "no SEED panel is listening, so After Effects cannot be driven. Open " +
          "Window > Extensions > SEED / AE, then switch **Agent** on in the " +
          "panel's status bar — an open panel alone does not accept work, " +
          "because changing the artist's project is their decision to make.",
      );
    }

    const command: HostCommand = { id: globalThis.crypto.randomUUID(), name, args, createdAt: Date.now() };

    return new Promise<HostResult>((resolve) => {
      const pending: Pending = {
        command,
        settled: false,
        settle: (result) => {
          if (pending.settled) return;
          pending.settled = true;
          clearTimeout(pending.timer);
          this.inFlight.delete(command.id);
          resolve(result);
        },
        timer: setTimeout(() => {
          pending.settle({
            ok: false,
            error:
              `After Effects did not answer ${name} within ${Math.round(timeoutMs / 1000)}s. ` +
              "A modal dialog in the host will do this — check for one.",
          });
        }, timeoutMs),
      };

      this.inFlight.set(command.id, pending);

      // Hand it straight to a parked panel if one is waiting; otherwise it
      // sits until the next poll.
      const listener = this.listeners.shift();
      if (listener) listener(command);
      else this.waiting.push(pending);
    });
  }

  /**
   * The panel asking for work.
   *
   * Resolves immediately when something is queued, otherwise parks until a
   * command arrives or the hold expires. Each call marks the panel present,
   * which is what `connected` reads.
   */
  async next(holdMs = POLL_HOLD_MS): Promise<HostCommand | undefined> {
    this.lastPolledAt = Date.now();

    const queued = this.waiting.shift();
    if (queued) return queued.command;

    return new Promise<HostCommand | undefined>((resolve) => {
      let done = false;
      const listener = (command: HostCommand) => {
        if (done) return;
        done = true;
        resolve(command);
      };
      this.listeners.push(listener);

      setTimeout(() => {
        if (done) return;
        done = true;
        const at = this.listeners.indexOf(listener);
        if (at >= 0) this.listeners.splice(at, 1);
        resolve(undefined);
      }, holdMs);
    });
  }

  /** The panel reporting what the host said. */
  complete(id: string, result: HostResult): void {
    const pending = this.inFlight.get(id);
    if (!pending) {
      // Already timed out, or never ours. Not an error worth failing a panel
      // over — it has done the work either way.
      return;
    }
    pending.settle(result);
  }

  /** For the status route, and for tests. */
  stats(): { connected: boolean; queued: number; inFlight: number } {
    return {
      connected: this.connected(),
      queued: this.waiting.length,
      inFlight: this.inFlight.size,
    };
  }
}
