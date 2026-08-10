import { useRef, useState } from "react";
import type { Asset, ComposedPlan, GenerationOperation } from "@seed-ae/domain";
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

export interface GenerateForm {
  providerId: string;
  model: string;
  operation: GenerationOperation;
  prompt: string;
  seed: string;
  size: string;
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
}: Props) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string>();

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

  const running =
    job !== undefined &&
    (job.job.status === "queued" || job.job.status === "running");

  const referencesFull =
    provider !== undefined && references.length >= provider.maxImageReferences;

  const canGenerate =
    !busy &&
    !running &&
    provider !== undefined &&
    form.prompt.trim().length > 0 &&
    (form.operation !== "image.edit" || references.length > 0);

  return (
    <>
      <section className="section">
        <SectionLabel>source</SectionLabel>
        <button
          className="btn primary wide"
          onClick={onCapture}
          disabled={busy || referencesFull}
        >
          Capture current frame
        </button>
        {referencesFull ? (
          <div className="hint faint" style={{ marginTop: 6 }}>
            {provider?.displayName} accepts {provider?.maxImageReferences}{" "}
            references. Remove one to capture another.
          </div>
        ) : null}
      </section>

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
            <div className="hint faint" style={{ marginTop: 4 }}>
              Rewrites the prompt from your description, picks the references,
              and fills the settings below. Nothing runs until you press
              Generate.
            </div>
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
              onChange={(event) => {
                const next = providers.find(
                  (item) => item.id === event.target.value,
                );
                patch({
                  providerId: event.target.value,
                  model: next?.models[0] ?? "",
                  size: next?.sizes[0] ?? "",
                });
              }}
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

        {form.parentGenerationId ? (
          <div className="notice">
            Branching from an existing recipe. The original stays untouched;
            this run is recorded as a descendant.
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
