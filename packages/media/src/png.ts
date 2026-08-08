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

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Decoder for 8-bit non-interlaced PNGs (greyscale, RGB, and either with
 * alpha) — the shapes our own encoder and typical provider output produce.
 * Anything else (16-bit, palette, interlaced) returns undefined rather than
 * guessing, and callers degrade gracefully.
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

  if (bitDepth !== 8 || interlace !== 0 || channels === undefined) {
    return undefined;
  }

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

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return undefined;

  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw.readUInt8(y * (stride + 1));
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev =
      y === 0 ? undefined : pixels.subarray((y - 1) * stride, y * stride);
    unfilter(filter, line, out, prev, channels);
  }

  return { width, height, rgba: toRgba(pixels, width, height, colorType) };
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

function toRgba(
  pixels: Buffer,
  width: number,
  height: number,
  colorType: number,
): Uint8Array {
  if (colorType === 6) return new Uint8Array(pixels);

  const rgba = new Uint8Array(width * height * 4);
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    if (colorType === 0) {
      r = g = b = pixels[i] as number;
    } else if (colorType === 4) {
      r = g = b = pixels[i * 2] as number;
      a = pixels[i * 2 + 1] as number;
    } else {
      r = pixels[i * 3] as number;
      g = pixels[i * 3 + 1] as number;
      b = pixels[i * 3 + 2] as number;
    }
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return rgba;
}
