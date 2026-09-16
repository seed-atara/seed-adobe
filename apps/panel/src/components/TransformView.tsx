import { useEffect, useMemo, useState } from "react";
import { DEFAULT_DEPTH, depthFor } from "@seed-ae/domain";
import type { Asset, TransformPresetId } from "@seed-ae/domain";
import type { JobView, ProviderCapabilitiesDto, SeedClient } from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";
import { JobStrip } from "./JobStrip.tsx";
import { useClipLibrary } from "./useClipLibrary.ts";

/**
 * Transform — the same plate, in a different season, hour or weather.
 *
 * A separate tab from Restore because they are separate jobs that fail in
 * opposite directions, and putting them behind one toggle would hide exactly
 * the distinction that makes this one work. Restoration holds everything and
 * improves the rendering; a transformation changes one thing on purpose, and
 * the whole difficulty is that a model given permission to change one thing
 * will change all of them.
 *
 * That is not a theory. Summer-to-winter run through the restore path came
 * back as a different shot that happened to be wintry — the camera had moved,
 * the buildings had changed shape, the people were other people. Two causes,
 * both now fixed upstream of this file: restoration's freedom slider granted a
 * blanket licence over every surface in order to obtain one change, and its
 * key-frame prompt forbade the very change being asked for.
 *
 * So the controls here are deliberately not restoration's under new names.
 * There is no freedom slider. There is a **depth** — how far into the scene
 * the named change reaches — and the plate lock holds at every setting of it.
 *
 * The third thing on screen has no analogue in Restore at all: a **plate
 * check**. "Is it sharper" is a taste question and gets judged by eye. "Did
 * anything move" is not, and it is the question that gets work rejected, so it
 * gets a number — before the expensive half of the job is paid for.
 */

interface Preset {
  id: TransformPresetId;
  label: string;
  purpose: string;
  /** Starting text for the Change field. Not a hidden prompt. */
  change: string;
}

interface Agreement {
  measured: number;
  skipped: number;
  medianDistance: number;
  worst?: { column: number; row: number; distance: number; confidence: number };
  held: number;
  saturated: number;
  truncated: boolean;
  tolerance: number;
}

interface Props {
  client: SeedClient;
  assets: Asset[];
  providers: ProviderCapabilitiesDto[];
  jobs: JobView[];
  busy: boolean;
  activeProject?: string;
  onError: (message: string) => void;
  onJobs: (jobs: JobView[]) => void;
  onCancel: () => void;
  onCaptureRange?: () => void;
  onAddFile?: () => void;
  onOpenLibrary: () => void;
  host?: string;
}

export function TransformView({
  client,
  assets,
  providers,
  jobs,
  busy,
  activeProject,
  onError,
  onJobs,
  onCancel,
  onCaptureRange,
  onAddFile,
  onOpenLibrary,
  host,
}: Props) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<TransformPresetId>("winter");
  const [change, setChange] = useState("");
  /** How far into the scene the change reaches. Never a licence over the plate. */
  const [depth, setDepth] = useState(DEFAULT_DEPTH);
  const [atSeconds, setAtSeconds] = useState(0);
  /** The plate frame actually pulled — and the left half of the comparison. */
  const [frame, setFrame] = useState<Asset>();
  const [keyframeId, setKeyframeId] = useState("");
  const [keyframeJob, setKeyframeJob] = useState<JobView>();
  const [keyframeTick, setKeyframeTick] = useState(0);
  const [makingFrame, setMakingFrame] = useState(false);
  const [agreement, setAgreement] = useState<Agreement>();
  const [checking, setChecking] = useState(false);
  /** So choosing a preset does not silently discard words already typed. */
  const [edited, setEdited] = useState(false);
  const [note, setNote] = useState("");
  const [providerId, setProviderId] = useState("");
  const [starting, setStarting] = useState(false);

  const { clips, sourceId, setSourceId, source } = useClipLibrary(assets);

  useEffect(() => {
    void client
      .transformPresets()
      .then((response) => setPresets(response.presets))
      .catch(() => {
        // A panel that cannot reach the service already says so at the top.
      });
  }, [client]);

  useEffect(() => {
    setAtSeconds((source?.durationSeconds ?? 0) / 2);
    setFrame(undefined);
    setKeyframeId("");
    setKeyframeJob(undefined);
    setAgreement(undefined);
  }, [source?.id, source?.durationSeconds]);

  const transformers = useMemo(
    () => providers.filter((entry) => entry.id.startsWith("seedance") && entry.videoReferences),
    [providers],
  );

  useEffect(() => {
    if (providerId && transformers.some((entry) => entry.id === providerId)) return;
    setProviderId(transformers[0]?.id ?? "");
  }, [transformers, providerId]);

  const provider = transformers.find((entry) => entry.id === providerId);

  const length = source?.durationSeconds;
  const tooShort = length !== undefined && length < 4;
  const tooLong = length !== undefined && length > 30;

  useEffect(() => {
    if (edited) return;
    const opening = presets.find((entry) => entry.id === preset)?.change;
    if (opening) setChange(opening);
  }, [presets, preset, edited]);

  /*
   * Follows the key-frame job to completion — its own loop rather than App's,
   * because App's strip is the *animation* and putting two unrelated kinds of
   * work in one strip would make the panel lie about what is running.
   * Rescheduled from a tick advanced in `finally`, so one failed poll cannot
   * stop it: the bug that made renders look like they never came back.
   */
  useEffect(() => {
    const id = keyframeJob?.job.id;
    if (!id) return;
    const status = keyframeJob?.job.status;
    if (status !== "queued" && status !== "running") return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await client.job(id);
          if (cancelled) return;
          setKeyframeJob(next);
          const made = next.outputs[0];
          if (made) setKeyframeId(made.id);
        } catch {
          if (!cancelled) setKeyframeTick((tick) => tick + 1);
        }
      })();
    }, 1200);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, keyframeJob, keyframeTick]);

  async function makeKeyframe() {
    if (!source) return;
    setMakingFrame(true);
    setAgreement(undefined);
    try {
      const { frame: pulled, job } = await client.transformKeyframe({
        sourceAssetId: source.id,
        atSeconds,
        change: change.trim(),
        depth,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      setFrame(pulled);
      setKeyframeJob(job);
      setKeyframeId("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMakingFrame(false);
    }
  }

  async function check() {
    if (!frame || !keyframeId) return;
    setChecking(true);
    try {
      const response = await client.plateAgreement({
        plateAssetId: frame.id,
        resultAssetId: keyframeId,
      });
      setAgreement(response.agreement);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    if (!source) return;
    setStarting(true);
    try {
      const response = await client.startTransform({
        sourceAssetId: source.id,
        change: change.trim(),
        preset,
        depth,
        ...(providerId ? { providerId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(keyframeId ? { keyframeAssetId: keyframeId } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      onJobs(response.started.map((entry) => entry.job));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const band = depthFor(depth);
  const blocked =
    !source ||
    change.trim().length === 0 ||
    provider === undefined ||
    tooShort ||
    tooLong ||
    busy ||
    starting;

  return (
    <>
      <section className="section">
        <SectionLabel>plate</SectionLabel>

        {onCaptureRange ? (
          <button className="btn primary wide" onClick={onCaptureRange} disabled={busy}>
            {host === "PPRO" ? "Capture in-to-out as clip" : "Capture work area as clip"}
          </button>
        ) : null}
        {onAddFile ? (
          <button
            className="btn wide"
            onClick={onAddFile}
            disabled={busy}
            style={{ marginTop: 6 }}
          >
            Add a clip from disk…
          </button>
        ) : null}

        {clips.length === 0 ? (
          <div className="hint faint" style={{ marginTop: 8 }}>
            No clips in the library yet — capture a range above, or add a file.
            <button className="btn wide" onClick={onOpenLibrary} style={{ marginTop: 6 }}>
              Open the library
            </button>
          </div>
        ) : (
          <>
            <Field label="Plate" hint="what gets transformed">
              <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                {clips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.filename}
                    {clip.width ? ` — ${clip.width}×${clip.height}` : ""}
                    {clip.durationSeconds ? ` — ${clip.durationSeconds.toFixed(1)}s` : ""}
                  </option>
                ))}
              </select>
            </Field>

            {source ? (
              <div className="variant" style={{ marginTop: 6 }}>
                <AssetImage client={client} asset={source} variant="thumbnail" />
              </div>
            ) : null}

            {tooShort || tooLong ? (
              <div className="hint warn" style={{ marginTop: 6 }}>
                Seedance takes <b>4 to 30 seconds</b> and this plate is{" "}
                {length?.toFixed(1)}s. The length follows the footage, so it
                cannot be asked for — capture a {tooLong ? "shorter" : "longer"}{" "}
                range instead.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="section">
        <SectionLabel>change</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          One thing changes. The plate supplies the camera, the geometry, the
          people and the cut, and all of that survives untouched.
        </div>

        <div className="choices">
          {presets.map((entry) => (
            <label className="check" key={entry.id}>
              <input
                type="radio"
                name="seed-transform-preset"
                checked={preset === entry.id}
                onChange={() => {
                  setPreset(entry.id);
                  setEdited(false);
                  setChange(entry.change);
                }}
              />
              {entry.label} — <span className="faint">{entry.purpose}</span>
            </label>
          ))}
        </div>

        <textarea
          value={change}
          rows={8}
          spellCheck={false}
          style={{ width: "100%", marginTop: 6 }}
          onChange={(event) => {
            setEdited(true);
            setChange(event.target.value);
          }}
        />
        <div className="hint faint">
          Describe what the season <i>does to this place</i> — snow on the
          surfaces already in frame — rather than what a winter picture looks
          like. The second wording renders somewhere else.
        </div>

        <Field label={`Depth — ${band.label}`} hint="how far into the scene the change reaches">
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={depth}
            onChange={(event) => setDepth(Number(event.target.value))}
            style={{ width: "100%" }}
          />
        </Field>
        <div className="hint faint">
          {depth <= 33
            ? "Surface — silhouettes untouched, the change lies on top of the scene. Composites cleanest against the original."
            : depth <= 66
              ? "Seasonal — foliage, ground, water and the light change as they really would. Structures and people do not."
              : "Full — also wardrobe, breath and weather in the air. The most convincing, and the only band that touches the people."}
        </div>
      </section>

      <section className="section">
        <SectionLabel>key frame</SectionLabel>

        <Field
          label={`Frame at ${atSeconds.toFixed(2)}s`}
          hint={
            source?.durationSeconds
              ? `of ${source.durationSeconds.toFixed(2)}s — pick a frame inside one shot`
              : "pick a frame inside one shot"
          }
        >
          <input
            type="range"
            min={0}
            max={Math.max(source?.durationSeconds ?? 0, 0.1)}
            step={0.05}
            value={atSeconds}
            onChange={(event) => setAtSeconds(Number(event.target.value))}
            style={{ width: "100%" }}
          />
        </Field>

        <button
          className="btn primary wide"
          disabled={!source || change.trim().length === 0 || busy || makingFrame}
          style={{ marginTop: 8 }}
          onClick={() => void makeKeyframe()}
        >
          {makingFrame ? "Rendering…" : "1 · Transform one frame"}
        </button>
        <div className="hint faint" style={{ marginTop: 4 }}>
          The <b>image</b> model does the change on one still. Quick and cheap,
          and it is where the look is decided — judge it, and check it against
          the plate, before paying for video.
        </div>

        {frame ? (
          <>
            <div className="hint faint" style={{ marginTop: 6 }}>
              the plate frame it took:
            </div>
            <div className="variant">
              <AssetImage client={client} asset={frame} variant="thumbnail" />
            </div>
          </>
        ) : null}

        {keyframeJob ? (
          <JobStrip
            client={client}
            jobs={[keyframeJob]}
            label="key frame"
            {...(keyframeId ? { selectedId: keyframeId } : {})}
          />
        ) : null}

        {frame && keyframeId ? (
          <>
            <button
              className="btn wide"
              disabled={checking}
              style={{ marginTop: 8 }}
              onClick={() => void check()}
            >
              {checking ? "Measuring…" : "Check it against the plate"}
            </button>
            <div className="hint faint" style={{ marginTop: 4 }}>
              Measures whether anything <i>moved</i> — not whether it looks
              different, which it is supposed to.
            </div>
          </>
        ) : null}

        {agreement ? <AgreementReadout agreement={agreement} /> : null}
      </section>

      <section className="section">
        <SectionLabel>animate</SectionLabel>

        <details className="options">
          <summary>Model and notes</summary>
          <Field label="Model" hint="which Seedance carries the plate">
            <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
              {transformers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="About this plate" hint="a place, a period — background, not an instruction">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Kent airfield, 1943"
            />
          </Field>
        </details>

        <button
          className="btn primary wide"
          disabled={blocked}
          style={{ marginTop: 8 }}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "2 · Transform the clip"}
        </button>
        {!keyframeId ? (
          <div className="hint faint" style={{ marginTop: 4 }}>
            Runs without a key frame, but the still is what holds the look
            steady across the shot. Make one first unless you are testing.
          </div>
        ) : null}

        {jobs.length ? (
          <JobStrip client={client} jobs={jobs} label="transform" onCancel={onCancel} />
        ) : null}
      </section>
    </>
  );
}

/**
 * The plate check, in the terms a review uses.
 *
 * Leads with whether it holds rather than with the raw number, because the
 * number needs a tolerance to mean anything and nobody should have to do that
 * arithmetic on a panel. `skipped` is shown alongside `measured` and not
 * buried: a verdict resting on four tiles out of sixty-four is a verdict about
 * almost nothing, and the artist has to be able to see that rather than read a
 * confident percentage that happens to be true of a corner of the frame.
 */
function AgreementReadout({ agreement }: { agreement: Agreement }) {
  if (agreement.measured === 0) {
    return (
      <div className="hint warn" style={{ marginTop: 8 }}>
        Nothing in this frame carried enough structure to measure — every tile
        was flat. A frame like this cannot report whether it moved, and a
        number for it would be about nothing.
      </div>
    );
  }

  const held = Math.round(agreement.held * 100);
  const good = held >= 90;
  const fine = held >= 70;

  return (
    <div className={`hint ${good ? "faint" : fine ? "" : "warn"}`} style={{ marginTop: 8 }}>
      <b>
        {good
          ? "Holds the plate."
          : fine
            ? "Mostly holds, with drift."
            : "Does not hold the plate."}
      </b>{" "}
      {held}% of {agreement.measured} measured regions stayed within{" "}
      {agreement.tolerance}px; typical shift {agreement.medianDistance}px
      {agreement.worst && agreement.worst.distance > agreement.tolerance
        ? `, worst ${agreement.worst.distance}px around column ${agreement.worst.column + 1}, row ${agreement.worst.row + 1}`
        : ""}
      .{" "}
      {agreement.truncated ? (
        <span>
          {" "}
          The worst region ran off the end of the search, so that figure is a
          floor — it moved at least that far.
        </span>
      ) : null}{" "}
      {agreement.skipped > 0 ? (
        <span className="faint">
          {agreement.skipped} flat regions had nothing to say and were left out.
        </span>
      ) : null}
      {!good ? (
        <div style={{ marginTop: 4 }}>
          Try a lower depth, or re-render the frame — a still that has already
          drifted will pull the whole animation with it.
        </div>
      ) : null}
    </div>
  );
}
