import { useEffect, useRef, useState } from "react";
import type { Asset } from "@seed-ae/domain";
import type { SeedClient, JobView } from "../api/client.ts";
import type { ProviderCapabilitiesDto } from "../api/client.ts";
import { AssetImage, SectionLabel } from "./primitives.tsx";
import { colorWarning } from "../colorSummary.ts";
import { hostApp, type CepAeBridge } from "../api/cep.ts";

const SETTLED = ["succeeded", "failed", "cancelled"];

/** Labels for the shipped presets, in the order they should be offered. */
const PRESET_LABELS: Record<string, string> = {
  "show-match": "Show match",
  "clean-optics": "Clean optics",
  "tungsten-500t": "500T tungsten",
  "print-2383": "2383 print",
};

interface Props {
  client: SeedClient;
  /** Present only inside After Effects, where a rig can be built. */
  bridge?: CepAeBridge | undefined;
  asset: Asset;
  /** Absent when the service has not registered the look provider. */
  provider?: ProviderCapabilitiesDto;
  onApplied: (asset: Asset) => void;
  onError: (cause: unknown) => void;
}

/**
 * Treat a frame with the film look.
 *
 * Three controls, in the order an artist reaches for them: which look, how
 * much camera, and go. Everything else lives in the recipe and can be reopened
 * — this is the panel for deciding, not for tuning sixty-six numbers.
 *
 * The comparison is the point. A treated frame is judged against the one it
 * came from or it is not judged at all, and asking someone to hold the
 * original in their memory is how looks get approved that should not have
 * been.
 */
export function LookPanel({
  client,
  bridge,
  asset,
  provider,
  onApplied,
  onError,
}: Props) {
  const [preset, setPreset] = useState("show-match");
  const [intensity, setIntensity] = useState(1);
  const [job, setJob] = useState<JobView | undefined>();
  const [result, setResult] = useState<Asset | undefined>();
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rig, setRig] = useState<
    { lutPath: string; applied: string[]; skipped: string[]; missing: string[] } | undefined
  >();
  const pollRef = useRef<number | undefined>(undefined);

  // A new selection is a new subject; the previous result is not about it.
  useEffect(() => {
    setJob(undefined);
    setResult(undefined);
    setComparing(false);
  }, [asset.id]);

  useEffect(() => {
    return () => {
      if (pollRef.current !== undefined) window.clearTimeout(pollRef.current);
    };
  }, []);

  if (!provider || asset.kind !== "image") return null;

  const presets = provider.models.length > 0 ? provider.models : ["show-match"];
  const warning = asset.source.type === "after-effects"
    ? colorWarning(asset.source.context)
    : undefined;

  const apply = async () => {
    setBusy(true);
    setResult(undefined);
    setComparing(false);
    try {
      const started = await client.startGeneration({
        providerId: provider.id,
        model: preset,
        operation: "image.edit",
        /*
         * The prompt field carries a readable summary. A look has no prompt,
         * but the recipe is read by people as well as by code, and "show-match
         * at 1.0" says more in the library than an empty string.
         */
        prompt: `${PRESET_LABELS[preset] ?? preset} at intensity ${intensity}`,
        inputAssetIds: [asset.id],
        parameters: { intensity },
      });
      setJob(started);
      poll(started.job.id);
    } catch (cause) {
      onError(cause);
      setBusy(false);
    }
  };

  /**
   * Writes the LUT and builds the rig in one gesture.
   *
   * Two calls rather than one because they belong to different processes: the
   * service owns the maths and the filesystem, the panel owns the comp.
   */
  const buildRig = async () => {
    if (!bridge) return;
    setBusy(true);
    setRig(undefined);
    try {
      const lut = await client.lookLut({ preset, intensity });
      const built = await bridge.buildLookRig(preset, lut.path, {
        // The spatial half, in the units After Effects' own effects want.
        grain: intensity * 0.4,
        grainSize: 1,
        vignette: intensity * 0.15,
        halation: intensity * 0.6,
        halationRadius: 24,
        distortion: 0,
      });
      setRig({
        lutPath: lut.path,
        applied: built.applied,
        skipped: built.skipped,
        missing: lut.missing,
      });
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  const poll = (jobId: string) => {
    const tick = async () => {
      try {
        const view = await client.job(jobId);
        setJob(view);
        if (!SETTLED.includes(view.job.status)) {
          pollRef.current = window.setTimeout(tick, 400);
          return;
        }
        setBusy(false);
        const output = view.outputs?.[0];
        if (view.job.status === "succeeded" && output) {
          setResult(output);
          onApplied(output);
        } else if (view.job.status === "failed") {
          onError(new Error(view.job.errorMessage ?? "the look failed"));
        }
      } catch (cause) {
        setBusy(false);
        onError(cause);
      }
    };
    pollRef.current = window.setTimeout(tick, 200);
  };

  return (
    <div className="section">
      <SectionLabel>film look</SectionLabel>

      {warning ? <div className="notice">{warning}</div> : null}

      <div className="row">
        <label className="field">
          <span className="label">Look</span>
          <select
            value={preset}
            onChange={(event) => setPreset(event.target.value)}
            disabled={busy}
          >
            {presets.map((id) => (
              <option key={id} value={id}>
                {PRESET_LABELS[id] ?? id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span className="label">
          Intensity {intensity.toFixed(2)}
          {intensity === 0 ? " — no camera artefacts" : ""}
        </span>
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={intensity}
          disabled={busy}
          onChange={(event) => setIntensity(Number(event.target.value))}
        />
      </label>
      <div className="hint faint">
        How much camera: grain, halation, vignette, aberration and distortion.
        1.0 is the look as authored. Turn it to 0 for footage that already has
        real grain or distortion of its own — doubling them is the classic tell.
      </div>

      <div style={{ height: 8 }} />
      <button className="btn primary wide" onClick={apply} disabled={busy}>
        {busy ? "Treating…" : "Bake onto this frame"}
      </button>

      {bridge && hostApp() === "AEFT" ? (
        <>
          <button
            className="btn wide"
            style={{ marginTop: 6 }}
            onClick={buildRig}
            disabled={busy}
          >
            Add as effects in the comp
          </button>
          <div className="hint faint" style={{ marginTop: 6 }}>
            Puts an adjustment layer over the comp: the look as a LUT, plus
            grain, halation and vignette as ordinary effects you can keyframe.
            Works on moving footage, not just this frame.
          </div>
        </>
      ) : null}

      {rig ? (
        <div className="notice">
          <b>One step left.</b> Select the SEED Look layer, find{" "}
          <b>Apply Color LUT</b>, click <b>Choose LUT</b> and pick:
          <div className="mono" style={{ wordBreak: "break-all", marginTop: 4 }}>
            {rig.lutPath}
          </div>
          <div style={{ marginTop: 6 }}>
            After Effects will not let a script attach a LUT file — the
            parameter takes a number, not a path — so this one click is yours.
          </div>
          {rig.applied.length > 0 ? (
            <div style={{ marginTop: 6 }}>Added: {rig.applied.join(", ")}.</div>
          ) : null}
          {rig.skipped.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              This build of After Effects had no effect for:{" "}
              {rig.skipped.join(", ")}.
            </div>
          ) : null}
          {rig.missing.length > 0 ? (
            <div style={{ marginTop: 6 }}>
              The LUT carries the colour only. {rig.missing.join(", ")} are
              spatial, so they come from the effects above it — or from the bake
              if you want them exactly.
            </div>
          ) : null}
        </div>
      ) : null}

      {busy && job ? (
        <div className="hint faint" style={{ marginTop: 6 }}>
          {job.job.status}
          {asset.width && asset.width > 1500
            ? " — a full-size frame takes a few seconds"
            : ""}
        </div>
      ) : null}

      {result ? (
        <>
          <div style={{ height: 8 }} />
          <div className="preview" style={{ position: "relative" }}>
            <AssetImage client={client} asset={comparing ? asset : result} />
          </div>
          <button
            className="btn wide"
            onMouseDown={() => setComparing(true)}
            onMouseUp={() => setComparing(false)}
            onMouseLeave={() => setComparing(false)}
            onTouchStart={() => setComparing(true)}
            onTouchEnd={() => setComparing(false)}
          >
            {comparing ? "Showing the original" : "Hold to compare"}
          </button>
          <div className="hint faint" style={{ marginTop: 6 }}>
            The treated frame is in the library as a child of this one. The
            original is untouched — select the result to iterate on it, or
            insert it at the playhead.
          </div>
        </>
      ) : null}
    </div>
  );
}
