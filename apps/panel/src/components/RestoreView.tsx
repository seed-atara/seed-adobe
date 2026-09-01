import { useEffect, useMemo, useState } from "react";
import type { Asset, RestoreLane, RestoreTreatment } from "@seed-ae/domain";
import type {
  JobView,
  ProviderCapabilitiesDto,
  SeedClient,
} from "../api/client.ts";
import { AssetImage, Field, SectionLabel } from "./primitives.tsx";
import { JobStrip } from "./JobStrip.tsx";

/**
 * Restore — archive footage made usable, with nothing invented.
 *
 * The tab exists rather than a mode inside Generate because the two are
 * opposite jobs. Everything in Generate is a control for changing the shot:
 * prompt, seed, duration, aspect, first frame, variants. A restoration wants
 * none of them, and an artist working through archive should not have to
 * remember which nine controls to leave alone. Here there are four buttons and
 * a note, and the things that would change the footage are not on screen to be
 * changed.
 *
 * The lane choice is the honest part of the screen. Both engines are offered
 * for the treatments both can do, with what each one can actually promise
 * written next to it, because "cannot change the picture" and "usually does not
 * change the picture" are different sentences and an editor cutting archive
 * needs to know which one they were given.
 */

interface PresetLane {
  lane: RestoreLane;
  fidelity: string;
  takesNote: boolean;
}

interface Preset {
  treatment: RestoreTreatment;
  label: string;
  purpose: string;
  lanes: PresetLane[];
}

interface Props {
  client: SeedClient;
  assets: Asset[];
  providers: ProviderCapabilitiesDto[];
  jobs: JobView[];
  busy: boolean;
  activeProject?: string;
  selectedId?: string;
  onSelect?: (assetId: string) => void;
  onError: (message: string) => void;
  onJobs: (jobs: JobView[]) => void;
  onCancel: () => void;
  /** Renders the work area to a clip and registers it. Absent outside AE/PPro. */
  onCaptureRange?: () => void;
  /** Adds a file the artist already has. Archive rarely starts in a comp. */
  onAddFile?: () => void;
  onOpenLibrary: () => void;
  host?: string;
}

const LANE_LABEL: Record<RestoreLane, string> = {
  measured: "Upscaler",
  generated: "Seedance pass",
};

export function RestoreView({
  client,
  assets,
  providers,
  jobs,
  busy,
  activeProject,
  selectedId,
  onSelect,
  onError,
  onJobs,
  onCancel,
  onCaptureRange,
  onAddFile,
  onOpenLibrary,
  host,
}: Props) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [treatments, setTreatments] = useState<Set<RestoreTreatment>>(
    () => new Set<RestoreTreatment>(["detail"]),
  );
  const [lanes, setLanes] = useState<Set<RestoreLane>>(
    () => new Set<RestoreLane>(["measured"]),
  );
  const [note, setNote] = useState("");
  const [factor, setFactor] = useState("2");
  const [starting, setStarting] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [captions, setCaptions] = useState<string[]>([]);

  useEffect(() => {
    void client
      .restorePresets()
      .then((response) => setPresets(response.presets))
      .catch(() => {
        // A panel that cannot reach the service already says so at the top; a
        // second copy of that message here would not help anyone.
      });
  }, [client]);

  /** Only clips. A restoration of a still is a different job with different tools. */
  const clips = useMemo(
    () => assets.filter((asset) => asset.kind === "video"),
    [assets],
  );

  /*
   * Newest clip by default, which is almost always the one just captured.
   * Re-picked only while nothing is chosen, so a deliberate choice is never
   * overwritten by a capture landing in the library behind it.
   */
  useEffect(() => {
    if (sourceId && clips.some((clip) => clip.id === sourceId)) return;
    setSourceId(clips[0]?.id ?? "");
  }, [clips, sourceId]);

  const source = clips.find((clip) => clip.id === sourceId);

  /** Which lanes this install can actually run, as opposed to which exist. */
  const hasUpscaler = providers.some((provider) => provider.id === "topaz-upscale");
  const hasSeedance = providers.some((provider) => provider.id.startsWith("seedance"));

  const chosen = presets.filter((preset) => treatments.has(preset.treatment));

  /** The treatment/lane pairs that would actually start, given what is configured. */
  const runnable = chosen.flatMap((preset) =>
    preset.lanes
      .filter((offer) => lanes.has(offer.lane))
      .filter((offer) => (offer.lane === "measured" ? hasUpscaler : hasSeedance))
      .map((offer) => ({ preset, offer })),
  );

  /** Whether any pair on screen will read the note. */
  const notesReachSomething = runnable.some(({ offer }) => offer.takesNote);

  function toggleTreatment(treatment: RestoreTreatment) {
    setTreatments((current) => {
      const next = new Set(current);
      if (next.has(treatment)) next.delete(treatment);
      else next.add(treatment);
      return next;
    });
  }

  function toggleLane(lane: RestoreLane) {
    setLanes((current) => {
      const next = new Set(current);
      if (next.has(lane)) next.delete(lane);
      else next.add(lane);
      return next;
    });
  }

  async function start() {
    if (!source) return;
    setStarting(true);
    setSkipped([]);
    try {
      const response = await client.startRestore({
        sourceAssetId: source.id,
        treatments: [...treatments],
        lanes: [...lanes],
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(Number(factor) > 0 ? { upscaleFactor: Number(factor) } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      /*
       * Captions before jobs. The strip is ordered exactly as the service
       * started them, and with four cards running at once "detail · upscaler"
       * is the only thing that tells one from another — a grid of identical
       * progress bars is not a comparison.
       */
      setCaptions(
        response.started.map(
          (entry) =>
            `${labelOf(presets, entry.treatment)} · ${LANE_LABEL[entry.lane]}`,
        ),
      );
      onJobs(response.started.map((entry) => entry.job));
      setSkipped(response.skipped.map((entry) => entry.reason));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const blocked = !source || runnable.length === 0 || busy || starting;

  return (
    <>
      <section className="section">
        <SectionLabel>footage</SectionLabel>

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

        <div className="hint faint" style={{ marginTop: 6 }}>
          Archive usually arrives as a file rather than a comp — bring the clip
          in directly, or lay it up and render the work area so the restoration
          matches the cut you are actually using.
        </div>

        {clips.length === 0 ? (
          <div className="hint faint" style={{ marginTop: 8 }}>
            No clips in the library yet — capture a range above, or add a file.
            <button
              className="btn wide"
              onClick={onOpenLibrary}
              style={{ marginTop: 6 }}
            >
              Open the library
            </button>
          </div>
        ) : (
          <>
            <Field label="Clip" hint="what gets restored">
              <select
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
              >
                {clips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.filename}
                    {clip.width ? ` — ${clip.width}×${clip.height}` : ""}
                    {clip.durationSeconds
                      ? ` — ${clip.durationSeconds.toFixed(1)}s`
                      : ""}
                  </option>
                ))}
              </select>
            </Field>

            {source ? (
              <div className="variant" style={{ marginTop: 6 }}>
                <AssetImage client={client} asset={source} variant="thumbnail" />
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="section">
        <SectionLabel>treatment</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Nothing here changes the shot. Framing, camera, timing and content are
          held to the original — these choose what happens to the{" "}
          <b>quality of the recording</b> and nothing else.
        </div>

        {presets.map((preset) => (
          <label className="check" key={preset.treatment}>
            <input
              type="checkbox"
              checked={treatments.has(preset.treatment)}
              onChange={() => toggleTreatment(preset.treatment)}
            />
            {preset.label} — <span className="faint">{preset.purpose}</span>
          </label>
        ))}
      </section>

      <section className="section">
        <SectionLabel>engine</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Run both and compare. They fail differently on different footage, and
          looking at the pair is quicker than predicting which one wins.
        </div>

        <label className="check">
          <input
            type="checkbox"
            checked={lanes.has("measured")}
            onChange={() => toggleLane("measured")}
            disabled={!hasUpscaler}
          />
          Upscaler —{" "}
          <span className="faint">
            Topaz. No prompt exists, so nothing can drift.
          </span>
        </label>
        {!hasUpscaler ? (
          <div className="hint faint">
            Needs a fal key. Set <b>FAL_KEY</b> under Keys and reconnect.
          </div>
        ) : null}

        <label className="check">
          <input
            type="checkbox"
            checked={lanes.has("generated")}
            onChange={() => toggleLane("generated")}
            disabled={!hasSeedance}
          />
          Seedance pass —{" "}
          <span className="faint">
            the clip as a reference video, under a locked restoration prompt.
          </span>
        </label>
        {!hasSeedance ? (
          <div className="hint faint">
            Needs an Ark key. Set <b>ARK_API_KEY</b> under Keys and reconnect.
          </div>
        ) : null}

        {/*
          The promise, per pair, in the artist's own reading order. This is the
          part of the screen that decides whether a shot can be cut without a
          caption, so it is text rather than an icon and it is never collapsed.
        */}
        {runnable.length > 0 ? (
          <ul className="notes" style={{ marginTop: 8 }}>
            {runnable.map(({ preset, offer }) => (
              <li key={`${preset.treatment}-${offer.lane}`}>
                <b>
                  {preset.label} · {LANE_LABEL[offer.lane]}
                </b>{" "}
                — <span className="faint">{offer.fidelity}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="hint faint" style={{ marginTop: 8 }}>
            {treatments.size === 0
              ? "Choose a treatment."
              : lanes.size === 0
                ? "Choose an engine."
                : "Nothing selected can run on the engines you have chosen — colour and damage repair both need Seedance."}
          </div>
        )}
      </section>

      {lanes.has("generated") ? (
        <section className="section">
          <SectionLabel>guidance</SectionLabel>
          <Field
            label="Note"
            hint="what the footage is, not what you want it to look like"
          >
            <input
              type="text"
              value={note}
              placeholder="Manchester, 1936. Overcast. Trams are green and cream."
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <div className="hint faint">
            A note narrows the guessing — a period, a place, the colour of a
            uniform. It is passed as information about the footage and never as
            permission to change the shot, so &ldquo;make it cinematic&rdquo;
            will be ignored by design.
            {note.trim() && !notesReachSomething ? (
              <>
                {" "}
                <b>
                  Nothing selected reads this: the upscaler has no prompt field.
                </b>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {lanes.has("measured") ? (
        <section className="section">
          <SectionLabel>output</SectionLabel>
          <Field label="Upscale" hint="multiplies each edge">
            <select value={factor} onChange={(event) => setFactor(event.target.value)}>
              <option value="1">1× — clean up only</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </Field>
          {source?.width ? (
            <div className="hint faint">
              {source.width}×{source.height} →{" "}
              {Math.round(source.width * Number(factor))}×
              {Math.round((source.height ?? 0) * Number(factor))}
            </div>
          ) : null}
          <div className="hint faint" style={{ marginTop: 4 }}>
            The Seedance pass has no factor — it renders at the best tier its
            model offers, and the frame keeps the shape of the clip.
          </div>
        </section>
      ) : null}

      <section className="section">
        <button className="btn primary wide" disabled={blocked} onClick={() => void start()}>
          {starting
            ? "Starting…"
            : runnable.length > 1
              ? `Restore — ${runnable.length} passes`
              : "Restore"}
        </button>
        <div className="hint faint" style={{ marginTop: 6 }}>
          Results land in the library like any other generation, with the
          original as their parent — so the restored clip can always be traced
          back to the footage it came from.
        </div>
        {skipped.length > 0 ? (
          <ul className="notes" style={{ marginTop: 6 }}>
            {skipped.map((reason) => (
              <li key={reason} className="faint">
                Skipped: {reason}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <JobStrip
        client={client}
        jobs={jobs}
        label={jobs.length > 1 ? `passes — ${jobs.length}` : "pass"}
        captions={captions}
        {...(selectedId ? { selectedId } : {})}
        {...(onSelect ? { onSelect } : {})}
        onCancel={onCancel}
      />
    </>
  );
}

function labelOf(presets: Preset[], treatment: RestoreTreatment): string {
  return presets.find((preset) => preset.treatment === treatment)?.label ?? treatment;
}
