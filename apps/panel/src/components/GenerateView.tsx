import { useEffect, useRef, useState } from "react";
import type { Asset, ComposedPlan, GenerationOperation } from "@seed-ae/domain";
import type { AeRegion } from "../api/cep.ts";
import {
  assetToken,
  completeMention,
  matchAssets,
  mentionQueryAt,
} from "../mentions.ts";
import type {
  JobView,
  ProviderCapabilitiesDto,
  SeedClient,
} from "../api/client.ts";
import { AssetImage, Field, SectionLabel, StatusBadge } from "./primitives.tsx";

/** The region controls, kept together so App owns one piece of state. */
export interface RegionSettings {
  name: string;
  /** Edge length for the next region added, in comp pixels. */
  newSize: string;
  /** Softness of the composite edge, in comp pixels. */
  feather: string;
  /** Blank means the playhead. */
  startSeconds: string;
  /** Blank means the clip's own length. */
  stretchToSeconds: string;
}

export interface GenerateForm {
  providerId: string;
  model: string;
  operation: GenerationOperation;
  prompt: string;
  seed: string;
  size: string;
  /** Kept as text so the field can be cleared; parsed at submit. */
  durationSeconds: string;
  /** Off by default: sound is a choice, and it is baked into the clip. */
  generateAudio: boolean;
  inputAssetIds: string[];
  parentAssetId?: string;
  parentGenerationId?: string;
}

interface Props {
  client: SeedClient;
  providers: ProviderCapabilitiesDto[];
  assets: Asset[];
  form: GenerateForm;
  job?: JobView;
  busy: boolean;
  onFormChange: (form: GenerateForm) => void;
  onCapture: () => void;
  onGenerate: () => void;
  onCancel: () => void;
  onOpenLibrary: () => void;
  /** Absent when the service has no direction key configured. */
  onDirect?: () => void;
  directing?: boolean;
  plan?: ComposedPlan;
  onDismissPlan?: () => void;
  /** Absent outside After Effects, where regions do not apply. */
  regions?: AeRegion[];
  region?: RegionSettings;
  onRegionChange?: (region: RegionSettings) => void;
  onAddRegion?: () => void;
  onCaptureRegion?: () => void;
  onRefreshRegions?: () => void;
  onInsertRegion?: () => void;
}

export function GenerateView({
  client,
  providers,
  assets,
  form,
  job,
  busy,
  onFormChange,
  onCapture,
  onGenerate,
  onCancel,
  onOpenLibrary,
  onDirect,
  directing = false,
  plan,
  onDismissPlan,
  regions,
  region,
  onRegionChange,
  onAddRegion,
  onCaptureRegion,
  onRefreshRegions,
  onInsertRegion,
}: Props) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string>();
  const [directingFor, setDirectingFor] = useState(0);

  /*
   * Composition takes about half a minute and the API reports no progress, so
   * the bar is honestly indeterminate — its job is to say "still working", and
   * the elapsed count is what tells the artist whether that is still normal.
   */
  useEffect(() => {
    if (!directing) {
      setDirectingFor(0);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(
      () => setDirectingFor(Math.round((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [directing]);

  /** Tracks the `@…` being typed so the library can be offered inline. */
  const syncMentionQuery = (element: HTMLTextAreaElement) => {
    const at = mentionQueryAt(element.value, element.selectionStart ?? 0);
    setMentionQuery(at?.query);
  };

  const mentionMatches =
    mentionQuery === undefined ? [] : matchAssets(assets, mentionQuery);

  const insertMention = (asset: Asset) => {
    const element = promptRef.current;
    if (!element) return;
    const next = completeMention(
      form.prompt,
      element.selectionStart ?? form.prompt.length,
      asset,
    );
    patch({ prompt: next.text });
    setMentionQuery(undefined);
    // The caret has to be restored after React re-renders the value.
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };
  const provider = providers.find((item) => item.id === form.providerId);
  const references = form.inputAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => asset !== undefined);

  const patch = (changes: Partial<GenerateForm>) =>
    onFormChange({ ...form, ...changes });

  /**
   * Moves the form onto a provider, keeping it internally consistent.
   *
   * Model, size and operation all belong to the provider, so carrying any of
   * them across is how a form ends up asking Seedance for an image edit — a
   * request the service can only refuse, after the artist has pressed
   * Generate and waited for it.
   */
  const selectProvider = (id: string) => {
    const next = providers.find((item) => item.id === id);
    patch({
      providerId: id,
      model: next?.models[0] ?? "",
      size: next?.sizes[0] ?? "",
      ...(next && !next.operations.includes(form.operation)
        ? { operation: (next.operations[0] as GenerationOperation) ?? form.operation }
        : {}),
    });
  };

  const patchRegion = (changes: Partial<RegionSettings>) => {
    if (region && onRegionChange) onRegionChange({ ...region, ...changes });
  };

  const selected = regions?.find((item) => item.name === region?.name);
  const finishedOutput =
    job?.job.status === "succeeded" ? job.outputs[0] : undefined;

  const running =
    job !== undefined &&
    (job.job.status === "queued" || job.job.status === "running");

  const referencesFull =
    provider !== undefined && references.length >= provider.maxImageReferences;

  // The provider decides what it can do; the form must not be able to ask for
  // anything else, even transiently.
  const operationSupported =
    provider !== undefined && provider.operations.includes(form.operation);

  const canGenerate =
    !busy &&
    !running &&
    provider !== undefined &&
    operationSupported &&
    form.prompt.trim().length > 0 &&
    (form.operation !== "image.edit" || references.length > 0);

  return (
    <>
      <section className="section">
        <SectionLabel>source</SectionLabel>
        <button className="btn primary wide" onClick={onCapture} disabled={busy}>
          Capture current frame
        </button>
        {referencesFull ? (
          <div className="hint faint" style={{ marginTop: 6 }}>
            {provider?.displayName} accepts {provider?.maxImageReferences}{" "}
            reference{provider?.maxImageReferences === 1 ? "" : "s"}, so a new
            capture replaces the oldest. Everything stays in the library.
          </div>
        ) : null}
      </section>

      {regions && region ? (
        <section className="section">
          <SectionLabel>region</SectionLabel>
          <div className="hint faint" style={{ marginBottom: 6 }}>
            Animate part of a larger plate. The region is an ordinary shape
            layer — move and scale it in the comp and SEED reads it back.
          </div>

          {regions.length === 0 ? (
            <div className="row">
              <Field label="Size">
                <input
                  type="number"
                  min={64}
                  value={region.newSize}
                  onChange={(event) =>
                    patchRegion({ newSize: event.target.value })
                  }
                />
              </Field>
              <Field label="&nbsp;">
                <button className="btn wide" onClick={onAddRegion} disabled={busy}>
                  Add region
                </button>
              </Field>
            </div>
          ) : (
            <>
              <div className="row">
                <Field
                  label="Region"
                  hint={
                    selected
                      ? `${selected.width}x${selected.height} at ${Math.round(
                          selected.centerX,
                        )}, ${Math.round(selected.centerY)}`
                      : undefined
                  }
                >
                  <select
                    value={region.name}
                    onChange={(event) => patchRegion({ name: event.target.value })}
                  >
                    {regions.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="&nbsp;">
                  <div className="row">
                    <button
                      className="btn wide"
                      onClick={onRefreshRegions}
                      disabled={busy}
                      title="Re-read the region from After Effects"
                    >
                      Refresh
                    </button>
                    <button className="btn wide" onClick={onAddRegion} disabled={busy}>
                      Add
                    </button>
                  </div>
                </Field>
              </div>

              <button
                className="btn primary wide"
                onClick={onCaptureRegion}
                disabled={busy || !selected}
              >
                Capture region
              </button>

              <div className="row" style={{ marginTop: 8 }}>
                <Field label="Feather" hint="px, softens the composite edge">
                  <input
                    type="number"
                    min={0}
                    value={region.feather}
                    onChange={(event) =>
                      patchRegion({ feather: event.target.value })
                    }
                  />
                </Field>
                <Field label="Start" hint="seconds, blank = playhead">
                  <input
                    type="number"
                    min={0}
                    step="0.1"
                    value={region.startSeconds}
                    placeholder="playhead"
                    onChange={(event) =>
                      patchRegion({ startSeconds: event.target.value })
                    }
                  />
                </Field>
              </div>

              <Field label="Stretch to" hint="seconds, blank = the clip's own length">
                <input
                  type="number"
                  min={0}
                  step="0.1"
                  value={region.stretchToSeconds}
                  placeholder="native length"
                  onChange={(event) =>
                    patchRegion({ stretchToSeconds: event.target.value })
                  }
                />
              </Field>

              <button
                className="btn wide"
                onClick={onInsertRegion}
                disabled={busy || !finishedOutput || !selected}
                title={
                  finishedOutput
                    ? "Composite the result back onto the region"
                    : "Generate something first"
                }
              >
                Composite result into region
              </button>
            </>
          )}
        </section>
      ) : null}

      <section className="section">
        <SectionLabel>references</SectionLabel>
        <div className="ref-row">
          {references.map((asset) => (
            <div className="ref" key={asset.id}>
              <AssetImage client={client} asset={asset} variant="thumbnail" />
              <button
                title="Remove reference"
                onClick={() =>
                  patch({
                    inputAssetIds: form.inputAssetIds.filter(
                      (id) => id !== asset.id,
                    ),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="ref-add"
            title="Add from library"
            onClick={onOpenLibrary}
            disabled={referencesFull}
          >
            +
          </button>
        </div>
      </section>

      <section className="section">
        <SectionLabel>direction</SectionLabel>
        <Field
          label="Prompt"
          hint={
            references.length > 0
              ? `Refer to references by position — “Image 1”, “the second reference”. Models do not resolve asset ids in prose.`
              : undefined
          }
        >
          <div className="mention-host">
            <textarea
              ref={promptRef}
              value={form.prompt}
              placeholder={
                onDirect
                  ? "Describe the shot — type @ to name a reference…"
                  : references.length > 0
                    ? "Image 1 is the reference. Keep the subject; relight as…"
                    : "Describe the image you want…"
              }
              onChange={(event) => {
                patch({ prompt: event.target.value });
                syncMentionQuery(event.target);
              }}
              onKeyUp={(event) => syncMentionQuery(event.currentTarget)}
              onClick={(event) => syncMentionQuery(event.currentTarget)}
              onBlur={() => setMentionQuery(undefined)}
            />
            {mentionMatches.length > 0 ? (
              <ul className="mention-menu">
                {mentionMatches.map((asset) => (
                  <li key={asset.id}>
                    {/* onMouseDown fires before the textarea's blur closes this. */}
                    <button
                      onMouseDown={(event) => {
                        event.preventDefault();
                        insertMention(asset);
                      }}
                    >
                      <AssetImage
                        client={client}
                        asset={asset}
                        variant="thumbnail"
                      />
                      <span className="mono">@{assetToken(asset)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Field>

        {onDirect ? (
          <>
            <button
              className="btn wide"
              onClick={onDirect}
              disabled={busy || directing || form.prompt.trim().length === 0}
              title="Read the references and write the prompt"
            >
              {directing ? "Directing…" : "◈ Direct this shot"}
            </button>
            {directing ? (
              <div style={{ marginTop: 6 }}>
                <div className="progress indeterminate">
                  <i />
                </div>
                <div className="hint faint" style={{ marginTop: 4 }}>
                  {directingFor < 45
                    ? `Reading your references and writing the prompt… ${directingFor}s`
                    : `Still working — ${directingFor}s. Long descriptions and several references take longer.`}
                </div>
              </div>
            ) : (
              <div className="hint faint" style={{ marginTop: 4 }}>
                Rewrites the prompt from your description, picks the references,
                and fills the settings below. Nothing runs until you press
                Generate.
              </div>
            )}
          </>
        ) : null}

        {plan ? (
          <div className="plan">
            <div className="plan-head">
              <SectionLabel>direction</SectionLabel>
              <span className="spacer" />
              {onDismissPlan ? (
                <button className="btn ghost" onClick={onDismissPlan}>
                  ×
                </button>
              ) : null}
            </div>
            <p>{plan.rationale}</p>
            {plan.references.length > 0 ? (
              <ul className="plan-refs">
                {plan.references.map((reference) => (
                  <li key={reference.assetId}>
                    <b className="mono">{reference.label}</b> {reference.role}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.warnings.map((warning) => (
              <div className="notice" key={warning}>
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        <div className="row">
          <Field label="Provider">
            <select
              value={form.providerId}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model">
            <select
              value={form.model}
              onChange={(event) => patch({ model: event.target.value })}
            >
              {(provider?.models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="row">
          <Field label="Operation">
            <select
              value={form.operation}
              onChange={(event) =>
                patch({ operation: event.target.value as GenerationOperation })
              }
            >
              {(provider?.operations ?? []).map((operation) => (
                <option key={operation} value={operation}>
                  {operation}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Size">
            <select
              value={form.size}
              onChange={(event) => patch({ size: event.target.value })}
            >
              {(provider?.sizes ?? []).map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Seed is enabled from declared capabilities, never assumed. */}
        <Field
          label="Seed"
          hint={
            provider?.seed
              ? "Same seed and prompt reproduce the same result."
              : `${provider?.displayName ?? "This provider"} does not expose a verified seed parameter.`
          }
        >
          <input
            type="text"
            value={form.seed}
            disabled={!provider?.seed}
            placeholder={provider?.seed ? "auto" : "unavailable"}
            onChange={(event) => patch({ seed: event.target.value })}
          />
        </Field>

        {provider?.durationSecondsRange ? (
          <Field
            label="Duration"
            hint={`${provider.durationSecondsRange[0]}–${provider.durationSecondsRange[1]} seconds`}
          >
            <input
              type="number"
              min={provider.durationSecondsRange[0]}
              max={provider.durationSecondsRange[1]}
              value={form.durationSeconds}
              placeholder="provider default"
              onChange={(event) =>
                patch({ durationSeconds: event.target.value })
              }
            />
          </Field>
        ) : null}

        {provider?.generatesAudio ? (
          <Field label="Sound" hint="Off by default; the model scores the clip">
            <label className="check">
              <input
                type="checkbox"
                checked={form.generateAudio}
                onChange={(event) =>
                  patch({ generateAudio: event.target.checked })
                }
              />
              Generate audio
            </label>
          </Field>
        ) : null}

        {form.parentGenerationId ? (
          <div className="notice">
            Branching from an existing recipe. The original stays untouched;
            this run is recorded as a descendant.
          </div>
        ) : null}

        {provider && !operationSupported ? (
          <div className="notice">
            {provider.displayName} does not do {form.operation}. Pick an
            operation it supports, or another provider.
          </div>
        ) : null}

        <button
          className="btn primary wide"
          onClick={onGenerate}
          disabled={!canGenerate}
        >
          {running ? "Generating…" : "Generate"}
        </button>
      </section>

      {job ? (
        <section className="section">
          <SectionLabel>job</SectionLabel>
          <div className="job">
            <div className="job-head">
              <StatusBadge status={job.job.status} />
              <span className="mono faint">{job.job.provider}</span>
              <span className="spacer" />
              {running ? (
                <button className="btn ghost danger" onClick={onCancel}>
                  Cancel
                </button>
              ) : null}
            </div>
            <div
              className={`progress ${
                running && job.job.progress === undefined ? "indeterminate" : ""
              }`}
            >
              <i style={{ width: `${Math.round((job.job.progress ?? 0) * 100)}%` }} />
            </div>
            {job.job.errorMessage ? (
              <div className="notice error" style={{ marginTop: 8 }}>
                {job.job.errorMessage}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </>
  );
}
