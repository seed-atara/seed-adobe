import { useEffect, useState } from "react";
import type { Asset, Generation } from "@seed-ae/domain";
import type { ProviderCapabilitiesDto, SeedClient } from "../api/client.ts";
import type { CepAeBridge } from "../api/cep.ts";
import { describeColor } from "../colorSummary.ts";
import { LookPanel } from "./LookPanel.tsx";
import {
  AssetImage,
  AssetVideo,
  OriginBadge,
  SectionLabel,
  formatBytes,
  formatStamp,
} from "./primitives.tsx";

interface Props {
  client: SeedClient;
  /** Present only inside After Effects. */
  bridge?: CepAeBridge | undefined;
  asset: Asset;
  onVariation: (asset: Asset) => void;
  onUseAsReference: (asset: Asset) => void;
  onShowLineage: () => void;
  onError: (cause: unknown) => void;
  /** Absent when the service has not registered the look provider. */
  lookProvider?: ProviderCapabilitiesDto;
  /** Selects a freshly treated frame, so it can be iterated on in turn. */
  onSelectAsset: (asset: Asset) => void;
}

export function AssetDetail({
  client,
  bridge,
  asset,
  onVariation,
  onUseAsReference,
  onShowLineage,
  onError,
  lookProvider,
  onSelectAsset,
}: Props) {
  const [generation, setGeneration] = useState<Generation | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setGeneration(undefined);
    setNote(undefined);
    setShowRaw(false);
    if (!asset.generationId) return;

    let cancelled = false;
    client
      .recipe(asset.id)
      .then(({ generation: found }) => {
        if (!cancelled) setGeneration(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, asset]);

  const importToProject = async (insertAtPlayhead: boolean) => {
    try {
      const result = bridge
        ? await bridge.importAsset(asset.id, insertAtPlayhead, asset.width)
        : await client.importAsset(asset.id, insertAtPlayhead);
      if (!insertAtPlayhead) {
        setNote(`Imported ${result.name} into the project.`);
      } else {
        const where = result.trackName ? ` on ${result.trackName}` : "";
        // Say when the targeted track was busy, so a surprise placement is
        // explained rather than merely noticed.
        const why = result.movedFromTargeted
          ? ` (${result.movedFromTargeted} already had a clip there)`
          : "";
        setNote(`Inserted ${result.name}${where} at the playhead${why}.`);
      }
    } catch (cause) {
      onError(cause);
    }
  };

  const provenance =
    asset.source.type === "after-effects" ? asset.source.context : undefined;

  return (
    <div className="section">
      <SectionLabel>asset</SectionLabel>

      <div className="preview">
        {asset.kind === "video" && asset.status !== "missing" ? (
          <AssetVideo client={client} asset={asset} />
        ) : asset.kind === "image" && asset.status !== "missing" ? (
          <AssetImage client={client} asset={asset} variant="thumbnail" />
        ) : (
          <div className="empty" style={{ border: "none" }}>
            {asset.status === "missing" ? "media missing" : asset.kind}
          </div>
        )}
      </div>

      <div className="actions">
        <button className="btn" onClick={() => importToProject(false)}>
          Import
        </button>
        <button className="btn" onClick={() => importToProject(true)}>
          Insert at playhead
        </button>
        <button className="btn" onClick={() => onUseAsReference(asset)}>
          Use as reference
        </button>
        {asset.generationId ? (
          <button className="btn" onClick={() => onVariation(asset)}>
            Variation
          </button>
        ) : null}
        <button className="btn ghost" onClick={onShowLineage}>
          Lineage
        </button>
      </div>

      {note ? <div className="notice">{note}</div> : null}

      <LookPanel
        client={client}
        bridge={bridge}
        asset={asset}
        {...(lookProvider ? { provider: lookProvider } : {})}
        onApplied={onSelectAsset}
        onError={onError}
      />

      <div className="section">
        <SectionLabel>media</SectionLabel>
        <dl className="kv">
          <dt>origin</dt>
          <dd>
            <OriginBadge asset={asset} />
          </dd>
          <dt>file</dt>
          <dd className="mono">{asset.filename}</dd>
          <dt>type</dt>
          <dd className="mono">{asset.mimeType}</dd>
          <dt>size</dt>
          <dd className="mono">
            {asset.width ? `${asset.width}×${asset.height} · ` : ""}
            {formatBytes(asset.byteSize)}
          </dd>
          <dt>created</dt>
          <dd className="mono">{formatStamp(asset.createdAt)}</dd>
          <dt>id</dt>
          <dd className="mono faint">{asset.id}</dd>
        </dl>
      </div>

      {generation ? (
        <div className="section">
          <SectionLabel>recipe</SectionLabel>
          <dl className="kv">
            <dt>provider</dt>
            <dd className="mono">{generation.provider}</dd>
            <dt>model</dt>
            <dd className="mono">{generation.model}</dd>
            <dt>operation</dt>
            <dd className="mono">{generation.operation}</dd>
            <dt>seed</dt>
            <dd className="mono">{generation.seed ?? "—"}</dd>
            <dt>prompt</dt>
            <dd>{generation.prompt}</dd>
            <dt>params</dt>
            <dd className="mono faint">
              {Object.entries(generation.parameters)
                .map(([key, value]) => `${key}=${String(value)}`)
                .join("  ") || "—"}
            </dd>
          </dl>
          <div style={{ height: 8 }} />
          <button
            className="btn ghost"
            onClick={() => setShowRaw((current) => !current)}
          >
            {showRaw ? "Hide" : "Show"} raw provider payload
          </button>
          {showRaw ? (
            <pre className="raw">
              {JSON.stringify(
                { request: generation.rawRequest, response: generation.rawResponse },
                null,
                2,
              )}
            </pre>
          ) : null}
        </div>
      ) : null}

      {provenance ? (
        <div className="section">
          <SectionLabel>after effects provenance</SectionLabel>
          <dl className="kv">
            <dt>project</dt>
            <dd className="mono">{provenance.projectName ?? "—"}</dd>
            <dt>comp</dt>
            <dd className="mono">{provenance.compName ?? "—"}</dd>
            <dt>frame</dt>
            <dd className="mono">
              {provenance.frameNumber ?? "—"}
              {provenance.timeSeconds !== undefined
                ? ` · ${provenance.timeSeconds}s`
                : ""}
            </dd>
            <dt>format</dt>
            <dd className="mono">
              {provenance.width}×{provenance.height} · {provenance.fps} fps
            </dd>
            <dt>color</dt>
            <dd className="mono faint">{describeColor(provenance)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
