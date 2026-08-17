import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "./client.ts";

/**
 * The CEP host object After Effects injects into the panel's window.
 *
 * We talk to it directly rather than vendoring Adobe's CSInterface.js: the
 * only capability the panel needs is evalScript, and a 20-line wrapper is
 * easier to audit than a third-party bundle in a process holding a session
 * token.
 */
interface AdobeCep {
  evalScript(script: string, callback: (result: string) => void): void;
  getHostEnvironment(): string;
  getSystemPath(pathType: string): string;
}

declare global {
  interface Window {
    __adobe_cep__?: AdobeCep;
  }
}

export function isCepHost(): boolean {
  return typeof window !== "undefined" && window.__adobe_cep__ !== undefined;
}

/**
 * Absolute path of the installed extension folder.
 *
 * CEP hands this back as a file:// URI; After Effects wants a plain path.
 */
function extensionRoot(): string {
  const cep = window.__adobe_cep__;
  if (!cep) throw new Error("not running inside an Adobe host");
  return decodeURI(cep.getSystemPath("extension")).replace(/^file:\/{2,3}/, "");
}

/**
 * Which Adobe application the panel is docked in.
 *
 * `getHostEnvironment()` returns JSON; `appName` is a four-letter code —
 * `AEFT` for After Effects, `PPRO` for Premiere Pro.
 */
export function hostApp(): "AEFT" | "PPRO" | "unknown" {
  const cep = window.__adobe_cep__;
  if (!cep) return "unknown";
  try {
    const { appName } = JSON.parse(cep.getHostEnvironment()) as { appName?: string };
    if (appName === "AEFT" || appName === "PPRO") return appName;
  } catch {
    // fall through
  }
  return "unknown";
}

/**
 * The host-specific prefix for this application.
 *
 * Both scripts run in one shared ExtendScript engine, so uniquely prefixed
 * entry points are what the panel calls — see the note on evalHost.
 */
function hostPrefix(): string {
  return hostApp() === "PPRO" ? "seedPpro_" : "seedAeft_";
}

/** The host script this application needs. */
function hostScriptPath(): string {
  const file = hostApp() === "PPRO" ? "seed-host-ppro.jsx" : "seed-host.jsx";
  return `${extensionRoot()}/jsx/${file}`;
}

/**
 * Loads the host script and reports which host answered.
 *
 * Kept for the panel's status readout; the real loading happens inside every
 * call, because CEP does not preserve it between them.
 */
export async function reloadHostScript(): Promise<string> {
  const { host } = await evalHost<{ host: string }>(`${hostPrefix()}ping()`);
  return host;
}

interface HostResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function quote(value: string): string {
  return JSON.stringify(String(value));
}

/**
 * Runs one host call, loading the host script in the same breath.
 *
 * CEP evaluates the ScriptPath from its manifest dispatch for *each*
 * evalScript, so anything loaded by a previous call is gone by the next one:
 * a separate "load the script" step provably does not survive. In Premiere
 * that left the generic names belonging to the After Effects script — the
 * panel called seedPpro_getContext and it simply was not there.
 *
 * Loading and calling together is the only arrangement that holds. The file
 * read is local and happens once per user action, which is nothing next to a
 * frame export.
 */
async function evalHost<T>(call: string): Promise<T> {
  const cep = window.__adobe_cep__;
  if (!cep) throw new Error("not running inside an Adobe host");

  const jsxPath = hostScriptPath();
  const expression = `(function () {
    try {
      $.evalFile(new File(${JSON.stringify(jsxPath)}));
    } catch (loadError) {
      return '{"ok":false,"error":"could not load host script: ' + String(loadError).replace(/"/g, "'") + '"}';
    }
    if (typeof ${hostPrefix()}ping !== "function") {
      return '{"ok":false,"error":"host script loaded but ${hostPrefix()}* is missing"}';
    }
    try {
      return ${call};
    } catch (callError) {
      return '{"ok":false,"error":"' + String(callError).replace(/"/g, "'") + '"}';
    }
  })()`;

  const raw = await new Promise<string>((resolve) => {
    cep.evalScript(expression, resolve);
  });

  if (raw === "EvalScript error.") {
    throw new Error(
      `${hostApp()} could not run ${call.split("(")[0]} — the host script failed to evaluate.`,
    );
  }

  let parsed: HostResult<T>;
  try {
    parsed = JSON.parse(raw) as HostResult<T>;
  } catch {
    throw new Error(`unexpected response from After Effects: ${raw.slice(0, 200)}`);
  }

  if (!parsed.ok) throw new Error(parsed.error ?? "After Effects reported a failure");
  return parsed.result as T;
}

export interface AeContextResult {
  context: Record<string, unknown>;
}

export interface InsertResult {
  /** Which video track took the clip, e.g. "V2". */
  trackName?: string;
  /** Set when the targeted track was busy and another was used. */
  movedFromTargeted?: string;
}

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  frameNumber: number;
  timeSeconds: number;
}

/** What the timeline offers as a range, before anything is rendered. */
export interface RangeInfo {
  compName: string;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  time: number;
  workAreaStart: number;
  workAreaDuration: number;
  /** False when no H.264 output module template exists to render through. */
  hasH264: boolean;
}

export interface RangeCaptureResult {
  path: string;
  posterPath?: string | null;
  bytes: number;
  width: number;
  height: number;
  frameRate: number;
  frameNumber: number;
  startSeconds: number;
  durationSeconds: number;
  template: string;
}

/**
 * Drives the host application from inside the panel.
 *
 * In CEP the panel — not the service — is the process with scripting access,
 * so capture and import happen here and the service is told about the result.
 * The service stays host-agnostic, and so does this class: After Effects and
 * Premiere expose the same host functions under the same names.
 */
/** A region guide as After Effects currently has it, in comp pixels. */
export interface AeRegion {
  name: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  /** Width over height of the rectangle the region was built at. */
  aspect: number;
  /** True while the region's scale is locked to that aspect. */
  locked: boolean;
  /** True while the region is held inside the composition. */
  contained: boolean;
  /** True once the region has a sub-comp, which capture creates. */
  hasComp: boolean;
  /** True once that sub-comp is placed back over the plate. */
  composited: boolean;
}

export interface AeRegionPlacement {
  name: string;
  regionName: string;
  compName: string;
  atSeconds: number;
  width: number;
  height: number;
  /** The clip's own resolution, which rarely matches the region's. */
  sourceWidth: number;
  sourceHeight: number;
  featherPixels: number;
  stretchPercent: number;
}

/** Where a reserved placeholder lives, in whichever host reserved it. */
export interface PlaceholderHandle {
  label: string;
  /** The card's width, so the swap can correct the scale by their ratio. */
  cardWidth?: number;
  /** After Effects only: the comp it was reserved in, so it is found later. */
  compId?: number;
  atSeconds?: number;
  durationSeconds?: number;
  /** Premiere only: which video track it went onto. */
  trackIndex?: number;
  trackName?: string;
  /*
   * Set when this placeholder was adopted from a layer that already held a
   * take, so a failed render can put that take back. After Effects identifies
   * the previous source by project item id, Premiere by node id.
   */
  restoreItemId?: number;
  restoreNodeId?: string;
  restoreWidth?: number;
  restoreName?: string;
  /** Premiere swap route: the media to put back under the clip's own item. */
  restoreMediaPath?: string;
  /** The take's own width, so a swap can undo its scale correction. */
  sourceWidth?: number;
  /**
   * Whether the artist's effects survive this replacement. False only on
   * Premiere's fallback route, and worth saying out loud when it happens.
   */
  keepsEffects?: boolean;
  /** How many clips share the project item, when that forced the fallback. */
  sharedBy?: number;
}

/** What the artist has selected in the host, if it came from a file. */
export interface SelectedMedia {
  path: string;
  filename: string;
  layerName: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  startSeconds?: number;
  /** After Effects: the comp and layer to adopt later. */
  compId?: number;
  layerIndex?: number;
  /** Premiere: the track and time to adopt later. */
  trackIndex?: number;
  trackName?: string;
  scalePercent?: number;
  /** After Effects: set when the selection was a region composite. */
  inRegion?: boolean;
  regionName?: string | null;
}

export class CepAeBridge {
  readonly id = "cep";

  /** Loaded lazily once per panel session; see reloadHostScript. */
  private hostReady: Promise<void> | undefined;
  /** Which host script answered — shown in the panel so it is never a guess. */
  loadedHost: string | undefined;

  constructor(private readonly client: SeedClient) {}

  /**
   * Makes sure the *right* host script is the one currently defined.
   *
   * Loading once per session is not enough. Both hosts define the same
   * function names into one shared ExtendScript engine, and CEP evaluates the
   * manifest's ScriptPath on its own schedule — after the panel has loaded its
   * choice, it can silently overwrite it. That is how a Premiere panel ended
   * up running After Effects' seedCaptureFrame and reporting "no active
   * composition".
   *
   * So this checks who is actually defined before every call — one cheap
   * evalScript — and reloads only when it finds the wrong one.
   */
  /**
   * Records which host answered, for the status readout. Loading is no longer
   * a separate step — every call carries its own.
   */
  private async ensureHost(): Promise<void> {
    if (!this.loadedHost) this.loadedHost = await reloadHostScript();
  }

  async ping(): Promise<{ version: string; hasProject: boolean }> {
    await this.ensureHost();
    return evalHost<{ version: string; hasProject: boolean }>(`${hostPrefix()}ping()`);
  }

  async getContext(): Promise<Record<string, unknown>> {
    await this.ensureHost();
    const { context } = await evalHost<AeContextResult>(`${hostPrefix()}getContext()`);
    return context;
  }

  /** Renders the current frame into the workspace and registers it. */
  async captureFrame(): Promise<{ asset: Asset; warning?: string }> {
    await this.ensureHost();
    const { workspace, pproStillPreset } = await this.client.workspace();
    const context = await this.getContext();
    const compName = typeof context.compName === "string" ? context.compName : "comp";

    // The third argument is the Premiere still preset; After Effects ignores it.
    const captured = await evalHost<CaptureResult>(
      `${hostPrefix()}captureFrame(${quote(workspace.originalsDir)}, ${quote(compName)}, ${
        pproStillPreset ? quote(pproStillPreset) : "null"
      })`,
    );

    /*
     * A Premiere export can succeed and still hand back the wrong frame: if the
     * in point does not land, the range covers the whole sequence and a still
     * exporter writes frame zero. Nothing errors anywhere. So the frame asked
     * for is checked against the one the sequence actually held.
     */
    const diagnostics = captured as {
      inPointSeconds?: number | null;
      trace?: string;
    };
    const landed = diagnostics.inPointSeconds;
    const wanted = captured.timeSeconds;
    const wrongFrame =
      typeof landed === "number" &&
      typeof wanted === "number" &&
      Math.abs(landed - wanted) > 0.5;

    // The service owns path validation, registration and thumbnailing.
    const registered = await this.client.registerCapture({
      path: captured.path,
      context: {
        ...context,
        frameNumber: captured.frameNumber,
        timeSeconds: captured.timeSeconds,
      },
      width: captured.width,
      height: captured.height,
    });

    if (wrongFrame) {
      return {
        ...registered,
        warning:
          `That is the frame at ${(landed as number).toFixed(2)}s, not the ` +
          `${(wanted as number).toFixed(2)}s asked for — the export range did ` +
          `not take. ${diagnostics.trace ?? ""}`,
      };
    }

    /*
     * Premiere reports how it got the frame even when it worked. The failure
     * mode here is a successful-looking export of the wrong frame, which no
     * check on our side can see — only the artist looking at the picture can.
     * So the numbers are put where they can be read against it.
     */
    if (hostApp() === "PPRO" && diagnostics.trace) {
      return { ...registered, warning: diagnostics.trace };
    }
    return registered;
  }

  // --------------------------------------------------------- range export

  /**
   * What the comp currently offers as a range.
   *
   * Read before the artist commits: a work area they had forgotten about is a
   * cheap thing to show and an expensive thing to discover after a render.
   */
  async rangeInfo(): Promise<RangeInfo> {
    await this.ensureHost();
    return evalHost<RangeInfo>(`${hostPrefix()}rangeInfo()`);
  }

  /**
   * Renders a span of the timeline to an mp4 and registers it as a video asset.
   *
   * This is the only way to get a *motion* reference out of a comp. The render
   * is synchronous inside After Effects, so the panel stays busy until it
   * finishes — a few seconds of 1080p is a few seconds of waiting.
   */
  async captureRange(range?: {
    startSeconds?: number;
    durationSeconds?: number;
    /**
     * What the clip is for.
     *
     * `delivery` (the default) keeps it in a codec Ark accepts as a reference —
     * H.264 or H.265, in MP4 or MOV. `quality` renders ProRes 4444 where the
     * host offers it, for a clip that stays local. Less compression is not
     * always better: 4:4:4 that the provider refuses is worse than 4:2:0 that
     * arrives.
     */
    quality?: "delivery" | "quality";
  }): Promise<{ asset: Asset; captured: RangeCaptureResult }> {
    await this.ensureHost();
    const { workspace, pproVideoPreset, pproQualityPreset } = await this.client.workspace();
    const context = await this.getContext();
    const compName = typeof context.compName === "string" ? context.compName : "comp";

    /*
     * The fifth argument is Premiere's preset; After Effects ignores it and
     * renders through its own queue, choosing an output module template from
     * the sixth. Both hosts take the same call, which is what keeps this one
     * method — and both now honour `quality` the only way each host can.
     *
     * Premiere falls back to the delivery preset when no ProRes one has been
     * exported, because a clip in the wrong codec beats no clip at all.
     */
    const preset =
      range?.quality === "quality" && pproQualityPreset
        ? pproQualityPreset
        : pproVideoPreset;
    const captured = await evalHost<RangeCaptureResult>(
      `${hostPrefix()}captureRange(${quote(workspace.originalsDir)}, ${quote(compName)}, ${
        range?.startSeconds ?? "null"
      }, ${range?.durationSeconds ?? "null"}, ${
        preset ? quote(preset) : "null"
      }, ${quote(range?.quality ?? "delivery")})`,
    );

    const { asset } = await this.client.registerClip({
      path: captured.path,
      ...(captured.posterPath ? { posterPath: captured.posterPath } : {}),
      context: {
        ...context,
        frameNumber: captured.frameNumber,
        timeSeconds: captured.startSeconds,
        workAreaStartSeconds: captured.startSeconds,
        workAreaDurationSeconds: captured.durationSeconds,
      },
      width: captured.width,
      height: captured.height,
      durationSeconds: captured.durationSeconds,
      fps: captured.frameRate,
    });

    return { asset, captured };
  }

  /**
   * Adds a clip the artist already has on disk to the library.
   *
   * The path comes from the host's open dialog, because a panel is a browser
   * and a browser only ever learns bytes. Returns nothing if they cancel.
   */
  async addFileFromDisk(): Promise<Asset | undefined> {
    await this.ensureHost();
    const { path } = await evalHost<{ path: string | null }>(
      `${hostPrefix()}pickFile(${quote("Choose a clip or image to add to the library")}, ${quote(
        "Media:*.mp4;*.mov;*.m4v;*.webm;*.png;*.jpg;*.jpeg,All files:*.*",
      )})`,
    );
    if (!path) return undefined;

    // Tagged with whatever is open, so a library filtered to this project
    // still finds the clip that was added while working on it.
    const context = await this.getContext().catch(() => ({}) as Record<string, unknown>);
    const project =
      typeof context.projectName === "string" ? context.projectName : undefined;
    const { asset } = await this.client.adoptFile(path, project);
    return asset;
  }

  // ------------------------------------------------------------- regions

  /**
   * Adds a region guide to the comp.
   *
   * It is a plain shape layer, so it is adjusted with Position and Scale like
   * anything else in the timeline — SEED only reads its transform back.
   */
  async createRegion(size: number, aspect: string): Promise<AeRegion> {
    await this.ensureHost();
    const { region } = await evalHost<{ region: AeRegion }>(
      `${hostPrefix()}createRegion(${Math.round(size)}, ${quote(aspect)})`,
    );
    return region;
  }

  /**
   * Reshapes a region to an aspect and holds it there.
   *
   * An empty aspect frees it again. The hold is an expression on the layer's
   * scale, so it survives a corner drag rather than being corrected after one.
   */
  /**
   * Keeps a region inside the composition, or lets it roam.
   *
   * A modifier key cannot be intercepted mid-drag — After Effects owns the
   * mouse — so this is a state the region is in, enforced by an expression on
   * its Position that stops it at the edge as it is dragged.
   */
  async setRegionContain(name: string, contained: boolean): Promise<AeRegion> {
    await this.ensureHost();
    const { region } = await evalHost<{ region: AeRegion }>(
      `${hostPrefix()}setRegionContain(${quote(name)}, ${contained})`,
    );
    return region;
  }

  async setRegionAspect(name: string, aspect: string): Promise<AeRegion> {
    await this.ensureHost();
    const { region } = await evalHost<{ region: AeRegion }>(
      `${hostPrefix()}setRegionAspect(${quote(name)}, ${quote(aspect)})`,
    );
    return region;
  }

  async listRegions(): Promise<{
    regions: AeRegion[];
    compWidth: number;
    compHeight: number;
  }> {
    await this.ensureHost();
    return evalHost(`${hostPrefix()}listRegions()`);
  }

  /** Renders just the region and registers it, region geometry and all. */
  async captureRegion(
    regionName: string,
    featherPixels: number,
  ): Promise<{
    asset: Asset;
    warning?: string;
    region: AeRegion;
    compName: string;
  }> {
    await this.ensureHost();
    const { workspace } = await this.client.workspace();
    const context = await this.getContext();
    const compName = typeof context.compName === "string" ? context.compName : "comp";

    const captured = await evalHost<
      CaptureResult & { region: AeRegion; compName: string }
    >(
      `${hostPrefix()}captureRegion(${quote(regionName)}, ${quote(
        workspace.originalsDir,
      )}, ${quote(compName)}, ${Math.round(featherPixels)})`,
    );

    const registered = await this.client.registerCapture({
      path: captured.path,
      context: {
        ...context,
        frameNumber: captured.frameNumber,
        timeSeconds: captured.timeSeconds,
        // Provenance has to record which part of the plate this came from, or
        // the crop can never be put back where it belongs.
        region: captured.region,
      },
      width: captured.width,
      height: captured.height,
    });

    return { ...registered, region: captured.region, compName: captured.compName };
  }

  /**
   * Imports a generated clip and composites it back onto its region.
   *
   * The plate is left untouched: the clip arrives as its own feathered layer,
   * so the composite can be adjusted or deleted without rebuilding anything.
   */
  async insertRegion(
    assetId: string,
    options: {
      regionName: string;
      featherPixels: number;
      startSeconds?: number;
      stretchToSeconds?: number;
    },
  ): Promise<AeRegionPlacement> {
    await this.ensureHost();
    const { path, filename } = await this.client.assetPath(assetId);
    const imported = await evalHost<{ projectItemId: string; name: string }>(
      `${hostPrefix()}import(${quote(path)})`,
    );

    const placed = await evalHost<AeRegionPlacement>(
      `${hostPrefix()}insertRegion(${quote(imported.projectItemId)}, ${JSON.stringify(
        options,
      )})`,
    );
    return { ...placed, name: placed.name || filename };
  }

  /**
   * Registers a frame Premiere exported itself.
   *
   * Premiere's Export Frame button produces the right frame where every
   * scripted route produces the first one, so the panel picks up after it
   * rather than trying to replace it.
   */
  async pickupFrame(since: number): Promise<{ asset: Asset; warning?: string }> {
    await this.ensureHost();
    const { workspace } = await this.client.workspace();
    const context = await this.getContext();

    const found = await evalHost<CaptureResult>(
      `${hostPrefix()}pickupFrame(${quote(workspace.originalsDir)}, ${Math.round(since)})`,
    );

    return this.client.registerCapture({
      path: found.path,
      context: {
        ...context,
        frameNumber: found.frameNumber,
        timeSeconds: found.timeSeconds,
      },
      width: found.width,
      height: found.height,
    });
  }

  /**
   * Holds the cut open for a render that has not arrived.
   *
   * The two hosts reserve differently — After Effects by layer, Premiere by
   * track and time — so the handle is opaque and simply given back later.
   */
  async reservePlaceholder(
    label: string,
    durationSeconds: number,
    width: number,
    height: number,
  ): Promise<PlaceholderHandle> {
    await this.ensureHost();
    // Shaped like the render, so the artist frames against the real thing.
    // Its own file, so two reservations cannot end up sharing a project item.
    const { path } = await this.client.placeholder(width, height, label);
    const reserved = await evalHost<PlaceholderHandle>(
      `${hostPrefix()}reservePlaceholder(${quote(path)}, ${durationSeconds}, ${quote(label)})`,
    );
    return { ...reserved, label, cardWidth: width };
  }

  /** What the artist has selected, so its recipe can be reopened. */
  async selectedMedia(): Promise<SelectedMedia> {
    await this.ensureHost();
    return evalHost<SelectedMedia>(`${hostPrefix()}selectedMedia()`);
  }

  /**
   * Turns a layer that already holds a take into the placeholder for the next
   * one, so iterating replaces the shot in place rather than stacking beside it.
   */
  async adoptPlaceholder(
    selection: SelectedMedia,
    label: string,
    width: number,
    height: number,
    sourceWidth?: number,
  ): Promise<PlaceholderHandle> {
    await this.ensureHost();
    const { path } = await this.client.placeholder(width, height, label);
    /*
     * The filename goes with it so the host can confirm it is still replacing
     * the shot the artist chose: both hosts locate the target by a position
     * that other edits can shift underneath it.
     */
    const take = sourceWidth ?? selection.width ?? 0;
    const call =
      hostApp() === "PPRO"
        ? `${hostPrefix()}adoptPlaceholder(${quote(path)}, ${quote(label)}, ${
            selection.trackIndex ?? 0
          }, ${selection.startSeconds ?? 0}, ${quote(selection.filename)}, ${take}, ${width})`
        : `${hostPrefix()}adoptPlaceholder(${quote(path)}, ${quote(label)}, ${
            selection.compId ?? 0
          }, ${selection.layerIndex ?? 0}, ${quote(selection.filename)})`;
    const adopted = await evalHost<PlaceholderHandle>(call);
    return { ...adopted, label, cardWidth: width, sourceWidth: take };
  }

  /**
   * Builds the look as effects on an adjustment layer in the comp.
   *
   * The answer to "where is my filter": the tonal half arrives as a LUT the
   * artist points at once, and the spatial half as real After Effects effects
   * with real controls, in the same order the engine uses.
   */
  async buildLookRig(
    name: string,
    lutPath: string,
    settings: Record<string, number>,
  ): Promise<{
    name: string;
    compName: string;
    applied: string[];
    skipped: string[];
  }> {
    await this.ensureHost();
    return evalHost(
      `${hostPrefix()}buildLookRig(${quote(name)}, ${quote(lutPath)}, ${JSON.stringify(
        settings,
      )})`,
    );
  }

  /** Swaps the finished render in underneath a placeholder. */
  async fillPlaceholder(
    handle: PlaceholderHandle,
    assetId: string,
    mediaWidth?: number,
  ): Promise<{ name: string; swapped?: boolean }> {
    await this.ensureHost();
    const { path } = await this.client.assetPath(assetId);
    /*
     * Premiere is told both sizes because it cannot read the media's own: a
     * project item does not report its dimensions, so the arithmetic has to be
     * handed to it. After Effects reads its footage item directly.
     */
    const call =
      hostApp() === "PPRO"
        ? `${hostPrefix()}fillPlaceholder(${handle.trackIndex ?? 0}, ${
            handle.atSeconds ?? 0
          }, ${quote(path)}, ${quote(handle.label)}, ${handle.cardWidth ?? 0}, ${
            mediaWidth ?? 0
          })`
        : `${hostPrefix()}fillPlaceholder(${quote(handle.label)}, ${quote(path)}, ${
            handle.compId ?? 0
          })`;
    return evalHost(call);
  }

  /** Leaves the placeholder in place, saying what went wrong. */
  async failPlaceholder(
    handle: PlaceholderHandle,
    message: string,
  ): Promise<void> {
    await this.ensureHost();
    /*
     * The restore handle rides along: an adopted placeholder had a take in it
     * before this attempt, and a failed render should leave the artist with
     * the version they already had rather than a striped card.
     */
    const call =
      hostApp() === "PPRO"
        ? `${hostPrefix()}failPlaceholder(${handle.trackIndex ?? 0}, ${
            handle.atSeconds ?? 0
          }, ${quote(message)}, ${quote(handle.label)}, ${
            handle.restoreNodeId ? quote(handle.restoreNodeId) : "null"
          }, ${
            handle.restoreMediaPath ? quote(handle.restoreMediaPath) : '""'
          }, ${handle.sourceWidth ?? 0}, ${handle.cardWidth ?? 0})`
        : `${hostPrefix()}failPlaceholder(${quote(handle.label)}, ${quote(message)}, ${
            handle.compId ?? 0
          }, ${handle.restoreItemId ?? 0}, ${handle.restoreWidth ?? 0})`;
    await evalHost(call);
  }

  async importAsset(
    assetId: string,
    insertAtPlayhead: boolean,
    /** Premiere cannot read a project item's dimensions; it has to be told. */
    mediaWidth?: number,
  ): Promise<{
    name: string;
    insertedAtPlayhead: boolean;
    trackName?: string;
    movedFromTargeted?: string;
  }> {
    await this.ensureHost();
    const { path, filename } = await this.client.assetPath(assetId);
    const imported = await evalHost<{ projectItemId: string; name: string }>(
      `${hostPrefix()}import(${quote(path)})`,
    );

    let placement: InsertResult | undefined;
    if (insertAtPlayhead) {
      placement = await evalHost<InsertResult>(
        `${hostPrefix()}insertAtPlayhead(${quote(imported.projectItemId)}, ${
          mediaWidth ?? 0
        })`,
      );
    }
    return {
      name: imported.name || filename,
      insertedAtPlayhead: insertAtPlayhead,
      ...(placement?.trackName ? { trackName: placement.trackName } : {}),
      ...(placement?.movedFromTargeted
        ? { movedFromTargeted: placement.movedFromTargeted }
        : {}),
    };
  }
}
