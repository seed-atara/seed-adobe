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
    case "compTree":
      return bridge.compTree(
        args.compId === undefined || args.compId === null ? undefined : String(args.compId),
        args.maxDepth === undefined ? 2 : Number(args.maxDepth),
      );
    case "projectComps":
      return bridge.projectComps(
        args.match === undefined || args.match === null ? undefined : String(args.match),
      );
    case "projectItems":
      return bridge.projectItems();
    case "layerBounds":
      return bridge.layerBounds(
        Number(args.layerIndex),
        args.atSeconds === undefined || args.atSeconds === null
          ? undefined
          : Number(args.atSeconds),
        args.includeExtents === false ? false : true,
      );

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
    case "precompose":
      return bridge.precompose(
        indexList(args.layerIndexes),
        String(args.name ?? "SEED precomp"),
        args.moveAllAttributes === undefined ? undefined : Boolean(args.moveAllAttributes),
      );
    case "regionFromLayer":
      return bridge.regionFromLayer(
        Number(args.layerIndex),
        args.aspect === undefined || args.aspect === null ? undefined : String(args.aspect),
        args.padPercent === undefined ? 6 : Number(args.padPercent),
        args.atSeconds === undefined || args.atSeconds === null
          ? undefined
          : Number(args.atSeconds),
      );
    case "setLayerSolo":
      return bridge.setLayerSolo(
        args.layerIndex === undefined || args.layerIndex === null
          ? undefined
          : Number(args.layerIndex),
        args.solo === false ? false : true,
      );
    case "captureRegion":
      return bridge.captureRegion(String(args.regionName), Number(args.featherPixels ?? 0), {
        mode: args.mode === "clip" ? "clip" : "still",
        quality: args.quality === "quality" ? "quality" : "delivery",
      });
    case "setActiveComp":
      return bridge.setActiveComp(String(args.compId));
    case "createFolders":
      return bridge.createFolders(folderPaths(args.paths));
    case "moveItems":
      return bridge.moveItems(itemMoves(args.moves));
    case "moveLayer":
      return bridge.moveLayer(layerPosition(args.layerIndex), layerPosition(args.toIndex));
    case "setTransform":
      return bridge.setTransform(Number(args.layerIndex), transformProperty(args.property), {
        ...(args.value === undefined || args.value === null
          ? {}
          : { value: transformValue(args.value) }),
        ...(args.keyframes === undefined || args.keyframes === null
          ? {}
          : { keyframes: transformKeyframes(args.keyframes) }),
        interpolation: interpolationOf(args.interpolation),
        replace: args.replace === true,
      });
    case "addSolid":
      return bridge.addSolid(
        rgbOf(args.color),
        String(args.name ?? "SEED backing"),
        args.atBottom === false ? false : true,
      );
    case "applyEffects":
      return bridge.applyEffects(
        Number(args.layerIndex),
        Array.isArray(args.names) ? args.names.map((name) => String(name)) : undefined,
      );
    case "setLayerEnabled":
      return bridge.setLayerEnabled(Number(args.layerIndex), args.enabled !== false);
    case "insertIntoComp":
      return bridge.insertIntoComp(String(args.assetId), {
        startSeconds: Number(args.startSeconds ?? 0),
        fit: fitOf(args.fit),
        ...(args.name === undefined ? {} : { name: String(args.name) }),
      });
    case "repeatToFill":
      return bridge.repeatToFill(
        Number(args.layerIndex),
        args.untilSeconds === undefined || args.untilSeconds === null
          ? undefined
          : Number(args.untilSeconds),
      );
    case "replaceFootage":
      return bridge.replaceFootage(String(args.projectItemId), String(args.path));
    case "samplePosition":
      return bridge.samplePosition(
        Number(args.layerIndex),
        Number(args.fromSeconds ?? 0),
        Number(args.toSeconds ?? 0),
        Number(args.stepSeconds ?? 0),
      );
    case "setTimeRemap":
      return bridge.setTimeRemap(
        Number(args.layerIndex),
        (args.keys ?? []) as Array<[number, number]>,
      );
    case "setEffectParams":
      return bridge.setEffectParams(
        Number(args.layerIndex),
        String(args.effectName),
        (args.params ?? {}) as Record<string, number | number[]>,
      );
    case "deleteLayer":
      return bridge.deleteLayer(
        Number(args.layerIndex),
        args.expectName === undefined || args.expectName === null
          ? undefined
          : String(args.expectName),
      );
    case "saveVersion":
      return bridge.saveVersion(
        args.label === undefined || args.label === null ? undefined : String(args.label),
      );
    case "insertRegion":
      return bridge.insertRegion(String(args.assetId), {
        regionName: String(args.regionName),
        featherPixels: Number(args.featherPixels ?? 0),
        ...(args.startSeconds === undefined ? {} : { startSeconds: Number(args.startSeconds) }),
        ...(args.stretchToSeconds === undefined
          ? {}
          : { stretchToSeconds: Number(args.stretchToSeconds) }),
      });

    default:
      return undefined;
  }
}

/**
 * Layer indexes, refused rather than coerced.
 *
 * `Number("Houses01")` is NaN and After Effects would answer a confusing
 * complaint about a layer that is not there. A caller that sent names meant
 * names, and should be told so here.
 */
function indexList(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("precompose needs layerIndexes: an array of layer numbers from compTree.");
  }
  return value.map((entry) => {
    const index = Number(entry);
    if (!Number.isInteger(index) || index < 1) {
      throw new Error(`${String(entry)} is not a layer index. compTree reports the numbers.`);
    }
    return index;
  });
}

/**
 * A solid colour, as the host wants it: three channels, 0 to 1.
 *
 * `undefined` rather than a guess when it is anything else, so the host's own
 * chroma-green default applies. Silently reading 0-255 values as 0-1 would
 * produce a white solid and a key that mattes nothing.
 */
function rgbOf(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const channels = value.slice(0, 3).map((channel) => Number(channel));
  if (channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1)) {
    throw new Error("solid colour channels are 0 to 1, not 0 to 255.");
  }
  return [channels[0]!, channels[1]!, channels[2]!];
}

/** Scaling modes, with the distorting one reachable only by naming it. */
function fitOf(value: unknown): "cover" | "contain" | "stretch" | "none" {
  return value === "contain" || value === "stretch" || value === "none" ? value : "cover";
}

/** The three the host accepts, with 32 as the default this project prefers. */



/**
 * A layer index, which is 1-based in After Effects and has no upper bound here.
 *
 * The host knows how many layers the comp has and refuses the rest; this only
 * catches what would be nonsense in any comp, so a zero or a fraction cannot
 * reach `comp.layer()` and come back as something unhelpful about undefined.
 */
function layerPosition(value: unknown): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 1) {
    throw new Error(`${String(value)} is not a layer index (they start at 1)`);
  }
  return index;
}

/** The transforms this will set, spelled as the host spells them. */
const TRANSFORMS = ["Position", "Scale", "Rotation", "Opacity", "Anchor Point"] as const;

function transformProperty(value: unknown): string {
  const wanted = String(value ?? "").trim().toLowerCase();
  const found = TRANSFORMS.find((name) => name.toLowerCase() === wanted);
  if (!found) throw new Error(`property must be one of ${TRANSFORMS.join(", ")}`);
  return found;
}

/** One or several finite numbers — never a NaN, which After Effects accepts. */
function transformValue(value: unknown): number | number[] {
  if (Array.isArray(value)) {
    if (!value.length || value.length > 3) throw new Error("a transform takes 1 to 3 numbers");
    return value.map((part) => {
      const n = Number(part);
      if (!Number.isFinite(n)) throw new Error(`${String(part)} is not a number`);
      return n;
    });
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${String(value)} is not a number`);
  return n;
}

/**
 * Keyframes, in time order.
 *
 * Sorted here rather than trusted, because `setValueAtTime` does not care
 * about the order it is called in but `setInterpolationTypeAtKey` indexes by
 * time — so an out-of-order list silently eases the wrong keyframes.
 */
function transformKeyframes(
  value: unknown,
): Array<{ atSeconds: number; value: number | number[] }> {
  if (!Array.isArray(value) || !value.length) throw new Error("keyframes must be a non-empty array");
  const keys = value.map((entry) => {
    const key = entry as Record<string, unknown>;
    const atSeconds = Number(key.atSeconds);
    if (!Number.isFinite(atSeconds) || atSeconds < 0)
      throw new Error("every keyframe needs an atSeconds of zero or more");
    return { atSeconds, value: transformValue(key.value) };
  });
  return keys.sort((a, b) => a.atSeconds - b.atSeconds);
}

function interpolationOf(value: unknown): "linear" | "hold" | "ease" {
  return value === "hold" || value === "ease" ? value : "linear";
}

/**
 * Folder paths, as paths and nothing else.
 *
 * A path arrives from a plan computed elsewhere, so it is checked here rather
 * than trusted: no empty segment, no `..`, nothing that would walk out of the
 * shelf it is meant to build. The Project panel is not a filesystem, but a
 * folder called `..` is a folder nobody can explain later.
 */
function folderPaths(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("paths must be an array of folder paths");
  return value.map((entry) => {
    const path = String(entry).trim();
    if (!path) throw new Error("a folder path cannot be empty");
    const parts = path.split("/").map((part) => part.trim());
    if (parts.some((part) => part === "" || part === "." || part === ".."))
      throw new Error(`${path} is not a folder path`);
    return parts.join("/");
  });
}

/** A move list, with the name guard carried through when the plan supplied one. */
function itemMoves(value: unknown): Array<{ itemId: string; folder: string; expectName?: string }> {
  if (!Array.isArray(value)) throw new Error("moves must be an array");
  return value.map((entry) => {
    const move = entry as Record<string, unknown>;
    const itemId = String(move.itemId ?? "").trim();
    if (!itemId) throw new Error("every move needs an itemId");
    // An empty folder means the project root, which is a legitimate
    // destination -- it is how something gets taken back out of a folder.
    const raw = move.folder === undefined || move.folder === null ? "" : String(move.folder).trim();
    const folder = raw === "" ? "" : folderPaths([raw])[0]!;
    const expectName =
      move.expectName === undefined || move.expectName === null
        ? undefined
        : String(move.expectName);
    return expectName === undefined ? { itemId, folder } : { itemId, folder, expectName };
  });
}

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
