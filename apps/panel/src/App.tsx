import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset, ComposedPlan } from "@seed-ae/domain";
import {
  DEFAULT_BASE_URL,
  SeedClient,
  ServiceError,
  type JobView,
  type ProviderCapabilitiesDto,
} from "./api/client.ts";
import { CepAeBridge, hostApp, isCepHost, type AeRegion } from "./api/cep.ts";
import {
  GenerateView,
  type GenerateForm,
  type RegionSettings,
} from "./components/GenerateView.tsx";
import { LibraryView } from "./components/LibraryView.tsx";
import { AssetDetail } from "./components/AssetDetail.tsx";
import { LineageView } from "./components/LineageView.tsx";
import { findMentions } from "./mentions.ts";

type Tab = "generate" | "library" | "lineage";

const TOKEN_KEY = "seed-ae.session-token";

const EMPTY_FORM: GenerateForm = {
  providerId: "",
  model: "",
  operation: "image.generate",
  prompt: "",
  seed: "",
  size: "",
  durationSeconds: "",
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
  /** Which ExtendScript host answered, so a stale panel is visible not guessed. */
  const [loadedHost, setLoadedHost] = useState<string | undefined>();
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [form, setForm] = useState<GenerateForm>(EMPTY_FORM);
  const [job, setJob] = useState<JobView | undefined>();
  const [error, setError] = useState<string | undefined>();
  /** Non-fatal capture feedback, e.g. a partly rendered frame. */
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [canDirect, setCanDirect] = useState(false);
  const [directing, setDirecting] = useState(false);
  const [plan, setPlan] = useState<ComposedPlan | undefined>();
  const [regions, setRegions] = useState<AeRegion[]>();
  const [region, setRegion] = useState<RegionSettings>({
    name: "",
    newSize: "1024",
    feather: "24",
    startSeconds: "",
    stretchToSeconds: "",
  });

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

        // Direction is optional; a service without a key simply never offers it.
        try {
          const { director } = await client.workspace();
          if (!cancelled) setCanDirect(director);
        } catch {
          // Not knowing means not offering, which is the safe direction.
        }

        try {
          if (bridge) {
            setAeContext(await bridge.getContext());
            // Regions are an After Effects idea; Premiere has no equivalent.
            if (hostApp() === "AEFT") await refreshRegions();
            setHostId(hostApp());
            setLoadedHost(bridge.loadedHost);
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

  /**
   * Reads the comp's region guides back.
   *
   * After Effects owns them — they are ordinary layers the artist can move,
   * rename or delete — so the panel never caches them across an action.
   */
  const refreshRegions = useCallback(async () => {
    if (!bridge) return;
    try {
      const { regions: found } = await bridge.listRegions();
      setRegions(found);
      setRegion((current) =>
        found.some((item) => item.name === current.name)
          ? current
          : { ...current, name: found[0]?.name ?? "" },
      );
    } catch {
      // A comp with no project open is not an error worth interrupting for.
      setRegions([]);
    }
  }, [bridge]);

  const addRegion = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    try {
      const created = await bridge.createRegion(Number(region.newSize) || 1024);
      await refreshRegions();
      setRegion((current) => ({ ...current, name: created.name }));
      setNotice(
        `Added ${created.name} at ${created.width}x${created.height}. ` +
          "Move and scale it in the comp, then capture.",
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [bridge, region.newSize, refreshRegions, report]);

  const captureRegion = useCallback(async () => {
    if (!bridge || !region.name) return;
    setBusy(true);
    setError(undefined);
    try {
      const { asset, warning, region: captured, compName } =
        await bridge.captureRegion(region.name, Number(region.feather) || 0);
      setNotice(
        warning ??
          `Captured ${captured.width}x${captured.height} into “${compName}”, ` +
            "placed back over the plate. Generate, then composite the result.",
      );
      await refreshRegions();
      await refreshAssets();
      setSelectedId(asset.id);
      setForm((current) => ({
        ...current,
        inputAssetIds: [...current.inputAssetIds, asset.id],
      }));
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [bridge, region.name, refreshRegions, refreshAssets, report]);

  /** Composites the finished clip back onto the region it came from. */
  const insertRegion = useCallback(async () => {
    const output = job?.outputs[0];
    if (!bridge || !output || !region.name) return;
    setBusy(true);
    try {
      const placed = await bridge.insertRegion(output.id, {
        regionName: region.name,
        featherPixels: Number(region.feather) || 0,
        ...(Number(region.startSeconds) >= 0 && region.startSeconds.trim()
          ? { startSeconds: Number(region.startSeconds) }
          : {}),
        ...(Number(region.stretchToSeconds) > 0
          ? { stretchToSeconds: Number(region.stretchToSeconds) }
          : {}),
      });
      const retimed =
        Math.round(placed.stretchPercent) === 100
          ? ""
          : ` at ${Math.round(placed.stretchPercent)}% speed`;
      const scaled =
        placed.sourceWidth === placed.width
          ? ""
          : ` (${placed.sourceWidth}x${placed.sourceHeight} scaled to ${placed.width}x${placed.height})`;
      setNotice(
        `Composited ${placed.name} into “${placed.compName}” at ` +
          `${placed.atSeconds.toFixed(2)}s${retimed}${scaled}, ` +
          `${placed.featherPixels}px feather. The plate underneath is untouched.`,
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [bridge, job, region, report]);

  /**
   * Turns the description into a proposed generation.
   *
   * The plan only fills the form — the artist still presses Generate. An agent
   * that queued the job itself would be taking a decision that costs money and
   * belongs to them.
   */
  const directShot = useCallback(async () => {
    setDirecting(true);
    setError(undefined);
    try {
      const mentions = findMentions(form.prompt, assets);
      // What the director gets to look at: what is already attached, what was
      // named, then recent frames — deduplicated, newest last.
      const candidateIds = [
        ...new Set([
          ...form.inputAssetIds,
          ...mentions.map((mention) => mention.assetId),
          ...assets.slice(0, 6).map((asset) => asset.id),
        ]),
      ].slice(0, 8);

      const { plan: composed } = await client.compose({
        description: form.prompt,
        candidateAssetIds: candidateIds,
        mentions,
        ...(form.providerId ? { preferredProviderId: form.providerId } : {}),
        ...(form.parentAssetId ? { parentAssetId: form.parentAssetId } : {}),
        ...(form.parentGenerationId
          ? { parentGenerationId: form.parentGenerationId }
          : {}),
      });

      setPlan(composed);
      setForm((current) => ({
        ...current,
        providerId: composed.providerId,
        model: composed.model,
        operation: composed.operation,
        prompt: composed.prompt,
        ...(composed.size ? { size: composed.size } : {}),
        durationSeconds:
          composed.durationSeconds === undefined
            ? current.durationSeconds
            : String(composed.durationSeconds),
        ...(composed.seed !== undefined ? { seed: String(composed.seed) } : {}),
        inputAssetIds: composed.references.map((reference) => reference.assetId),
      }));
    } catch (cause) {
      report(cause);
    } finally {
      setDirecting(false);
    }
  }, [client, form, assets, report]);

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
        ...(Number(form.durationSeconds) > 0
          ? { durationSeconds: Number(form.durationSeconds) }
          : {}),
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
          durationSeconds:
            typeof recipe.durationSeconds === "number"
              ? String(recipe.durationSeconds)
              : "",
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
        <ContextStrip context={aeContext} host={hostId} loadedHost={loadedHost} />
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
              {...(canDirect ? { onDirect: directShot } : {})}
              directing={directing}
              {...(plan ? { plan } : {})}
              onDismissPlan={() => setPlan(undefined)}
              {...(regions ? { regions } : {})}
              region={region}
              onRegionChange={setRegion}
              onAddRegion={addRegion}
              onCaptureRegion={captureRegion}
              onInsertRegion={insertRegion}
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
  loadedHost,
}: {
  context: Record<string, unknown>;
  host: string;
  loadedHost?: string | undefined;
}) {
  const comp = typeof context.compName === "string" ? context.compName : undefined;
  const hostLabel =
    host === "AEFT" ? "AE" : host === "PPRO" ? "PPRO" : host === "unknown" ? "CEP" : "MOCK";
  // A script from the other application means the panel bundle is stale.
  const scriptLabel =
    loadedHost === "premiere-pro" ? "pp" : loadedHost === "after-effects" ? "ae" : "?";
  const mismatch =
    (host === "PPRO" && loadedHost === "after-effects") ||
    (host === "AEFT" && loadedHost === "premiere-pro");

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
        <span
          className="status-cell"
          title={`host script: ${loadedHost ?? "not loaded"}`}
        >
          {hostLabel}
          {host !== "mock" ? `·${scriptLabel}` : ""}
          {mismatch ? " STALE" : ""}
        </span>
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
      <span className="status-cell" title={`host script: ${loadedHost ?? "not loaded"}`}>
        {hostLabel}
        {host !== "mock" ? `·${scriptLabel}` : ""}
      </span>
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
