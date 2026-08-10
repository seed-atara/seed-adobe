import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import {
  DEFAULT_BASE_URL,
  SeedClient,
  ServiceError,
  type JobView,
  type ProviderCapabilitiesDto,
} from "./api/client.ts";
import { CepAeBridge, hostApp, isCepHost } from "./api/cep.ts";
import { GenerateView, type GenerateForm } from "./components/GenerateView.tsx";
import { LibraryView } from "./components/LibraryView.tsx";
import { AssetDetail } from "./components/AssetDetail.tsx";
import { LineageView } from "./components/LineageView.tsx";

type Tab = "generate" | "library" | "lineage";

const TOKEN_KEY = "seed-ae.session-token";

const EMPTY_FORM: GenerateForm = {
  providerId: "",
  model: "",
  operation: "image.generate",
  prompt: "",
  seed: "",
  size: "",
  inputAssetIds: [],
};

export function App() {
  const [token, setToken] = useState(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );
  // Derived from the stored token on the first render, not in an effect: with
  // no token there is nothing the shell could usefully do, and defaulting to
  // "connecting" made it flash a dead UI before redirecting.
  const [connection, setConnection] = useState<
    "connecting" | "live" | "unauthorized" | "down"
  >(() => (localStorage.getItem(TOKEN_KEY) ? "connecting" : "unauthorized"));
  const [connectionMessage, setConnectionMessage] = useState("");

  const client = useMemo(
    () => new SeedClient(DEFAULT_BASE_URL, token),
    [token],
  );

  /**
   * Inside After Effects the panel owns the AE scripting connection, so it
   * captures and imports directly. In a browser it falls back to the service's
   * host adapter, which keeps the whole product testable without Adobe.
   */
  const bridge = useMemo(
    () => (isCepHost() ? new CepAeBridge(client) : undefined),
    [client],
  );

  const [tab, setTab] = useState<Tab>("generate");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [providers, setProviders] = useState<ProviderCapabilitiesDto[]>([]);
  const [aeContext, setAeContext] = useState<Record<string, unknown>>({});
  const [hostId, setHostId] = useState("mock");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [form, setForm] = useState<GenerateForm>(EMPTY_FORM);
  const [job, setJob] = useState<JobView | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** Non-fatal capture feedback, e.g. a partly rendered frame. */
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const selected = assets.find((asset) => asset.id === selectedId);

  const report = useCallback((cause: unknown) => {
    const message =
      cause instanceof ServiceError ? cause.message : String(cause);
    setError(message);
    if (cause instanceof ServiceError && cause.status === 401) {
      setConnection("unauthorized");
    }
  }, []);

  const refreshAssets = useCallback(async () => {
    try {
      const { assets: list } = await client.listAssets({ limit: 120 });
      setAssets(list);
    } catch (cause) {
      report(cause);
    }
  }, [client, report]);

  // Connect, then load everything the panel needs to be useful.
  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setConnection("unauthorized");
      return;
    }

    (async () => {
      try {
        await client.health();
        const { providers: caps } = await client.providers();
        if (cancelled) return;

        // Providers and the form come first and unconditionally. Reading the
        // AE context is allowed to fail — a panel with empty dropdowns is
        // useless, whereas a panel that cannot yet see a comp is merely
        // waiting for one.
        setProviders(caps);
        setConnection("live");
        setConnectionMessage("");
        setForm((current) =>
          current.providerId
            ? current
            : {
                ...current,
                providerId: caps[0]?.id ?? "",
                model: caps[0]?.models[0] ?? "",
                size: caps[0]?.sizes[0] ?? "",
              },
        );
        await refreshAssets();

        try {
          if (bridge) {
            setAeContext(await bridge.getContext());
            setHostId(hostApp());
          } else {
            const { context, host } = await client.aeContext();
            setAeContext(context);
            setHostId(host);
          }
        } catch (hostCause) {
          if (!cancelled) report(hostCause);
        }
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ServiceError && cause.status === 401) {
          setConnection("unauthorized");
          setConnectionMessage("That session token was rejected.");
        } else {
          setConnection("down");
          setConnectionMessage(
            cause instanceof ServiceError
              ? cause.message
              : "Cannot reach the SEED service.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, token, refreshAssets, bridge, report]);

  // Keep the comp context readout honest while the artist moves the playhead.
  useEffect(() => {
    if (connection !== "live") return;
    const timer = setInterval(() => {
      const read = bridge
        ? bridge.getContext()
        : client.aeContext().then(({ context }) => context);
      read.then(setAeContext).catch(() => undefined);
    }, 4000);
    return () => clearInterval(timer);
  }, [client, connection, bridge]);

  // Poll the active job until it settles, then pull in its outputs.
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!job || ["succeeded", "failed", "cancelled"].includes(job.job.status)) {
      return;
    }
    pollRef.current = window.setTimeout(async () => {
      try {
        const next = await client.job(job.job.id);
        setJob(next);
        if (next.job.status === "succeeded") {
          await refreshAssets();
          const first = next.outputs[0];
          if (first) setSelectedId(first.id);
        }
      } catch (cause) {
        report(cause);
      }
    }, 700);
    return () => window.clearTimeout(pollRef.current);
  }, [client, job, refreshAssets, report]);

  const captureFrame = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { asset, warning } = bridge
        ? await bridge.captureFrame()
        : await client.captureFrame();
      setNotice(warning);
      await refreshAssets();
      setSelectedId(asset.id);
      // A fresh capture is almost always the next reference.
      setForm((current) => ({
        ...current,
        inputAssetIds: [...current.inputAssetIds, asset.id],
        operation: "image.edit",
      }));
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [client, bridge, refreshAssets, report]);

  const startGeneration = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await client.startGeneration({
        providerId: form.providerId,
        model: form.model || undefined,
        operation: form.operation,
        prompt: form.prompt,
        ...(form.seed.trim() ? { seed: form.seed.trim() } : {}),
        ...(form.size ? { size: form.size } : {}),
        inputAssetIds: form.inputAssetIds,
        ...(form.parentAssetId ? { parentAssetId: form.parentAssetId } : {}),
        ...(form.parentGenerationId
          ? { parentGenerationId: form.parentGenerationId }
          : {}),
      });
      setJob(started);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [client, form, report]);

  const cancelJob = useCallback(async () => {
    if (!job) return;
    try {
      setJob(await client.cancelJob(job.job.id));
    } catch (cause) {
      report(cause);
    }
  }, [client, job, report]);

  /** Loads a stored recipe into the form so a variation branches from it. */
  const openRecipe = useCallback(
    async (asset: Asset) => {
      try {
        const { recipe } = await client.recipe(asset.id);
        setForm({
          providerId: recipe.providerId,
          model: recipe.model ?? "",
          operation: recipe.operation,
          prompt: recipe.prompt,
          seed: recipe.seed === undefined ? "" : String(recipe.seed),
          size: typeof recipe.size === "string" ? recipe.size : "",
          inputAssetIds: recipe.inputAssetIds ?? [],
          parentAssetId: recipe.parentAssetId,
          parentGenerationId: recipe.parentGenerationId,
        });
        setTab("generate");
      } catch (cause) {
        report(cause);
      }
    },
    [client, report],
  );

  const addReference = useCallback((asset: Asset) => {
    setForm((current) =>
      current.inputAssetIds.includes(asset.id)
        ? current
        : { ...current, inputAssetIds: [...current.inputAssetIds, asset.id] },
    );
    setTab("generate");
  }, []);

  if (connection === "unauthorized" || connection === "down") {
    return (
      <ConnectScreen
        message={connectionMessage}
        initialToken={token}
        onConnect={(next) => {
          localStorage.setItem(TOKEN_KEY, next);
          setToken(next);
          setConnection("connecting");
        }}
      />
    );
  }

  return (
    <div className="shell" data-host={bridge ? "cep" : "browser"}>
      <div className="titlebar">
        <span className="icon">S</span>
        <span className="label">SEED / AE</span>
        <span className="controls">
          <button className="ctl" tabIndex={-1} aria-hidden="true">
            _
          </button>
          <button className="ctl" tabIndex={-1} aria-hidden="true">
            &#9633;
          </button>
          <button className="ctl" tabIndex={-1} aria-hidden="true">
            &times;
          </button>
        </span>
      </div>

      <div className="statusbar">
        <span className={`led ${connection === "live" ? "live" : ""}`} />
        <ContextStrip context={aeContext} host={hostId} />
      </div>

      <nav className="tabs" role="tablist">
        {(["generate", "library", "lineage"] as Tab[]).map((name) => (
          <button
            key={name}
            role="tab"
            className="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
          >
            {name}
            {name === "library" && assets.length > 0 ? (
              <span className="count">{assets.length}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="body">
        <main className="column">
          {error ? <div className="notice error">{error}</div> : null}
          {notice ? <div className="notice">{notice}</div> : null}

          {tab === "generate" ? (
            <GenerateView
              client={client}
              providers={providers}
              assets={assets}
              form={form}
              job={job}
              busy={busy}
              onFormChange={setForm}
              onCapture={captureFrame}
              onGenerate={startGeneration}
              onCancel={cancelJob}
              onOpenLibrary={() => setTab("library")}
            />
          ) : null}

          {tab === "library" ? (
            <LibraryView
              client={client}
              assets={assets}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}

          {tab === "lineage" ? (
            <LineageView
              client={client}
              assetId={selectedId}
              onSelect={setSelectedId}
            />
          ) : null}
        </main>

        {selected ? (
          <aside className="column detail">
            <AssetDetail
              client={client}
              bridge={bridge}
              asset={selected}
              onVariation={openRecipe}
              onUseAsReference={addReference}
              onError={report}
              onShowLineage={() => setTab("lineage")}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function ContextStrip({
  context,
  host,
}: {
  context: Record<string, unknown>;
  host: string;
}) {
  const comp = typeof context.compName === "string" ? context.compName : undefined;
  const hostLabel =
    host === "AEFT" ? "AE" : host === "PPRO" ? "PPRO" : host === "unknown" ? "CEP" : "MOCK";

  if (!comp) {
    return (
      <>
        <span className="status-cell grow">
          {host === "mock"
            ? "Mock host - no Adobe application"
            : host === "PPRO"
              ? "No active sequence"
              : "No active composition"}
        </span>
        <span className="status-cell">{hostLabel}</span>
      </>
    );
  }

  const { width, height, fps, frameNumber } = context as {
    width?: number;
    height?: number;
    fps?: number;
    frameNumber?: number;
  };

  return (
    <>
      <span className="status-cell grow" title={comp}>
        {comp}
      </span>
      <span className="status-cell">
        {width}x{height}
      </span>
      <span className="status-cell">{fps ? `${fps}fps` : "-"}</span>
      <span className="status-cell">f{frameNumber ?? "-"}</span>
      <span className="status-cell">{hostLabel}</span>
    </>
  );
}

function ConnectScreen({
  message,
  initialToken,
  onConnect,
}: {
  message: string;
  initialToken: string;
  onConnect: (token: string) => void;
}) {
  const [value, setValue] = useState(initialToken);
  return (
    <div className="connect">
      <form
        className="connect-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (value.trim()) onConnect(value.trim());
        }}
      >
        <div className="titlebar">
          <span className="icon">S</span>
          <span className="label">Connect to SEED service</span>
        </div>
        <div className="connect-body">
          <div className="notice">
            {message ||
              "Paste the session token the local service printed at startup."}
          </div>
          <label className="field">
            <span>Session token:</span>
            <input
              type="password"
              value={value}
              autoFocus
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <div className="connect-actions">
            <button className="btn primary" type="submit">
              OK
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
