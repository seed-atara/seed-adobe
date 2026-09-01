import { useEffect, useMemo, useState } from "react";
import type { Asset, RestoreTreatment } from "@seed-ae/domain";
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
  treatment: RestoreTreatment;
  label: string;
  purpose: string;
  fidelity: string;
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
  const [treatments, setTreatments] = useState<Set<RestoreTreatment>>(
    () => new Set<RestoreTreatment>(["detail"]),
  );
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
   * Newest clip by default, which is almost always the one just captured.
   * Re-picked only while nothing valid is chosen, so a deliberate choice is
   * never overwritten by a capture landing in the library behind it.
   */
  useEffect(() => {
    if (sourceId && clips.some((clip) => clip.id === sourceId)) return;
    setSourceId(clips[0]?.id ?? "");
  }, [clips, sourceId]);

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

  useEffect(() => {
    if (providerId && restorers.some((entry) => entry.id === providerId)) return;
    setProviderId(restorers[0]?.id ?? "");
  }, [restorers, providerId]);

  const provider = restorers.find((entry) => entry.id === providerId);
  const tier = bestTier(provider?.sizes ?? []);

  const chosen = presets.filter((preset) => treatments.has(preset.treatment));

  function toggle(treatment: RestoreTreatment) {
    setTreatments((current) => {
      const next = new Set(current);
      if (next.has(treatment)) next.delete(treatment);
      else next.add(treatment);
      return next;
    });
  }

  async function start() {
    if (!source) return;
    setStarting(true);
    try {
      const response = await client.startRestore({
        sourceAssetId: source.id,
        treatments: [...treatments],
        ...(providerId ? { providerId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(activeProject ? { project: activeProject } : {}),
      });
      /*
       * Captions before jobs. The strip is ordered exactly as the service
       * started them, and with four passes running at once the treatment name
       * is the only thing that tells one card from another — a row of
       * identical progress bars is not a comparison.
       */
      setCaptions(
        response.started.map((entry) => labelOf(presets, entry.treatment)),
      );
      onJobs(response.started.map((entry) => entry.job));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const blocked =
    !source || treatments.size === 0 || provider === undefined || busy || starting;

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
          <b>quality of the recording</b> and nothing else. Pick more than one
          and they run side by side.
        </div>

        {presets.map((preset) => (
          <label className="check" key={preset.treatment}>
            <input
              type="checkbox"
              checked={treatments.has(preset.treatment)}
              onChange={() => toggle(preset.treatment)}
            />
            {preset.label} — <span className="faint">{preset.purpose}</span>
          </label>
        ))}

        {/*
          What each chosen treatment can actually promise. This is the part of
          the screen that decides whether a shot can be cut without a caption,
          so it is text rather than an icon and it is never collapsed.
        */}
        {chosen.length > 0 ? (
          <ul className="notes" style={{ marginTop: 8 }}>
            {chosen.map((preset) => (
              <li key={preset.treatment}>
                <b>{preset.label}</b> —{" "}
                <span className="faint">{preset.fidelity}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="hint faint" style={{ marginTop: 8 }}>
            Choose a treatment.
          </div>
        )}
      </section>

      <section className="section">
        <SectionLabel>model</SectionLabel>
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
              2.5 is the better model and stops at 1080p. 2.0 is older and
              reaches <b>4K</b> — which for an upscale is often the trade worth
              making. Every pass renders at the top tier of whichever you pick.
            </div>
          </>
        ) : (
          <div className="hint faint">
            Restoring needs Seedance. Set <b>ARK_API_KEY</b> and a Seedance
            model id under Keys, then reconnect.
          </div>
        )}
      </section>

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
          permission to change the shot, so &ldquo;make it cinematic&rdquo; will
          be ignored by design.
        </div>
      </section>

      <section className="section">
        <button className="btn primary wide" disabled={blocked} onClick={() => void start()}>
          {starting
            ? "Starting…"
            : treatments.size > 1
              ? `Restore — ${treatments.size} passes`
              : "Restore"}
        </button>

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

function labelOf(presets: Preset[], treatment: RestoreTreatment): string {
  return presets.find((preset) => preset.treatment === treatment)?.label ?? treatment;
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
