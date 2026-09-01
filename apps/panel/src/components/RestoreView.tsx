import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_FREEDOM, latitudeFor } from "@seed-ae/domain";
import type { Asset, RestorePresetId } from "@seed-ae/domain";
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
 * The one screen element that is not a control is the fidelity line under each
 * treatment. That is the sentence an editor reads before committing an archive
 * shot to a cut — what this can promise, and where to look when it fails — so
 * it is always visible and never collapsed behind a tooltip.
 */

interface Preset {
  id: RestorePresetId;
  label: string;
  purpose: string;
  /** Starting text for the Look field. Not a hidden prompt. */
  look: string;
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
  /*
   * One render, and the artist can see exactly what is being asked for.
   *
   * The presets used to be checkboxes hiding a prompt each; now they are
   * openings that fill `look`, which is an ordinary editable field. What is on
   * screen is what gets sent — the artist knows what the footage is and we do
   * not, and their vocabulary is load-bearing.
   */
  const [preset, setPreset] = useState<RestorePresetId>("detail");
  const [look, setLook] = useState("");
  /** How far the render may depart from the source. Prompt strength only. */
  const [freedom, setFreedom] = useState(DEFAULT_FREEDOM);
  /*
   * The sharp still the animation renders towards.
   *
   * Two steps rather than one because the first is cheap and the second is
   * not: a key frame comes back in seconds, and if it is not beautiful there
   * is no point paying for video. It is also the only step that reliably adds
   * detail — a video model cannot exceed what its source resolved.
   */
  const [keyframeId, setKeyframeId] = useState("");
  const [keyframeJob, setKeyframeJob] = useState<JobView>();
  const [makingFrame, setMakingFrame] = useState(false);
  const [keyframeTick, setKeyframeTick] = useState(0);
  /** So choosing a preset does not silently discard words already typed. */
  const [edited, setEdited] = useState(false);
  const [note, setNote] = useState("");
  const [providerId, setProviderId] = useState("");
  const [starting, setStarting] = useState(false);
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
   * A clip that has just arrived is the one the artist meant.
   *
   * This was originally "keep whatever is selected unless it becomes invalid",
   * on the reasoning that a deliberate choice should not be overwritten by a
   * capture landing behind it. That reasoning was wrong, and wrong in the way
   * that matters: pressing **Capture work area as clip** *is* the deliberate
   * choice. Johannes captured a range, the banner confirmed it, and the
   * dropdown quietly stayed on a clip from the day before — so the thing on
   * screen was not the thing about to be restored.
   *
   * So arrival wins. Anything appearing in the library that was not there a
   * moment ago is selected, which covers the capture button and add-from-disk
   * alike; a generated result cannot trigger it, because a restoration output
   * lands while this view is showing its own job strip and the newest clip is
   * still what the artist chose to restore.
   */
  const known = useRef<Set<string> | undefined>(undefined);
  useEffect(() => {
    const ids = new Set(clips.map((clip) => clip.id));

    // First pass: adopt the library as it stands, and start on the newest.
    if (!known.current) {
      known.current = ids;
      setSourceId((current) => current || clips[0]?.id || "");
      return;
    }

    const arrived = clips.filter((clip) => !known.current?.has(clip.id));
    known.current = ids;

    if (arrived[0]) setSourceId(arrived[0].id);
    else setSourceId((current) => (current && ids.has(current) ? current : clips[0]?.id || ""));
  }, [clips]);

  const source = clips.find((clip) => clip.id === sourceId);

  /**
   * The models that can restore: Seedance, and only those taking a clip.
   *
   * Offered as a choice rather than picked, because the resolution ceiling and
   * the model quality do not agree. 2.5 is the better model and stops at
   * 1080p; 2.0 is older and reaches 4K. Choosing the highest tier on the
   * artist's behalf would silently hand them an older model, and choosing the
   * newest would hide the only route to 4K — which is the whole point of an
   * upscale. So both are on screen with the tier they reach.
   */
  const restorers = useMemo(
    () => providers.filter((entry) => entry.id.startsWith("seedance") && entry.videoReferences),
    [providers],
  );

  /*
   * Default to whichever reaches furthest, because this is an upscale.
   *
   * Not the registry's first entry, which is 2.5 and stops at 1080p — on a
   * 2560x1440 comp capture that is a *downscale* wearing the word "restore".
   * The newer model is still one click away and the trade is spelled out
   * beside it.
   */
  useEffect(() => {
    if (providerId && restorers.some((entry) => entry.id === providerId)) return;
    const furthest = restorers
      .slice()
      .sort((a, b) => rank(bestTier(b.sizes) ?? "") - rank(bestTier(a.sizes) ?? ""))[0];
    setProviderId(furthest?.id ?? "");
  }, [restorers, providerId]);

  const provider = restorers.find((entry) => entry.id === providerId);
  const tier = bestTier(provider?.sizes ?? []);

  /*
   * Seedance takes 4 to 30 seconds and refuses anything else at submit.
   * A restoration cannot get around it by asking for a different length —
   * the length follows the clip, which is the entire point — so the only fix
   * is a different span of footage, and saying so here costs nothing where
   * finding out from the provider costs a round trip per treatment.
   */
  const length = source?.durationSeconds;
  const tooShort = length !== undefined && length < 4;
  const tooLong = length !== undefined && length > 30;

  /*
   * The trap this feature hides most easily: a "restoration" that comes back
   * smaller than it went in. A 2560x1440 comp capture restored on a model that
   * stops at 1080p loses a third of its height, and the result still arrives
   * looking plausible. Named on screen rather than prevented — 1080p off a
   * 1440p source is a legitimate thing to want, just never by accident.
   */
  const targetHeight = rank(tier ?? "");
  const shrinks =
    source?.height !== undefined && targetHeight > 0 && targetHeight < source.height;

  const chosen = presets.find((entry) => entry.id === preset);

  /*
   * A preset fills the field, unless the artist has been typing in it. Losing
   * a paragraph someone wrote because they clicked a radio button to read what
   * it says would be the worst kind of small betrayal.
   */
  useEffect(() => {
    if (edited) return;
    const opening = presets.find((entry) => entry.id === preset)?.look;
    if (opening) setLook(opening);
  }, [presets, preset, edited]);

  /*
   * Follows the key-frame job to completion.
   *
   * Its own loop rather than App's, because App's job list is the *animation*
   * and putting two unrelated kinds of work in one strip would make the panel
   * lie about what is running. Rescheduled from a tick advanced in `finally`,
   * so one failed poll cannot stop it — the bug that made renders look like
   * they never came back.
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
          // The finished still is what the animation renders towards.
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

  /**
   * Pulls a frame and renders it properly, then adopts the result.
   *
   * The frame comes from the middle of the clip rather than the start: an
   * opening frame is often a cut or a fade, and the middle is more likely to
   * be representative of the shot.
   */
  async function makeKeyframe() {
    if (!source) return;
    setMakingFrame(true);
    try {
      const { job } = await client.restoreKeyframe({
        sourceAssetId: source.id,
        atSeconds: (source.durationSeconds ?? 2) / 2,
        look: look.trim(),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      setKeyframeJob(job);
      setKeyframeId("");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setMakingFrame(false);
    }
  }

  async function start() {
    if (!source) return;
    setStarting(true);
    try {
      const response = await client.startRestore({
        sourceAssetId: source.id,
        look: look.trim(),
        preset,
        freedom,
        ...(providerId ? { providerId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(keyframeId ? { keyframeAssetId: keyframeId } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      /*
       * Captions before jobs. The strip is ordered exactly as the service
       * started them, and with four passes running at once the treatment name
       * is the only thing that tells one card from another — a row of
       * identical progress bars is not a comparison.
       */
      setCaptions(
        response.started.map(() => labelOf(presets, preset)),
      );
      onJobs(response.started.map((entry) => entry.job));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const blocked =
    !source ||
    look.trim().length === 0 ||
    provider === undefined ||
    tooShort ||
    tooLong ||
    busy ||
    starting;

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

            {tooShort || tooLong ? (
              <div className="hint warn" style={{ marginTop: 6 }}>
                Seedance takes <b>4 to 30 seconds</b> and this clip is{" "}
                {length?.toFixed(1)}s. The restored length follows the footage,
                so it cannot be asked for — capture a{" "}
                {tooLong ? "shorter" : "longer"} range instead. A long shot has
                to be restored in pieces.
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="section">
        <SectionLabel>look</SectionLabel>
        <div className="hint faint" style={{ marginBottom: 6 }}>
          Describe the picture you want. The clip supplies framing, camera and
          action; this supplies the quality.
        </div>

        <div className="choices">
          {presets.map((entry) => (
            <label className="check" key={entry.id}>
              <input
                type="radio"
                name="seed-restore-preset"
                checked={preset === entry.id}
                onChange={() => {
                  setPreset(entry.id);
                  setEdited(false);
                  setLook(entry.look);
                }}
              />
              {entry.label} — <span className="faint">{entry.purpose}</span>
            </label>
          ))}
        </div>

        <textarea
          value={look}
          rows={7}
          spellCheck={false}
          style={{ width: "100%", marginTop: 6 }}
          onChange={(event) => {
            setEdited(true);
            setLook(event.target.value);
          }}
        />
        <button
          className="btn primary wide"
          disabled={!source || look.trim().length === 0 || busy || makingFrame}
          style={{ marginTop: 8 }}
          onClick={() => void makeKeyframe()}
        >
          {makingFrame ? "Rendering…" : "1 · Make a sharp key frame"}
        </button>
        <div className="hint faint" style={{ marginTop: 4 }}>
          The <b>image</b> model renders one frame properly. This is where the
          detail comes from — a video model cannot resolve more than its source
          already did. Quick and cheap: judge it here before paying for video.
        </div>

        {keyframeJob ? (
          <JobStrip
            client={client}
            jobs={[keyframeJob]}
            label="key frame"
            {...(keyframeId ? { selectedId: keyframeId } : {})}
          />
        ) : null}

        {keyframeId ? (
          <div className="hint faint">
            Rendering towards that frame. It travels as a reference image
            beside the clip, so the still supplies the look and the clip
            supplies the motion.{" "}
            <button className="btn" onClick={() => { setKeyframeId(""); setKeyframeJob(undefined); }}>
              Use the clip alone instead
            </button>
          </div>
        ) : null}

        <Field
          label={`Latitude — ${latitudeFor(freedom).label}`}
          hint="how far the render may depart from the footage"
        >
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={freedom}
            onChange={(event) => setFreedom(Number(event.target.value))}
            style={{ width: "100%" }}
          />
        </Field>
        <div
          className="hint faint"
          style={{ display: "flex", justifyContent: "space-between", marginTop: -2 }}
        >
          <span>same picture, resolved</span>
          <span>freely reinterpreted</span>
        </div>
        <div className="hint faint">
          {latitudeFor(freedom).text}
        </div>
        <div className="hint faint">
          Framing, camera and timing are held at every setting. Prompt strength
          only — Ark publishes no weight for a reference video.
        </div>

        <div className="hint faint">
          Sent as written. Say what to <b>make</b>, not what to avoid.
          {edited && chosen ? (
            <>
              {" "}
              <button
                className="btn"
                style={{ marginTop: 6 }}
                onClick={() => {
                  setEdited(false);
                  setLook(chosen.look);
                }}
              >
                Reset to {chosen.label}
              </button>
            </>
          ) : null}
        </div>
      </section>

      <details className="options">
        <summary>
          Options —{" "}
          {provider ? (
            <b>
              {provider.displayName.replace(/\s*\(Ark\)$/, "")}
              {tier ? `, ${tier}` : ""}
            </b>
          ) : (
            <b>no model</b>
          )}
          {note.trim() ? " · note set" : ""}
        </summary>

        {restorers.length > 0 ? (
          <>
            <Field label="Restore with" hint="the ceiling and the model do not agree">
              <select
                value={providerId}
                onChange={(event) => setProviderId(event.target.value)}
              >
                {restorers.map((entry) => {
                  const top = bestTier(entry.sizes);
                  return (
                    <option key={entry.id} value={entry.id}>
                      {entry.displayName}
                      {top ? ` — up to ${top}` : ""}
                    </option>
                  );
                })}
              </select>
            </Field>
            <div className="hint faint">
              2.0 reaches <b>4K</b> and is the default because raising
              resolution is the point. 2.5 is the newer model and stops at
              1080p — worth it when the source is already small.
            </div>
          </>
        ) : (
          <div className="hint faint">
            Restoring needs Seedance. Set <b>ARK_API_KEY</b> and a Seedance
            model id under Keys, then reconnect.
          </div>
        )}

        <Field
          label="Note"
          hint="what the footage is, not what you want it to look like"
        >
          <input
            type="text"
            value={note}
            placeholder="RAF base, 1941. Overcast. Spitfires on grass."
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <div className="hint faint">
          Narrows the guessing — a period, a place, the colour of a uniform.
          Passed as information about the footage and never as permission to
          change the shot, so &ldquo;make it cinematic&rdquo; is ignored by
          design. Matters most for Colourise.
        </div>
      </details>

      <section className="section">
        <button className="btn primary wide" disabled={blocked} onClick={() => void start()}>
          {starting
            ? "Starting…"
            : keyframeId
              ? "2 · Animate towards the key frame"
              : "Restore from the clip alone"}
        </button>

        {shrinks ? (
          <div className="hint warn" style={{ marginTop: 6 }}>
            This would come back <b>smaller</b> than it went in — {source?.width}×
            {source?.height} restored at {tier}. Pick a model that reaches
            further under Options, or accept the reduction knowingly.
          </div>
        ) : null}

        {provider ? (
          <div className="hint faint" style={{ marginTop: 6 }}>
            {provider.displayName}
            {tier ? (
              <>
                {" "}
                at <b>{tier}</b>
              </>
            ) : null}
            . The length and the framing follow the clip — nothing here can
            change them. Results land in the library with the original as their
            parent, so a restored shot can always be traced back to the footage
            it came from.
          </div>
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

function labelOf(presets: Preset[], id: RestorePresetId): string {
  return presets.find((entry) => entry.id === id)?.label ?? id;
}

/**
 * The tier a restoration will actually render at, for the line that says so.
 *
 * Mirrors what the service picks rather than deciding it — the service is the
 * authority, and this only tells the artist what to expect. Blank when the
 * provider's sizes are shapes rather than a ladder, because then there is no
 * "highest" to name.
 */
function bestTier(sizes: string[]): string | undefined {
  const tiers = sizes.filter((size) => /^\d+p$|^\d+k$/i.test(size.trim()));
  if (tiers.length !== sizes.length || tiers.length === 0) return undefined;
  return tiers.reduce((best, size) => (rank(size) > rank(best) ? size : best));
}

function rank(size: string): number {
  const progressive = /^(\d+)p$/i.exec(size.trim());
  if (progressive) return Number(progressive[1]);
  const kilo = /^(\d+)k$/i.exec(size.trim());
  return kilo ? Number(kilo[1]) * 1000 : 0;
}
