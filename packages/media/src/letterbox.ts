import type { RasterImage } from "./png.js";

/**
 * Finding the picture inside a frame that has bars baked into it.
 *
 * A square or portrait shot delivered as HD carries its own pillarbox: the file
 * is 1920x1080, the picture is 1080x1080, and 420 columns each side are black.
 * Nothing downstream can tell the difference by looking at the dimensions,
 * because the dimensions are honest — the frame really is 16:9.
 *
 * This matters twice over for expansion:
 *
 * 1. **The aspect is a lie.** Asking to expand such a frame to 16:9 adds no
 *    area at all, because it is already 16:9. The artist means the *picture*,
 *    not the delivery.
 * 2. **The bars break the track.** They are static and they can be nearly half
 *    the frame, so a matcher scoring the whole frame is rewarded for reporting
 *    no motion — the bars agree perfectly at zero offset and disagree at every
 *    other. A pan measured through its own pillarbox reads as a locked-off
 *    shot.
 *
 * So the picture is found and cropped to before anything else happens, and the
 * crop is reported rather than done silently: an artist who did not know their
 * clip was padded should be told, and one who did should be able to see that
 * the right amount came off.
 */

export interface PictureBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarOptions {
  /** Below this mean luma a line counts as a bar. Bars are not always pure black. */
  threshold?: number;
  /**
   * How uniform a line has to be.
   *
   * A dark *picture* row — a night sky, a shadowed foreground — can be as dark
   * as a bar, but it is never as flat. Requiring near-zero spread is what
   * separates padding from photography, and it is why this does not eat the
   * top of a low-key shot.
   */
  maxSpread?: number;
  /**
   * Refuse to crop away more than this share of either dimension.
   *
   * Generous on purpose. Pillarboxing a portrait 9:16 into 16:9 removes 68% of
   * the width, and that is the single most common padded delivery there is — a
   * tighter bound rejects exactly the case this exists for. What it still
   * catches is a sliver of picture in a mostly black frame, which is a mistake
   * rather than a crop.
   */
  maxCropFraction?: number;
  /**
   * Smallest bar worth calling a bar, in pixels.
   *
   * A one-pixel dark edge is not a delivery pad — it is a dark frame, a slightly
   * mis-set matte, or noise. Without this floor a low-key night exterior loses a
   * column, which is a silent way to throw away picture.
   */
  minBar?: number;
}

function lineStats(
  image: RasterImage,
  along: "column" | "row",
  index: number,
): { mean: number; spread: number } {
  const { width, height } = image;
  const count = along === "column" ? height : width;
  const step = Math.max(1, Math.floor(count / 64));

  let total = 0;
  let min = 255;
  let max = 0;
  let n = 0;
  for (let i = 0; i < count; i += step) {
    const x = along === "column" ? index : i;
    const y = along === "column" ? i : index;
    const at = (y * width + x) * 4;
    const luma =
      0.2126 * (image.rgba[at] as number) +
      0.7152 * (image.rgba[at + 1] as number) +
      0.0722 * (image.rgba[at + 2] as number);
    total += luma;
    if (luma < min) min = luma;
    if (luma > max) max = luma;
    n += 1;
  }
  return { mean: n === 0 ? 0 : total / n, spread: max - min };
}

/**
 * The picture area shared by every frame given.
 *
 * Every frame has to agree. A bar is a property of the delivery and is present
 * throughout; a dark edge that appears in one frame is content, and cropping to
 * it would throw away picture.
 */
export function detectBars(
  frames: RasterImage[],
  options: BarOptions = {},
): PictureBounds | undefined {
  if (frames.length === 0) return undefined;
  const threshold = options.threshold ?? 14;
  const maxSpread = options.maxSpread ?? 10;
  const maxCropFraction = options.maxCropFraction ?? 0.8;

  const first = frames[0] as RasterImage;
  const { width, height } = first;
  const sample = frames.filter(
    (frame) => frame.width === width && frame.height === height,
  );
  if (sample.length === 0) return undefined;

  const isBar = (along: "column" | "row", index: number): boolean =>
    sample.every((frame) => {
      const { mean, spread } = lineStats(frame, along, index);
      return mean <= threshold && spread <= maxSpread;
    });

  let left = 0;
  while (left < width && isBar("column", left)) left += 1;
  let right = width - 1;
  while (right > left && isBar("column", right)) right -= 1;
  let top = 0;
  while (top < height && isBar("row", top)) top += 1;
  let bottom = height - 1;
  while (bottom > top && isBar("row", bottom)) bottom -= 1;

  // Anything smaller than this is a dark edge, not padding.
  const minBar = options.minBar ?? Math.max(4, Math.round(Math.min(width, height) * 0.01));
  if (left < minBar) left = 0;
  if (width - 1 - right < minBar) right = width - 1;
  if (top < minBar) top = 0;
  if (height - 1 - bottom < minBar) bottom = height - 1;

  const cropped: PictureBounds = {
    x: left,
    y: top,
    width: right - left + 1,
    height: bottom - top + 1,
  };

  if (cropped.width <= 0 || cropped.height <= 0) return undefined;
  if (cropped.width === width && cropped.height === height) return undefined;

  // A frame that is mostly dark is not a frame that is mostly bars.
  if (
    cropped.width < width * (1 - maxCropFraction) ||
    cropped.height < height * (1 - maxCropFraction)
  ) {
    return undefined;
  }

  return cropped;
}

/** Cuts a rectangle out of a frame. */
export function cropTo(image: RasterImage, bounds: PictureBounds): RasterImage {
  const rgba = new Uint8Array(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const from = ((bounds.y + y) * image.width + (bounds.x + x)) * 4;
      const to = (y * bounds.width + x) * 4;
      rgba[to] = image.rgba[from] as number;
      rgba[to + 1] = image.rgba[from + 1] as number;
      rgba[to + 2] = image.rgba[from + 2] as number;
      rgba[to + 3] = image.rgba[from + 3] as number;
    }
  }
  return { width: bounds.width, height: bounds.height, rgba };
}

/** Describes a crop the way an artist would say it. */
export function describeBars(
  bounds: PictureBounds,
  width: number,
  height: number,
): string {
  const sides: string[] = [];
  if (bounds.x > 0) sides.push(`${bounds.x}px left`);
  const rightBar = width - (bounds.x + bounds.width);
  if (rightBar > 0) sides.push(`${rightBar}px right`);
  if (bounds.y > 0) sides.push(`${bounds.y}px top`);
  const bottomBar = height - (bounds.y + bounds.height);
  if (bottomBar > 0) sides.push(`${bottomBar}px bottom`);

  const kind =
    bounds.x > 0 && bounds.y === 0
      ? "pillarbox"
      : bounds.y > 0 && bounds.x === 0
        ? "letterbox"
        : "bars";
  return `${kind} removed (${sides.join(", ")}) — the picture is ${bounds.width}x${bounds.height}`;
}
