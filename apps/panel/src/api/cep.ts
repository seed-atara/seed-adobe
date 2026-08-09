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
  if (!cep) throw new Error("not running inside After Effects");
  return decodeURI(cep.getSystemPath("extension")).replace(/^file:\/{2,3}/, "");
}

/**
 * Re-evaluates the ExtendScript host.
 *
 * The manifest's ScriptPath is loaded once when the extension loads, so
 * reloading the panel (Ctrl+R) refreshes the UI while After Effects keeps
 * running the *old* host script — which makes a host fix look like it did
 * nothing. Loading it ourselves on every boot means one reload resets
 * everything, with no need to restart AE.
 */
export async function reloadHostScript(): Promise<void> {
  const cep = window.__adobe_cep__;
  if (!cep) throw new Error("not running inside After Effects");

  const jsxPath = `${extensionRoot()}/jsx/seed-host.jsx`;
  const raw = await new Promise<string>((resolve) => {
    // Returns "true" on success; anything else means AE could not read it.
    cep.evalScript(`$.evalFile(${JSON.stringify(jsxPath)})`, resolve);
  });

  if (raw !== "true") {
    throw new Error(
      `After Effects could not load the host script at ${jsxPath} (${raw})`,
    );
  }
}

interface HostResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

function quote(value: string): string {
  return JSON.stringify(String(value));
}

/** Runs an ExtendScript expression and unwraps the host's JSON envelope. */
async function evalHost<T>(expression: string): Promise<T> {
  const cep = window.__adobe_cep__;
  if (!cep) throw new Error("not running inside After Effects");

  const raw = await new Promise<string>((resolve) => {
    cep.evalScript(expression, resolve);
  });

  if (raw === "EvalScript error.") {
    throw new Error(
      `After Effects could not run ${expression.split("(")[0]} — is the panel's host script loaded?`,
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

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
  frameNumber: number;
  timeSeconds: number;
}

/**
 * Drives After Effects from inside the panel.
 *
 * In CEP the panel — not the service — is the process with AE scripting
 * access, so capture and import happen here and the service is told about the
 * result. The service stays host-agnostic.
 */
export class CepAeBridge {
  readonly id = "cep";

  /** Loaded lazily once per panel session; see reloadHostScript. */
  private hostReady: Promise<void> | undefined;

  constructor(private readonly client: SeedClient) {}

  private ensureHost(): Promise<void> {
    if (!this.hostReady) {
      this.hostReady = reloadHostScript().catch((error: unknown) => {
        // Let the next call retry rather than caching the failure forever.
        this.hostReady = undefined;
        throw error;
      });
    }
    return this.hostReady;
  }

  async ping(): Promise<{ version: string; hasProject: boolean }> {
    await this.ensureHost();
    return evalHost<{ version: string; hasProject: boolean }>("seedPing()");
  }

  async getContext(): Promise<Record<string, unknown>> {
    await this.ensureHost();
    const { context } = await evalHost<AeContextResult>("seedGetContext()");
    return context;
  }

  /** Renders the current frame into the workspace and registers it. */
  async captureFrame(): Promise<Asset> {
    await this.ensureHost();
    const { workspace } = await this.client.workspace();
    const context = await this.getContext();
    const compName = typeof context.compName === "string" ? context.compName : "comp";

    const captured = await evalHost<CaptureResult>(
      `seedCaptureFrame(${quote(workspace.originalsDir)}, ${quote(compName)})`,
    );

    // The service owns path validation, registration and thumbnailing.
    const { asset } = await this.client.registerCapture({
      path: captured.path,
      context: {
        ...context,
        frameNumber: captured.frameNumber,
        timeSeconds: captured.timeSeconds,
      },
      width: captured.width,
      height: captured.height,
    });
    return asset;
  }

  async importAsset(
    assetId: string,
    insertAtPlayhead: boolean,
  ): Promise<{ name: string; insertedAtPlayhead: boolean }> {
    await this.ensureHost();
    const { path, filename } = await this.client.assetPath(assetId);
    const imported = await evalHost<{ projectItemId: string; name: string }>(
      `seedImport(${quote(path)})`,
    );

    if (insertAtPlayhead) {
      await evalHost(`seedInsertAtPlayhead(${quote(imported.projectItemId)})`);
    }
    return { name: imported.name || filename, insertedAtPlayhead: insertAtPlayhead };
  }
}
