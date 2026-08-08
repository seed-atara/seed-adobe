import type { ReactNode } from "react";
import type { Asset, JobStatus } from "@seed-ae/domain";

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
