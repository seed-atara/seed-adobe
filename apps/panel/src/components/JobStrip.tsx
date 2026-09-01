import { useEffect, useState } from "react";
import type { JobView, SeedClient } from "../api/client.ts";
import { AssetImage, SectionLabel, StatusBadge } from "./primitives.tsx";

/**
 * Work in flight, and what it turned into.
 *
 * Shared by Generate and Restore because a job looks the same whatever started
 * it — and because the two behaviours here were learned the hard way and are
 * not worth learning twice. A second copy of this would eventually show a
 * determinate bar sitting at zero, which is the exact thing it exists to avoid.
 */

/** Whether the provider is reporting real movement, rather than 0 or 1. */
function moving(progress: number | undefined): boolean {
  return typeof progress === "number" && progress > 0 && progress < 1;
}

function elapsed(createdAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

interface Props {
  client: SeedClient;
  jobs: JobView[];
  /** Heading. The caller knows whether these are variants or treatments. */
  label: string;
  /** A word per card, when the caller has something better than "1, 2, 3". */
  captions?: string[];
  selectedId?: string;
  onSelect?: (assetId: string) => void;
  onCancel?: () => void;
}

export function JobStrip({
  client,
  jobs,
  label,
  captions,
  selectedId,
  onSelect,
  onCancel,
}: Props) {
  /*
   * A clock, so "3m 20s" keeps counting while a render runs. Seedance reports
   * no progress at all until it finishes, so without this the panel has
   * nothing moving on it for minutes and reads as hung.
   */
  const [now, setNow] = useState(() => Date.now());
  const running = jobs.some(
    (entry) => entry.job.status === "queued" || entry.job.status === "running",
  );

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  if (jobs.length === 0) return null;

  return (
    <section className="section">
      <SectionLabel>{label}</SectionLabel>

      <div className="variants">
        {jobs.map((entry, index) => {
          const output = entry.outputs[0];
          const selected = output !== undefined && output.id === selectedId;
          const active =
            entry.job.status === "queued" || entry.job.status === "running";
          const caption = captions?.[index];
          return (
            <div className={`variant ${selected ? "selected" : ""}`} key={entry.job.id}>
              <div className="variant-head">
                {caption ? (
                  <span className="faint">{caption}</span>
                ) : jobs.length > 1 ? (
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
                  <AssetImage client={client} asset={output} variant="thumbnail" />
                </button>
              ) : (
                <>
                  {/*
                    Seedance reports 0 until it is finished, so a determinate
                    bar sits empty and motionless for minutes — which reads as a
                    hung job. A bar is only determinate when the provider is
                    actually reporting movement.
                  */}
                  <div
                    className={`progress ${
                      active && !moving(entry.job.progress) ? "indeterminate" : ""
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

      {running && onCancel ? (
        <button className="btn ghost danger wide" onClick={onCancel}>
          Cancel {jobs.length > 1 ? "all" : ""}
        </button>
      ) : null}
    </section>
  );
}
