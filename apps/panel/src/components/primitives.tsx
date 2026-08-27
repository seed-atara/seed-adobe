import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Asset, JobStatus } from "@seed-ae/domain";
import type { SeedClient } from "../api/client.ts";
import { extractPoster, posterAttempted } from "../poster.ts";

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
    // A clip is not a frame. Both come out of the timeline, but only one can
    // carry motion, and a card that calls a captured range a frame is a card
    // the artist has to open to find out what they actually have.
    return (
      <span className="badge">
        {asset.kind === "video" ? "AE clip" : "AE frame"}
      </span>
    );
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
  /** A poster this panel extracted, shown before the library knows about it. */
  const [extracted, setExtracted] = useState<string | undefined>();

  /*
   * A clip with no poster has nothing to show, and asking for it anyway is
   * worse than showing nothing: the request falls back to the media itself, so
   * the panel downloads an entire video in order to put an mp4 in an <img> and
   * render the browser's broken-image glyph. Say "video" instead — and, since
   * this browser can decode what the service cannot, go and make one.
   */
  const showable = asset.kind === "image" || asset.thumbnailUri !== undefined;

  useEffect(() => {
    if (showable || asset.kind !== "video" || posterAttempted(asset.id)) return;
    let cancelled = false;
    void extractPoster(client, asset).then((dataUrl) => {
      if (!cancelled && dataUrl) setExtracted(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [client, asset, showable]);

  useEffect(() => {
    if (!showable) return;
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
  }, [client, asset.id, asset.thumbnailUri, variant, showable]);

  if (!showable) {
    return extracted ? (
      <img className={className} src={extracted} alt={asset.filename} />
    ) : (
      <span className="placeholder">{asset.kind}</span>
    );
  }
  if (failed) return <span className="placeholder">no preview</span>;
  if (!url) return <span className="placeholder">...</span>;
  return <img className={className} src={url} alt={asset.filename} />;
}

/**
 * Plays generated video inline, under the pointer.
 *
 * Reviewing a generated clip is not the same as watching a video. You want to
 * know what happens in it, several times, quickly — so it plays while the
 * pointer is over it, loops, and returns to its first frame on the way out. A
 * transport bar would just be a row of controls in the way of that.
 *
 * Moving left and right across the clip scrubs it, which is how anyone checks
 * a specific moment. The scrub takes over from playback while the pointer is
 * moving and hands back when it settles, so a still hover keeps playing.
 *
 * Muted always: a clip in a panel is something you glance at while working,
 * not something that should start making noise.
 */
export function AssetVideo({
  client,
  asset,
}: {
  client: SeedClient;
  asset: Asset;
}) {
  const [url, setUrl] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  /**
   * The bytes arrived and the browser will not play them.
   *
   * Distinct from `failed`, which is a download that did not happen. Seedance
   * 2.5's default `mov` is 4:4:4 — H.264 High 4:4:4 Predictive below 1080p,
   * HEVC Rext yuv444p10le at 1080p — and no browser opens either. The clip is
   * not broken; it is the higher-quality deliverable, and After Effects plays
   * it fine. Showing an empty transparent box and a dead scrub bar said
   * "broken" when the truth is "not previewable here".
   */
  const [undecodable, setUndecodable] = useState(false);
  const [progress, setProgress] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubbing = useRef<{ x: number; until: number } | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setFailed(false);
    setUndecodable(false);

    client
      .assetBlob(asset)
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
  }, [client, asset.id]);

  const enter = () => {
    const video = videoRef.current;
    if (!video) return;
    void video.play().catch(() => {
      // Autoplay can be refused; the clip simply stays on its first frame.
    });
  };

  const leave = () => {
    const video = videoRef.current;
    if (!video) return;
    scrubbing.current = undefined;
    video.pause();
    // Rewound rather than left where it stopped, so the card always shows the
    // clip's opening frame — a library of stills at arbitrary moments is
    // impossible to read at a glance.
    video.currentTime = 0;
    setProgress(0);
  };

  /**
   * Horizontal movement scrubs; a still pointer plays.
   *
   * The whole width of the clip is one whole play: dragging across it end to
   * end covers the whole duration, which keeps the gesture the same however
   * long the clip is.
   */
  const move = (event: React.MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;

    const previous = scrubbing.current;
    const now = performance.now();
    scrubbing.current = { x: event.clientX, until: now + 250 };

    if (!previous) return; // first sample only establishes a position
    const dx = event.clientX - previous.x;
    if (dx === 0) return;

    const width = event.currentTarget.clientWidth || 1;
    const next = video.currentTime + (dx / width) * video.duration;
    // Wrap rather than stop: the clip loops, so scrubbing past either end
    // should behave the way playing past the end does.
    const wrapped = ((next % video.duration) + video.duration) % video.duration;

    if (!video.paused) video.pause();
    video.currentTime = wrapped;
    setProgress(wrapped / video.duration);
  };

  // Playback resumes once the pointer has been still for a moment.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const state = scrubbing.current;
      if (!video || !state) return;
      if (performance.now() > state.until && video.paused) {
        scrubbing.current = undefined;
        void video.play().catch(() => {});
      }
    }, 120);
    return () => window.clearInterval(timer);
  }, []);

  if (failed) return <span className="placeholder">could not load video</span>;
  if (!url) return <span className="placeholder">loading video...</span>;

  if (undecodable) {
    // The poster is a real frame of this clip — Seedance returns one with the
    // result — so the card still shows what was made, rather than a gap.
    return (
      <div className="scrub undecodable">
        <AssetImage client={client} asset={asset} variant="thumbnail" />
        <span className="scrub-note">
          Plays in After Effects, not here — this clip is 4:4:4
        </span>
      </div>
    );
  }

  return (
    <div
      className="scrub"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onMouseMove={move}
    >
      <video
        ref={videoRef}
        src={url}
        muted
        loop
        playsInline
        preload="metadata"
        onError={() => setUndecodable(true)}
        onLoadedMetadata={(event) => {
          // Some builds of Chromium accept the container, report a duration of
          // NaN, and then render nothing at all rather than raising `error`.
          // That is the same outcome for the artist, so it is the same state.
          if (!Number.isFinite(event.currentTarget.duration)) {
            setUndecodable(true);
          }
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && video.duration > 0) {
            setProgress(video.currentTime / video.duration);
          }
        }}
      />
      {/* Where we are, and nothing to press: the pointer is the transport. */}
      <div className="scrub-track" aria-hidden="true">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </div>
  );
}
