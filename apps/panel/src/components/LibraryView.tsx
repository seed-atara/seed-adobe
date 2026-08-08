import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { OriginBadge, SectionLabel, formatStamp } from "./primitives.tsx";

interface Props {
  client: SeedClient;
  assets: Asset[];
  selectedId?: string;
  onSelect: (id: string) => void;
}

export function LibraryView({ client, assets, selectedId, onSelect }: Props) {
  if (assets.length === 0) {
    return (
      <>
        <SectionLabel>asset library</SectionLabel>
        <div className="empty">
          Nothing captured yet. Capture the current frame to start.
        </div>
      </>
    );
  }

  return (
    <>
      <SectionLabel>asset library — {assets.length}</SectionLabel>
      <div className="grid">
        {assets.map((asset) => (
          <button
            key={asset.id}
            className="card"
            aria-current={asset.id === selectedId}
            onClick={() => onSelect(asset.id)}
          >
            <div className="thumb">
              {asset.status === "missing" ? (
                <span className="placeholder">media missing</span>
              ) : asset.kind === "image" ? (
                <img
                  src={client.assetFileUrl(asset)}
                  alt={asset.filename}
                  loading="lazy"
                />
              ) : (
                <span className="placeholder">{asset.kind}</span>
              )}
              <div className="corner">
                <OriginBadge asset={asset} />
              </div>
            </div>
            <div className="meta">
              <div className="prompt">{asset.filename}</div>
              <div className="stamp">
                {formatStamp(asset.createdAt)}
                {asset.width ? ` · ${asset.width}×${asset.height}` : ""}
              </div>
            </div>
          </button>
        ))}
      </div>
    </>
  );
}
