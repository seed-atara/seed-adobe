import { crc32, deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface RasterImage {
  width: number;
  height: number;
  /** Tightly packed 8-bit RGBA. */
  rgba: Uint8Array;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Minimal 8-bit RGBA PNG encoder — no native dependencies, which keeps the
 * install free of build tools on the machines this ships to.
 */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `expected ${width * height * 4} RGBA bytes, received ${rgba.length}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: truecolour + alpha
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw.writeUInt8(0, y * (stride + 1)); // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function readPngSize(
  buffer: Buffer,
): { width: number; height: number } | undefined {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Bits per sample, straight from the header.
 *
 * Cheap enough to ask before deciding whether a file needs converting at all —
 * a 14MB capture should not be inflated into pixels just to learn it was
 * already 8-bit.
 */
export function readPngDepth(buffer: Buffer): number | undefined {
  if (buffer.length < 26 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }
  return buffer.readUInt8(24);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decoder for 8- and 16-bit non-interlaced PNGs (greyscale, RGB, and either
 * with alpha).
 *
 * 16-bit is not exotic here: After Effects writes it from any project above 8
 * bpc, and the capture path deliberately drops a 32-bit project to 16 for the
 * write. Rejecting it meant every sampled frame from a real project came back
 * "could not be decoded" — the expansion could not read its own input.
 *
 * Samples are taken down to 8 bits by keeping the high byte. Everything
 * downstream — matching, medians, the plate — works in 8-bit, so carrying the
 * low byte would cost memory for precision nothing reads.
 *
 * Palette and interlaced still return undefined rather than guessing, and
 * callers degrade gracefully.
 */
export function decodePng(buffer: Buffer): RasterImage | undefined {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return undefined;
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const interlace = buffer.readUInt8(28);
  const channels = CHANNELS[colorType];

  /*
   * 16 bits per sample as well as 8.
   *
   * After Effects writes 16-bit PNGs from saveFrameToPng as soon as the
   * project is above 8 bpc — which is exactly what the quality work asks for.
   * Rejecting them here meant every capture from a 16 or 32 bpc project
   * decoded to nothing: no thumbnail, no preview, a black card in the library
   * and no way to tell that from a genuinely black frame.
   */
  if ((bitDepth !== 8 && bitDepth !== 16) || interlace !== 0 || channels === undefined) {
    return undefined;
  }
  const sampleBytes = bitDepth === 16 ? 2 : 1;

  const idat: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const start = offset + 8;
    if (type === "IDAT") idat.push(buffer.subarray(start, start + length));
    if (type === "IEND") break;
    offset = start + length + 4;
  }
  if (idat.length === 0) return undefined;

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }

  const stride = width * channels * sampleBytes;
  if (raw.length < (stride + 1) * height) return undefined;

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev =
      y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride);
    // Filtering is defined on bytes, and a 16-bit pixel is twice as many of
    // them — so the "left" neighbour is that much further back.
    unfilter(filter, line, out, prev, channels * sampleBytes);
  }

  /*
   * Narrowed to 8 bits by keeping the high byte of each big-endian sample.
   * Everything downstream of here — thumbnails, previews, the chart checks —
   * is 8-bit by construction, and truncation is the correct narrowing: it is
   * what the top 8 bits of the value already say.
   */
  const narrowed =
    sampleBytes === 1 ? pixels : narrowSamples(pixels, width * height * channels);

  return { width, height, rgba: toRgba(narrowed, width, height, colorType) };
}

function unfilter(
  filter: number,
  line: Buffer,
  out: Buffer,
  prev: Buffer | undefined,
  bpp: number,
): void {
  for (let i = 0; i < line.length; i += 1) {
    const rawByte = line[i] as number;
    const left = i >= bpp ? (out[i - bpp] as number) : 0;
    const up = prev ? (prev[i] as number) : 0;
    const upLeft = prev && i >= bpp ? (prev[i - bpp] as number) : 0;

    let value: number;
    switch (filter) {
      case 0:
        value = rawByte;
        break;
      case 1:
        value = rawByte + left;
        break;
      case 2:
        value = rawByte + up;
        break;
      case 3:
        value = rawByte + ((left + up) >> 1);
        break;
      case 4:
        value = rawByte + paeth(left, up, upLeft);
        break;
      default:
        value = rawByte;
    }
    out[i] = value & 0xff;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** The high byte of every big-endian 16-bit sample, in order. */
function narrowSamples(pixels: Buffer, samples: number): Buffer {
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i += 1) out[i] = pixels[i * 2] as number;
  return out;
}

function toRgba(
  pixels: Buffer,
  width: number,
  height: number,
  colorType: number,
  bytesPerSample = 1,
): Uint8Array {
  if (colorType === 6 && bytesPerSample === 1) return new Uint8Array(pixels);

  const channels = CHANNELS[colorType] as number;
  // The high byte of a 16-bit sample is that sample to 8-bit precision.
  const at = (pixel: number, channel: number) =>
    pixels[(pixel * channels + channel) * bytesPerSample] as number;

  const rgba = new Uint8Array(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 0) {
      r = g = b = at(i, 0);
    } else if (colorType === 4) {
      r = g = b = at(i, 0);
      a = at(i, 1);
    } else {
      r = at(i, 0);
      g = at(i, 1);
      b = at(i, 2);
      if (colorType === 6) a = at(i, 3);
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}
