import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { AssetImage, OriginBadge, SectionLabel, formatStamp } from "./primitives.tsx";

interface Props {
  client: SeedClient;
  assets: Asset[];
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Absent while a removal is in flight, or when removal is not offered. */
  onRemove?: (asset: Asset) => void;
}

export function LibraryView({
  client,
  assets,
  selectedId,
  onSelect,
  onRemove,
}: Props) {
  if (assets.length === 0) {
    return (
      <div className="section">
        <SectionLabel>asset library</SectionLabel>
        <div className="empty">
          Nothing captured yet. Capture the current frame to start.
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <SectionLabel>asset library - {assets.length}</SectionLabel>
      <div className="grid">
        {assets.map((asset) => (
          // A wrapper, because remove cannot be a button inside a button.
          <div className="card-slot" key={asset.id}>
            {onRemove ? (
              <button
                className="card-remove"
                title={`Remove ${asset.filename} from the library`}
                onClick={() => onRemove(asset)}
              >
                ×
              </button>
            ) : null}
          <button
            className="card"
            aria-current={asset.id === selectedId}
            onClick={() => onSelect(asset.id)}
          >
            <div className="thumb">
              {asset.status === "missing" ? (
                <span className="placeholder">media missing</span>
              ) : (
                // Including clips with no poster: AssetImage extracts one
                // rather than showing a grey card forever.
                <AssetImage client={client} asset={asset} variant="thumbnail" />
              )}
              {asset.kind === "video" ? (
                <span className="play-marker" aria-hidden="true">
                  &#9654;
                </span>
              ) : null}
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
          </div>
        ))}
      </div>
    </div>
  );
}
