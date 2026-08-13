import type { Asset } from "@seed-ae/domain";
import type { SeedClient } from "./api/client.ts";

/**
 * Extracts a clip's first frame in the panel and stores it as the poster.
 *
 * The service cannot decode video — no decoder, and adding one to make a
 * thumbnail would be absurd. The panel is Chromium, which has had one all
 * along. A `<video>` seeked to its opening frame and drawn into a canvas is a
 * real extract of *this* clip, which matters most for a reskin: the borrowed
 * poster showed the source, the very thing the generation was asked to change.
 *
 * Everything here is best-effort. A codec the browser will not open, a frame
 * that never decodes, a service that refuses the write — none of them are
 * worth interrupting an artist for, so they all end as "no poster this time".
 */

const THUMBNAIL_MAX_EDGE = 512;

/** One attempt per asset per session; a failure is not retried in a loop. */
const attempted = new Set<string>();

export function posterAttempted(assetId: string): boolean {
  return attempted.has(assetId);
}

export async function extractPoster(
  client: SeedClient,
  asset: Asset,
): Promise<string | undefined> {
  if (asset.kind !== "video" || attempted.has(asset.id)) return undefined;
  attempted.add(asset.id);

  let objectUrl: string | undefined;
  try {
    const blob = await client.assetBlob(asset);
    objectUrl = URL.createObjectURL(blob);
    const png = await drawFirstFrame(objectUrl);
    if (!png) return undefined;

    await client.setPoster(asset.id, png.base64);
    return png.dataUrl;
  } catch {
    return undefined;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Loads the clip, seeks just past the start, and draws one frame.
 *
 * Just past rather than exactly at: seeking to 0 can present the frame before
 * the first decoded picture, which arrives as a blank canvas. A twentieth of a
 * second in is still the opening frame to anyone looking at it.
 */
async function drawFirstFrame(
  src: string,
): Promise<{ base64: string; dataUrl: string } | undefined> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = src;

  try {
    await once(video, "loadeddata", 15000);
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return undefined;

    // A seek that lands where it already is fires no event, so only wait when
    // there is somewhere to go.
    const target = Math.min(0.05, (video.duration || 1) / 2);
    if (target > 0) {
      video.currentTime = target;
      await once(video, "seeked", 15000).catch(() => undefined);
    }

    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext("2d");
    if (!context) return undefined;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (!base64) return undefined;
    return { base64, dataUrl };
  } finally {
    // Release the decoder rather than leaving a video element holding one.
    video.removeAttribute("src");
    video.load();
  }
}

function once(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error?: Error) => {
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const onEvent = () => done();
    const onError = () => done(new Error(`video ${event} failed`));
    const timer = setTimeout(() => done(new Error(`video ${event} timed out`)), timeoutMs);

    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}
