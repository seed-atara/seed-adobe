/**
 * Enough MP4 parsing to answer "how big is this video".
 *
 * Not a decoder — the coded frame size lives in the sample description, in
 * plain 16-bit fields, and reading it needs no codec at all. Without it a
 * generated clip is registered with no dimensions, which leaves anything
 * placing it on a timeline guessing at its scale.
 */

export interface Mp4Size {
  width: number;
  height: number;
  /** Seconds, from the movie header, when it can be read. */
  durationSeconds?: number;
}

/** The visual sample entries that carry a frame size. */
const VISUAL_CODECS = ["avc1", "avc3", "hvc1", "hev1", "mp4v", "av01", "vp09"];

export function readMp4Size(bytes: Buffer): Mp4Size | undefined {
  const stsd = bytes.indexOf(Buffer.from("stsd", "ascii"));
  if (stsd < 0) return undefined;

  // stsd: type(4) version+flags(4) entryCount(4), then the first sample entry.
  const entry = stsd + 12;
  if (entry + 40 > bytes.length) return undefined;

  const codec = bytes.toString("ascii", entry + 4, entry + 8);
  if (!VISUAL_CODECS.includes(codec)) return undefined;

  // VisualSampleEntry: 8 header, 6 reserved, 2 data ref, 2+2+12 predefined,
  // then width and height as 16-bit each.
  const width = bytes.readUInt16BE(entry + 32);
  const height = bytes.readUInt16BE(entry + 34);
  if (width <= 0 || height <= 0) return undefined;

  return { width, height, ...(readDuration(bytes) ?? {}) };
}

/** Duration from the movie header, which is the whole file's length. */
function readDuration(bytes: Buffer): { durationSeconds: number } | undefined {
  const mvhd = bytes.indexOf(Buffer.from("mvhd", "ascii"));
  if (mvhd < 0) return undefined;

  try {
    const version = bytes[mvhd + 4];
    const timescale =
      version === 1 ? bytes.readUInt32BE(mvhd + 24) : bytes.readUInt32BE(mvhd + 16);
    const duration =
      version === 1
        ? Number(bytes.readBigUInt64BE(mvhd + 28))
        : bytes.readUInt32BE(mvhd + 20);
    if (timescale > 0 && duration > 0) {
      return { durationSeconds: Number((duration / timescale).toFixed(3)) };
    }
  } catch {
    // A truncated header is not worth failing an ingest over.
  }
  return undefined;
}
