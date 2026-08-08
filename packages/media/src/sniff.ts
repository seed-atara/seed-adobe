/**
 * Identifies media from its leading bytes.
 *
 * Providers do not reliably describe what they return — Ark's image endpoint
 * hands back JPEG through a field set that says nothing about format — so the
 * bytes are the only trustworthy source. Getting this wrong writes a `.png`
 * file full of JPEG and breaks anything that later trusts the extension.
 */
export function sniffMimeType(bytes: Buffer): string | undefined {
  if (bytes.length < 12) return undefined;

  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString("ascii") === "PNG") {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    return brand.startsWith("qt") ? "video/quicktime" : "video/mp4";
  }
  if (bytes.subarray(0, 4).toString("hex") === "1a45dfa3") {
    return "video/webm";
  }
  return undefined;
}
