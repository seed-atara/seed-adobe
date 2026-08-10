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

/**
 * Drives the host application from inside the panel.
 *
 * In CEP the panel — not the service — is the process with scripting access,
 * so capture and import happen here and the service is told about the result.
 * The service stays host-agnostic, and so does this class: After Effects and
 * Premiere expose the same host functions under the same names.
 */
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

    // The service owns path validation, registration and thumbnailing.
    return this.client.registerCapture({
      path: captured.path,
      context: {
        ...context,
        frameNumber: captured.frameNumber,
        timeSeconds: captured.timeSeconds,
      },
      width: captured.width,
      height: captured.height,
    });
  }

  async importAsset(
    assetId: string,
    insertAtPlayhead: boolean,
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
        `${hostPrefix()}insertAtPlayhead(${quote(imported.projectItemId)})`,
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
