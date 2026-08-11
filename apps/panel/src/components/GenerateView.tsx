import { useEffect, useState } from "react";
import type { Asset, ComposedPlan, GenerationOperation } from "@seed-ae/domain";
import type { AeRegion } from "../api/cep.ts";
import { assetToken } from "../mentions.ts";
import {
  aspectOf,
  closestAspect,
  describeAspect,
  parseAspect,
} from "../aspect.ts";
import type {
  JobView,
  ProviderCapabilitiesDto,
  SeedClient,
} from "../api/client.ts";
import { AssetImage, Field, SectionLabel, StatusBadge } from "./primitives.tsx";
import { PromptField } from "./PromptField.tsx";

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
  /**
   * The shape the region is held to. Blank is free.
   *
   * Only ratios the provider actually offers appear, so a region cannot be
   * framed to a shape nothing can generate.
   */
  aspect: string;
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
  /** How many to generate at once, each with its own seed. */
  variants: string;
  /** Blank means the provider's own default. */
  aspectRatio: string;
  /** Which reference "Fit reference" measures. Blank means the first. */
  aspectSourceId: string;
  inputAssetIds: string[];
  parentAssetId?: string;
  parentGenerationId?: string;
}

interface Props {
  client: SeedClient;
  providers: ProviderCapabilitiesDto[];
  assets: Asset[];
  form: GenerateForm;
  jobs: JobView[];
  selectedId?: string;
  onSelect?: (assetId: string) => void;
  busy: boolean;
  onFormChange: (form: GenerateForm) => void;
  onCapture: () => void;
  /** "AEFT" | "PPRO" | "unknown" — capture is only reliable in After Effects. */
  host?: string;
  /** Where Premiere should export a frame to, shown so it can be pasted. */
  originalsDir?: string;
  onPickupFrame?: () => void;
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
  onRegionAspect?: (aspect: string) => void;
  onRegionContain?: (contained: boolean) => void;
  onInsertRegion?: () => void;
}

/** Whether the provider is reporting real movement, rather than 0 or 1. */
function moving(progress: number | undefined): boolean {
  return typeof progress === "number" && progress > 0 && progress < 1;
}

/** How long a job has been going, in the units a person would say it in. */
function elapsed(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** Moves one entry, leaving the rest in order. */
function move(ids: string[], index: number, by: number): string[] {
  const next = [...ids];
  const target = index + by;
  if (target < 0 || target >= next.length) return next;
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as string);
  return next;
}

export function GenerateView({
  client,
  providers,
  assets,
  form,
  jobs,
  selectedId,
  onSelect,
  busy,
  onFormChange,
  onCapture,
  host,
  originalsDir,
  onPickupFrame,
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
  onRegionAspect,
  onRegionContain,
  onInsertRegion,
}: Props) {
  const [directingFor, setDirectingFor] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [refMenu, setRefMenu] = useState<{ x: number; y: number; asset: Asset }>();

  const provider = providers.find((item) => item.id === form.providerId);
  const references = form.inputAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => asset !== undefined);

  const patch = (changes: Partial<GenerateForm>) =>
    onFormChange({ ...form, ...changes });

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

  /** Adds the token to the prompt, so a reference can be named by pointing. */
  const insertToken = (asset: Asset) => {
    const token = `@${assetToken(asset)}`;
    const prompt = form.prompt.trimEnd();
    patch({ prompt: prompt ? `${prompt} ${token} ` : `${token} ` });
  };

  /**
   * Puts the token on the clipboard.
   *
   * execCommand rather than the async clipboard API: a CEP panel is not a
   * secure context by the browser's reckoning, so navigator.clipboard is not
   * reliably available there.
   */
  const copyToken = (asset: Asset) => {
    const field = document.createElement("textarea");
    field.value = `@${assetToken(asset)}`;
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand("copy");
    } finally {
      document.body.removeChild(field);
    }
  };

  const patchRegion = (changes: Partial<RegionSettings>) => {
    if (region && onRegionChange) onRegionChange({ ...region, ...changes });
  };

  /*
   * "adaptive" is a policy, not a shape — a region cannot be framed to it, and
   * offering it here would promise a constraint that has nothing to enforce.
   */
  const shapeOptions = (provider?.aspectRatios ?? []).filter(
    (ratio) => parseAspect(ratio) !== undefined,
  );

  const selected = regions?.find((item) => item.name === region?.name);
  const running = jobs.some(
    (entry) => entry.job.status === "queued" || entry.job.status === "running",
  );

  /*
   * Renders take minutes and the provider reports no progress along the way,
   * so elapsed time is the only real signal there is. It has to tick on its
   * own: nothing else changes between the start and the end of a render.
   */
  useEffect(() => {
    if (!refMenu) return;
    const dismiss = () => setRefMenu(undefined);
    window.addEventListener("click", dismiss);
    window.addEventListener("contextmenu", dismiss);
    return () => {
      window.removeEventListener("click", dismiss);
      window.removeEventListener("contextmenu", dismiss);
    };
  }, [refMenu]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  /** Every finished result across the set, in the order they were started. */
  const results = jobs.flatMap((entry) => entry.outputs);

  /*
   * A single reference becomes the first frame, and the first frame dictates
   * the output shape — the API refuses a ratio alongside one, saying so in as
   * many words. Offering the control there would be offering a choice that
   * does not exist.
   */
  const shapeFromFrame =
    form.operation === "video.generate" && references.length === 1;

  /*
   * With several references the shape is a choice, not a fact: a plate for the
   * camera move and stills for the characters have no reason to agree, and
   * only the artist knows which one the frame should match.
   */
  const aspectSource =
    references.find((asset) => asset.id === form.aspectSourceId) ??
    references[0];
  const referenceAspect = aspectOf(aspectSource);

  /** Moves the form to whichever offered option matches the reference. */
  const fitToReference = () => {
    if (referenceAspect === undefined) return;
    const ratio = closestAspect(provider?.aspectRatios ?? [], referenceAspect);
    const size = closestAspect(provider?.sizes ?? [], referenceAspect);
    patch({
      ...(ratio ? { aspectRatio: ratio } : {}),
      ...(size ? { size } : {}),
    });
  };

  /** What "composite this" means: the chosen variant, else the first result. */
  const finishedOutput =
    results.find((asset) => asset.id === selectedId) ?? results[0];

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
        {host === "PPRO" ? (
          /*
           * Premiere's frame export is disabled rather than left to fail
           * quietly. Four routes were tried and every one returned the first
           * frame of the sequence while reporting success — a button that
           * hands back the wrong frame and calls it done is worse than no
           * button, because the mistake is only visible much later.
           */
          <>
            <div className="hint faint" style={{ marginBottom: 6 }}>
              Premiere's own <b>Export Frame</b> (Ctrl+Shift+E) gets the right
              frame where every scripted route gets the first one. Export into
              the SEED folder, then pick it up here.
            </div>
            <button
              className="btn primary wide"
              onClick={onPickupFrame}
              disabled={busy}
            >
              Pick up exported frame
            </button>
            {originalsDir ? (
              <div className="hint faint mono" style={{ marginTop: 4, wordBreak: "break-all" }}>
                {originalsDir}
              </div>
            ) : null}
          </>
        ) : (
          <button className="btn primary wide" onClick={onCapture} disabled={busy}>
            Capture current frame
          </button>
        )}
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
              <Field label="Size" hint="longest edge, in comp pixels">
                <input
                  type="number"
                  min={64}
                  value={region.newSize}
                  onChange={(event) =>
                    patchRegion({ newSize: event.target.value })
                  }
                />
              </Field>
              <Field label="Shape">
                <select
                  value={region.aspect}
                  onChange={(event) =>
                    patchRegion({ aspect: event.target.value })
                  }
                >
                  <option value="">Free</option>
                  {shapeOptions.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
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

              <Field
                label="Shape"
                hint={
                  selected
                    ? `${selected.width}x${selected.height}${
                        selected.locked ? " — held while you scale" : " — free"
                      }`
                    : undefined
                }
              >
                <select
                  value={region.aspect}
                  onChange={(event) => onRegionAspect?.(event.target.value)}
                >
                  <option value="">Free</option>
                  {shapeOptions.map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Bounds" hint="Stops the region at the comp edges">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={selected?.contained ?? false}
                    onChange={(event) => onRegionContain?.(event.target.checked)}
                  />
                  Keep inside the comp
                </label>
              </Field>

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
        {references.length > 1 ? (
          <div className="hint faint" style={{ marginBottom: 6 }}>
            Position is meaning: the prompt refers to these as Image 1, Image 2
            and so on. Use ◀ ▶ to reorder.
          </div>
        ) : null}
        <div className="ref-row">
          {references.map((asset, index) => (
            <div
              className="ref"
              key={asset.id}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setRefMenu({ x: event.clientX, y: event.clientY, asset });
              }}
            >
              <AssetImage client={client} asset={asset} variant="thumbnail" />
              <span className="ref-index mono">{index + 1}</span>
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
              {references.length > 1 ? (
                <div className="ref-move">
                  <button
                    title="Move earlier"
                    disabled={index === 0}
                    onClick={() => patch({ inputAssetIds: move(form.inputAssetIds, index, -1) })}
                  >
                    ◀
                  </button>
                  <button
                    title="Move later"
                    disabled={index === references.length - 1}
                    onClick={() => patch({ inputAssetIds: move(form.inputAssetIds, index, 1) })}
                  >
                    ▶
                  </button>
                </div>
              ) : null}
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
          <PromptField
            client={client}
            assets={assets}
            value={form.prompt}
            placeholder={
              onDirect
                ? "Describe the shot — type @ to name a reference…"
                : references.length > 0
                  ? "Image 1 is the reference. Keep the subject; relight as…"
                  : "Describe the image you want…"
            }
            onChange={(prompt) => patch({ prompt })}
          />
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

        {(provider?.aspectRatios.length ?? 0) > 0 && !shapeFromFrame ? (
          <Field
            label="Aspect"
            hint={
              referenceAspect !== undefined && aspectSource
                ? `${aspectSource.filename} is ${describeAspect(referenceAspect)}`
                : "The shape of the result"
            }
          >
            <div className="row">
              <select
                value={form.aspectRatio}
                onChange={(event) => patch({ aspectRatio: event.target.value })}
              >
                <option value="">provider default</option>
                {(provider?.aspectRatios ?? []).map((ratio) => (
                  <option key={ratio} value={ratio}>
                    {ratio}
                    {parseAspect(ratio) === undefined ? "" : ""}
                  </option>
                ))}
              </select>
              {references.length > 1 ? (
                <select
                  value={form.aspectSourceId || (references[0]?.id ?? "")}
                  onChange={(event) =>
                    patch({ aspectSourceId: event.target.value })
                  }
                  title="Which reference sets the shape"
                >
                  {references.map((asset, index) => (
                    <option key={asset.id} value={asset.id}>
                      from Image {index + 1}
                    </option>
                  ))}
                </select>
              ) : null}
              <button
                className="btn"
                onClick={fitToReference}
                disabled={referenceAspect === undefined}
                title={
                  referenceAspect === undefined
                    ? "Add a reference whose dimensions are known"
                    : "Pick the offered option closest to the reference"
                }
              >
                Fit reference
              </button>
            </div>
          </Field>
        ) : null}

        {shapeFromFrame ? (
          <div className="hint faint" style={{ marginBottom: 8 }}>
            The reference is the first frame, so it sets the shape — this
            provider refuses an aspect ratio alongside one.
          </div>
        ) : null}

        <Field
          label="Variants"
          hint={
            provider?.seed
              ? "Generated at once, each with its own seed"
              : "Generated at once; this provider ignores seeds"
          }
        >
          <select
            value={form.variants}
            onChange={(event) => patch({ variants: event.target.value })}
          >
            {["1", "2", "3", "4"].map((count) => (
              <option key={count} value={count}>
                {count === "1" ? "1 (single)" : `${count} to choose from`}
              </option>
            ))}
          </select>
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

      {refMenu ? (
        <ul
          className="ctx-menu"
          style={{ left: refMenu.x, top: refMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <li>
            <button
              onClick={() => {
                insertToken(refMenu.asset);
                setRefMenu(undefined);
              }}
            >
              Insert @{assetToken(refMenu.asset)} into the prompt
            </button>
          </li>
          <li>
            <button
              onClick={() => {
                copyToken(refMenu.asset);
                setRefMenu(undefined);
              }}
            >
              Copy @{assetToken(refMenu.asset)}
            </button>
          </li>
        </ul>
      ) : null}

      {jobs.length > 0 ? (
        <section className="section">
          <SectionLabel>
            {jobs.length > 1 ? `results — ${jobs.length} variants` : "job"}
          </SectionLabel>

          <div className="variants">
            {jobs.map((entry, index) => {
              const output = entry.outputs[0];
              const selected = output !== undefined && output.id === selectedId;
              const active =
                entry.job.status === "queued" || entry.job.status === "running";
              return (
                <div
                  className={`variant ${selected ? "selected" : ""}`}
                  key={entry.job.id}
                >
                  <div className="variant-head">
                    {jobs.length > 1 ? (
                      <span className="mono faint">{index + 1}</span>
                    ) : null}
                    <StatusBadge status={entry.job.status} />
                  </div>

                  {output ? (
                    <button
                      className="variant-pick"
                      onClick={() => onSelect?.(output.id)}
                      title="Choose this one"
                    >
                      <AssetImage
                        client={client}
                        asset={output}
                        variant="thumbnail"
                      />
                    </button>
                  ) : (
                    <>
                      {/*
                        Seedance reports 0 until it is finished, so a
                        determinate bar sits empty and motionless for minutes —
                        which reads as a hung job. A bar is only determinate
                        when the provider is actually reporting movement.
                      */}
                      <div
                        className={`progress ${
                          active && !moving(entry.job.progress)
                            ? "indeterminate"
                            : ""
                        }`}
                      >
                        <i
                          style={{
                            width: `${Math.round((entry.job.progress ?? 0) * 100)}%`,
                          }}
                        />
                      </div>
                      {active ? (
                        <div className="hint faint" style={{ marginTop: 2 }}>
                          {elapsed(entry.job.createdAt, now)}
                        </div>
                      ) : null}
                    </>
                  )}

                  {entry.job.errorMessage ? (
                    <div className="hint faint">{entry.job.errorMessage}</div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {running ? (
            <button className="btn ghost danger wide" onClick={onCancel}>
              Cancel {jobs.length > 1 ? "all" : ""}
            </button>
          ) : null}
        </section>
      ) : null}

    </>
  );
}
