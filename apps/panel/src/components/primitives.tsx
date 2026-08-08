import { useEffect, useState, type ReactNode } from "react";
import type { Asset, JobStatus } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="section-label">{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

const STATUS_TONE: Record<JobStatus, string> = {
  queued: "badge",
  running: "badge accent",
  succeeded: "badge accent",
  failed: "badge danger",
  cancelled: "badge warn",
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={STATUS_TONE[status]}>{status}</span>;
}

/** Source badge: was this rendered out of AE, generated, or brought in? */
export function OriginBadge({ asset }: { asset: Asset }) {
  if (asset.source.type === "after-effects") {
    return <span className="badge">AE frame</span>;
  }
  if (asset.source.type === "generated") {
    return <span className="badge accent">derived</span>;
  }
  return <span className="badge">imported</span>;
}

export function formatStamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Renders asset media.
 *
 * The bytes are fetched with the session token and shown as an object URL,
 * because an <img src> cannot send an Authorization header and the token has
 * no business being in a URL. The object URL is revoked on unmount so a long
 * browsing session does not leak blobs.
 */
export function AssetImage({
  client,
  asset,
  variant,
  className,
}: {
  client: SeedClient;
  asset: Asset;
  variant?: "thumbnail";
  className?: string;
}) {
  const [url, setUrl] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);

    client
      .assetBlob(asset, variant)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, asset.id, asset.thumbnailUri, variant]);

  if (failed) return <span className="placeholder">no preview</span>;
  if (!url) return <span className="placeholder">...</span>;
  return <img className={className} src={url} alt={asset.filename} />;
}
