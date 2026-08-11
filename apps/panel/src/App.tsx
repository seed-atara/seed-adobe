import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset, ComposedPlan } from "@seed-ae/domain";
import {
  DEFAULT_BASE_URL,
  SeedClient,
  ServiceError,
  type JobView,
  type ProviderCapabilitiesDto,
} from "./api/client.ts";
import {
  CepAeBridge,
  hostApp,
  isCepHost,
  type AeRegion,
  type PlaceholderHandle,
} from "./api/cep.ts";
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

/** Job statuses that will not change again. */
const SETTLED = ["succeeded", "failed", "cancelled"];

/**
 * When this panel loaded.
 *
 * A picked-up frame has to be newer than this, so yesterday's export in the
 * same folder can never be adopted as today's capture.
 */
const sessionStartedAt = Date.now();

/**
 * The shape the render will come back in.
 *
 * A frame-anchored generation takes its shape from the first frame — the API
 * refuses a ratio alongside one and says so — so the reference decides. Failing
 * that the chosen aspect decides, and failing that it is 16:9. The height comes
 * from the resolution keyword, since that is what the keyword means.
 */
function expectedShape(
  form: GenerateForm,
  assets: Asset[],
  compWidth: number,
  compHeight: number,
): { width: number; height: number } {
  const HEIGHTS: Record<string, number> = {
    "480p": 480,
    "720p": 720,
    "1080p": 1080,
    "2K": 1440,
    "4K": 2160,
  };
  let height = HEIGHTS[form.size] ?? 1080;

  const first = assets.find((asset) => asset.id === form.inputAssetIds[0]);
  let aspect =
    first?.width && first?.height ? first.width / first.height : undefined;

  if (aspect === undefined && form.aspectRatio.includes(":")) {
    const [w, h] = form.aspectRatio.split(":").map(Number);
    if (w && h) aspect = w / h;
  }

  let width = Math.round(height * (aspect ?? 16 / 9));

  /*
   * Fitted inside the comp so the card sits at 100% and shows its true shape.
   * A card larger than the frame is scaled by the host on arrival, and that
   * scale then has to be undone when the render swaps in.
   */
  if (compWidth > 0 && compHeight > 0) {
    const fit = Math.min(compWidth / width, compHeight / height);
    if (fit < 1) {
      width = Math.round(width * fit);
      height = Math.round(height * fit);
    }
  }

  return { width, height };
}



const EMPTY_FORM: GenerateForm = {
  providerId: "",
  model: "",
  operation: "image.generate",
  prompt: "",
  seed: "",
  size: "",
  durationSeconds: "",
  generateAudio: false,
  reserveSpace: true,
  inputRoles: [],
  variants: "1",
  aspectRatio: "",
  aspectSourceId: "",
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
  /*
   * Several jobs, not one. A generation is a roll of the dice, and comparing
   * a few is how anyone actually chooses — a panel that can only hold the most
   * recent result forces that comparison to happen in someone's memory.
   */
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [error, setError] = useState<string | undefined>();
  /** Non-fatal capture feedback, e.g. a partly rendered frame. */
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [canDirect, setCanDirect] = useState(false);
  const [originalsDir, setOriginalsDir] = useState<string>();
  /** Reserved timeline space, by job id, waiting for its render. */
  const placeholders = useRef(new Map<string, PlaceholderHandle>());
  const [directing, setDirecting] = useState(false);
  const [plan, setPlan] = useState<ComposedPlan | undefined>();
  const [regions, setRegions] = useState<AeRegion[]>();
  const [region, setRegion] = useState<RegionSettings>({
    name: "",
    newSize: "1024",
    feather: "24",
    startSeconds: "",
    stretchToSeconds: "",
    aspect: "",
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
          const { director, workspace } = await client.workspace();
          if (!cancelled) {
            setCanDirect(director);
            setOriginalsDir(workspace.originalsDir);
          }
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

  // Poll every job that has not settled, so variants land as they finish.
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = jobs.filter(
      (entry) => !SETTLED.includes(entry.job.status),
    );
    if (pending.length === 0) return;

    pollRef.current = window.setTimeout(async () => {
      try {
        const updated = await Promise.all(
          pending.map((entry) => client.job(entry.job.id)),
        );
        const byId = new Map(updated.map((entry) => [entry.job.id, entry]));
        setJobs((current) =>
          current.map((entry) => byId.get(entry.job.id) ?? entry),
        );

        if (updated.some((entry) => entry.job.status === "succeeded")) {
          await refreshAssets();
          // Select the first result, and only the first: re-selecting on every
          // later arrival would move the selection out from under a comparison.
          setSelectedId((current) => {
            if (current) return current;
            for (const entry of updated) {
              const first = entry.outputs[0];
              if (first) return first.id;
            }
            return current;
          });
        }
      } catch (cause) {
        report(cause);
      }
    }, 700);
    return () => window.clearTimeout(pollRef.current);
  }, [client, jobs, bridge, refreshAssets, report]);

  /**
   * Removes an asset from the library and deletes its media.
   *
   * Asked for plainly first, because the bytes do not come back. The record
   * survives so recipes that used the frame still resolve, and the count of
   * those recipes is part of the question — removing something three
   * generations were built on is a different decision from clearing a stray
   * capture.
   */
  const removeAsset = useCallback(
    async (asset: Asset) => {
      const confirmed = window.confirm(
        `Remove ${asset.filename}?

` +
          "The media file is deleted and cannot be recovered. The record stays, " +
          "so recipes that used it still resolve.",
      );
      if (!confirmed) return;

      setBusy(true);
      try {
        const { usedBy } = await client.removeAsset(asset.id);
        setSelectedId((current) => (current === asset.id ? undefined : current));
        setForm((current) => ({
          ...current,
          inputAssetIds: current.inputAssetIds.filter((id) => id !== asset.id),
        }));
        await refreshAssets();
        setNotice(
          `Removed ${asset.filename}.` +
            (usedBy > 0
              ? ` ${usedBy} recorded generation${usedBy === 1 ? "" : "s"} still names it.`
              : ""),
        );
      } catch (cause) {
        report(cause);
      } finally {
        setBusy(false);
      }
    },
    [client, refreshAssets, report],
  );

  /**
   * Fills reserved space once its render exists.
   *
   * Driven by the jobs themselves rather than by the polling tick. Polling
   * stops the moment everything settles, so a fill attempted there is missed
   * whenever the outputs arrive a beat after the status does — and then the
   * placeholder sits in the timeline forever with the render sitting in the
   * library beside it.
   */
  useEffect(() => {
    if (!bridge || placeholders.current.size === 0) return;

    for (const entry of jobs) {
      const handle = placeholders.current.get(entry.job.id);
      if (!handle) continue;

      if (entry.job.status === "succeeded") {
        const output = entry.outputs[0];
        if (!output) continue; // the media is still being registered
        placeholders.current.delete(entry.job.id);
        void bridge
          .fillPlaceholder(handle, output.id, output.width)
          .then((filled) =>
            setNotice(
              `${filled.name} is in the timeline` +
                (filled.swapped === false
                  ? " — the placeholder was replaced rather than swapped, so any trimming is gone."
                  : "."),
            ),
          )
          .catch(report);
      } else if (["failed", "cancelled"].includes(entry.job.status)) {
        placeholders.current.delete(entry.job.id);
        void bridge
          .failPlaceholder(handle, entry.job.errorMessage ?? entry.job.status)
          .catch(() => {
            // The placeholder staying put is the point; naming it is not.
          });
      }
    }
  }, [jobs, bridge, report]);

  /**
   * Attaches a fresh capture, keeping only as many references as the provider
   * takes.
   *
   * The alternative — refusing to capture once the references are full — makes
   * a multi-region plate impossible to work through, and the assets belong in
   * the library either way.
   */
  const attachReference = useCallback(
    (assetId: string) =>
      setForm((current) => {
        const limit = Math.max(
          1,
          providers.find((item) => item.id === current.providerId)
            ?.maxImageReferences ?? 1,
        );
        const keep = current.inputAssetIds
          .map((id, index) => ({ id, role: current.inputRoles[index] ?? "reference" }))
          .filter((entry) => entry.id !== assetId);
        // A lone reference anchors the shot; one of several is a reference.
        keep.push({ id: assetId, role: keep.length === 0 ? "first" : "reference" });
        const trimmed = keep.slice(-limit);
        return {
          ...current,
          inputAssetIds: trimmed.map((entry) => entry.id),
          inputRoles: trimmed.map((entry) => entry.role),
        };
      }),
    [providers],
  );

  /**
   * Registers a frame Premiere exported through its own Export Frame button.
   *
   * Only files written since the panel loaded are considered, so an older
   * export cannot be adopted twice or mistaken for a new one.
   */
  const pickupFrame = useCallback(async () => {
    if (!bridge) return;
    setBusy(true);
    setError(undefined);
    try {
      const { asset, warning } = await bridge.pickupFrame(sessionStartedAt);
      setNotice(warning ?? `Picked up ${asset.filename}.`);
      await refreshAssets();
      setSelectedId(asset.id);
      attachReference(asset.id);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [bridge, refreshAssets, attachReference, report]);

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
      // A fresh capture is almost always the next reference — but only an
      // image provider can edit one, and quietly switching a video provider's
      // operation is what produced "seedance does not support image.edit".
      attachReference(asset.id);
      setForm((current) =>
        providers
          .find((item) => item.id === current.providerId)
          ?.operations.includes("image.edit")
          ? { ...current, operation: "image.edit" }
          : current,
      );
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [client, bridge, refreshAssets, attachReference, providers, report]);

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
      const created = await bridge.createRegion(
        Number(region.newSize) || 1024,
        region.aspect,
      );
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
  }, [bridge, region.newSize, region.aspect, refreshRegions, report]);

  /** Keeps the selected region inside the comp, or lets it roam. */
  const setRegionContain = useCallback(
    async (contained: boolean) => {
      if (!bridge || !region.name) return;
      try {
        const updated = await bridge.setRegionContain(region.name, contained);
        await refreshRegions();
        setNotice(
          contained
            ? `${updated.name} now stops at the comp edges.`
            : `${updated.name} can move outside the comp again.`,
        );
      } catch (cause) {
        report(cause);
      }
    },
    [bridge, region.name, refreshRegions, report],
  );

  /**
   * Holds a region to a shape, or frees it.
   *
   * The constraint is an expression on the layer's scale, so it survives a
   * corner drag instead of being corrected after one — the region stays
   * generatable however the artist reframes it.
   */
  const setRegionAspect = useCallback(
    async (aspect: string) => {
      setRegion((current) => ({ ...current, aspect }));
      if (!bridge || !region.name) return;
      try {
        const updated = await bridge.setRegionAspect(region.name, aspect);
        await refreshRegions();
        setNotice(
          aspect
            ? `${updated.name} is now ${updated.width}x${updated.height} and held at ${aspect} while you scale it.`
            : `${updated.name} scales freely again.`,
        );
      } catch (cause) {
        report(cause);
      }
    },
    [bridge, region.name, refreshRegions, report],
  );

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
      attachReference(asset.id);
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [bridge, region.name, refreshRegions, refreshAssets, attachReference, report]);

  /** Composites the finished clip back onto the region it came from. */
  const insertRegion = useCallback(async () => {
    // Whatever is selected — which, with variants, is the one they chose.
    const output =
      assets.find((asset) => asset.id === selectedId) ??
      jobs.flatMap((entry) => entry.outputs)[0];
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
  }, [bridge, jobs, assets, selectedId, region, report]);

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

      /*
       * Once the artist has attached references, those are the references.
       * Offering the library alongside them invites the director to go
       * shopping — swapping in a frame nobody chose and dropping one that was
       * deliberately set as the last frame. Recent captures are only offered
       * when nothing has been chosen at all, where a suggestion is useful
       * rather than presumptuous.
       */
      const chosen = [
        ...new Set([
          ...form.inputAssetIds,
          ...mentions.map((mention) => mention.assetId),
        ]),
      ];
      const candidateIds = (
        chosen.length > 0 ? chosen : assets.slice(0, 6).map((asset) => asset.id)
      ).slice(0, 8);

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
      // The references stay the artist's when they chose them; the director
      // wrote the prompt for that set, not a different one.
      const keepReferences = chosen.length > 0;
      setForm((current) => ({
        ...current,
        providerId: composed.providerId,
        model: composed.model,
        operation: composed.operation,
        prompt: composed.prompt,
        ...(composed.size ? { size: composed.size } : {}),
        ...(composed.aspectRatio ? { aspectRatio: composed.aspectRatio } : {}),
        durationSeconds:
          composed.durationSeconds === undefined
            ? current.durationSeconds
            : String(composed.durationSeconds),
        ...(composed.seed !== undefined ? { seed: String(composed.seed) } : {}),
        ...(keepReferences
          ? {}
          : {
              inputAssetIds: composed.references.map((r) => r.assetId),
              inputRoles: composed.references.map(() => "reference" as const),
            }),
      }));
    } catch (cause) {
      report(cause);
    } finally {
      setDirecting(false);
    }
  }, [client, form, assets, report]);

  /**
   * Starts one generation per variant.
   *
   * Each gets its own seed, so the set differs on purpose rather than by luck
   * — and so any one of them can be reproduced or branched from later. A
   * provider that ignores seeds still returns different results; it just
   * cannot promise the same one twice.
   */
  const startGeneration = useCallback(async () => {
    const count = Math.min(Math.max(Number(form.variants) || 1, 1), 4);
    const provider = providers.find((item) => item.id === form.providerId);
    const base = Number(form.seed.trim());
    const seeds =
      provider?.seed === false
        ? []
        : Number.isFinite(base) && form.seed.trim()
          ? // A stated seed anchors the set: the first is exactly what was
            // asked for, and the rest step away from it predictably.
            Array.from({ length: count }, (_, index) => base + index)
          : Array.from({ length: count }, () =>
              Math.floor(Math.random() * 2_147_483_647),
            );

    setBusy(true);
    setError(undefined);
    setJobs([]);
    /*
     * The selection stays. It is usually the frame this generation is built
     * from, and clearing it empties the asset panel at the exact moment the
     * artist wants to keep looking at what they are generating from. Results
     * are chosen from their own cards.
     */
    try {
      const started = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          client.startGeneration({
            providerId: form.providerId,
            model: form.model || undefined,
            operation: form.operation,
            prompt: form.prompt,
            ...(seeds[index] !== undefined ? { seed: seeds[index] } : {}),
            ...(form.size ? { size: form.size } : {}),
            ...(form.aspectRatio ? { aspectRatio: form.aspectRatio } : {}),
        ...(form.inputRoles.length === form.inputAssetIds.length &&
        form.inputRoles.some((role) => role !== "reference")
          ? { inputRoles: form.inputRoles }
          : {}),
            ...(Number(form.durationSeconds) > 0
              ? { durationSeconds: Number(form.durationSeconds) }
              : {}),
            ...(form.generateAudio ? { generateAudio: true } : {}),
            inputAssetIds: form.inputAssetIds,
            ...(form.parentAssetId ? { parentAssetId: form.parentAssetId } : {}),
            ...(form.parentGenerationId
              ? { parentGenerationId: form.parentGenerationId }
              : {}),
          }),
        ),
      );
      setJobs(started);

      /*
       * Hold the cut open, but only for a single video: with variants the
       * artist is choosing between takes afterwards, and four placeholders on
       * the timeline would be four things to clean up rather than one to fill.
       */
      if (
        bridge &&
        form.reserveSpace &&
        form.operation === "video.generate" &&
        started.length === 1
      ) {
        const job = started[0];
        const seconds = Number(form.durationSeconds) || 5;
        try {
          if (job) {
            const shape = expectedShape(
              form,
              assets,
              Number(aeContext.width) || 0,
              Number(aeContext.height) || 0,
            );
            const handle = await bridge.reservePlaceholder(
              job.job.id.slice(0, 12),
              seconds,
              shape.width,
              shape.height,
            );
            placeholders.current.set(job.job.id, handle);
            setNotice(
              `Holding ${seconds}s${handle.trackName ? ` on ${handle.trackName}` : ""}` +
                " while this renders.",
            );
          }
        } catch (cause) {
          // Reserving is a convenience; failing to reserve must not stop the
          // generation that is already running.
          report(cause);
        }
      }
    } catch (cause) {
      report(cause);
    } finally {
      setBusy(false);
    }
  }, [client, form, providers, report]);

  /** Cancels everything still running — variants are started together. */
  const cancelJob = useCallback(async () => {
    const running = jobs.filter((entry) => !SETTLED.includes(entry.job.status));
    if (running.length === 0) return;
    try {
      const cancelled = await Promise.all(
        running.map((entry) => client.cancelJob(entry.job.id)),
      );
      const byId = new Map(cancelled.map((entry) => [entry.job.id, entry]));
      setJobs((current) =>
        current.map((entry) => byId.get(entry.job.id) ?? entry),
      );
    } catch (cause) {
      report(cause);
    }
  }, [client, jobs, report]);

  /** Loads a stored recipe into the form so a variation branches from it. */
  const openRecipe = useCallback(
    async (asset: Asset) => {
      try {
        const { recipe } = await client.recipe(asset.id);
        setForm((current) => ({
          ...current,
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
          aspectRatio:
            typeof recipe.aspectRatio === "string" ? recipe.aspectRatio : "",
          generateAudio: recipe.generateAudio === true,
          inputAssetIds: recipe.inputAssetIds ?? [],
          parentAssetId: recipe.parentAssetId,
          parentGenerationId: recipe.parentGenerationId,
          // Roles are not stored on a recipe yet, so a reopened one starts
          // fresh rather than claiming an arrangement it does not have.
          inputRoles: [],
        }));
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
              jobs={jobs}
              {...(selectedId ? { selectedId } : {})}
              onSelect={setSelectedId}
              busy={busy}
              host={hostId}
              {...(originalsDir ? { originalsDir } : {})}
              onPickupFrame={pickupFrame}
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
              onRefreshRegions={refreshRegions}
              onRegionAspect={setRegionAspect}
              onRegionContain={setRegionContain}
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
              onRemove={removeAsset}
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
