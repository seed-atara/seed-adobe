import type { RasterImage } from "./png.js";

/**
 * Baseline JPEG preview decoder.
 *
 * This deliberately decodes only the DC coefficient of each 8x8 block, which
 * *is* that block's average colour — so the result is a correct 1/8-scale
 * image. For thumbnails that is exactly what we want, and it avoids an inverse
 * DCT and the dequantisation of 63 AC coefficients per block. AC coefficients
 * are still Huffman-decoded, because the bitstream cannot be advanced without
 * consuming them, but their values are discarded.
 *
 * Returns undefined for anything it cannot handle (progressive, arithmetic
 * coding, 12-bit, CMYK) rather than guessing — callers degrade to no thumbnail.
 */

const ZIGZAG_DC = 0;

interface HuffmanTable {
  /** code length -> { code -> value } via canonical ordering. */
  lookup: Map<number, number>;
  maxLength: number;
}

interface Component {
  id: number;
  h: number;
  v: number;
  quantTableId: number;
  dcTableId: number;
  acTableId: number;
  pred: number;
  /** DC samples at block resolution for this component. */
  samples: Int32Array;
  blocksPerLine: number;
  blocksPerColumn: number;
}

export function decodeJpegPreview(bytes: Buffer): RasterImage | undefined {
  try {
    return decode(bytes);
  } catch {
    return undefined;
  }
}

function decode(bytes: Buffer): RasterImage | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;

  const quantTables: Array<Int32Array | undefined> = [];
  const dcTables: Array<HuffmanTable | undefined> = [];
  const acTables: Array<HuffmanTable | undefined> = [];
  let frame:
    | { width: number; height: number; components: Component[]; maxH: number; maxV: number }
    | undefined;
  let restartInterval = 0;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] as number;
    offset += 2;

    // Standalone markers carry no payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (marker === 0xd9) break;

    const length = bytes.readUInt16BE(offset);
    const segment = bytes.subarray(offset + 2, offset + length);

    switch (marker) {
      case 0xdb: // DQT
        readQuantTables(segment, quantTables);
        break;
      case 0xc4: // DHT
        readHuffmanTables(segment, dcTables, acTables);
        break;
      case 0xdd: // DRI
        restartInterval = segment.readUInt16BE(0);
        break;
      case 0xc0: // SOF0 baseline
      case 0xc1: // SOF1 extended sequential
        frame = readFrame(segment);
        break;
      case 0xc2: // progressive
      case 0xc3:
      case 0xc9:
      case 0xca:
      case 0xcb:
        return undefined; // not supported; no guessing
      case 0xda: {
        // SOS — everything we need must already be in place.
        if (!frame) return undefined;
        const scanComponents = readScanHeader(segment, frame.components);
        const scanStart = offset + length;
        decodeScan(
          bytes,
          scanStart,
          frame,
          scanComponents,
          dcTables,
          acTables,
          restartInterval,
        );
        return assemble(frame, quantTables);
      }
      default:
        break;
    }
    offset += length;
  }

  return undefined;
}

function readQuantTables(
  segment: Buffer,
  tables: Array<Int32Array | undefined>,
): void {
  let i = 0;
  while (i < segment.length) {
    const spec = segment[i] as number;
    const precision = spec >> 4;
    const id = spec & 15;
    i += 1;
    const table = new Int32Array(64);
    for (let k = 0; k < 64; k += 1) {
      if (precision === 0) {
        table[k] = segment[i + k] as number;
      } else {
        table[k] = segment.readUInt16BE(i + k * 2);
      }
    }
    i += precision === 0 ? 64 : 128;
    tables[id] = table;
  }
}

function readHuffmanTables(
  segment: Buffer,
  dcTables: Array<HuffmanTable | undefined>,
  acTables: Array<HuffmanTable | undefined>,
): void {
  let i = 0;
  while (i < segment.length) {
    const spec = segment[i] as number;
    const isAc = (spec >> 4) === 1;
    const id = spec & 15;
    i += 1;

    const counts: number[] = [];
    let total = 0;
    for (let bits = 0; bits < 16; bits += 1) {
      const count = segment[i + bits] as number;
      counts.push(count);
      total += count;
    }
    i += 16;

    // Canonical Huffman: codes ascend within a length, lengths ascend overall.
    const lookup = new Map<number, number>();
    let code = 0;
    let valueIndex = 0;
    let maxLength = 0;
    for (let bits = 1; bits <= 16; bits += 1) {
      const count = counts[bits - 1] as number;
      for (let n = 0; n < count; n += 1) {
        lookup.set((bits << 16) | code, segment[i + valueIndex] as number);
        code += 1;
        valueIndex += 1;
        maxLength = bits;
      }
      code <<= 1;
    }
    i += total;

    const table: HuffmanTable = { lookup, maxLength };
    if (isAc) acTables[id] = table;
    else dcTables[id] = table;
  }
}

function readFrame(segment: Buffer) {
  const height = segment.readUInt16BE(1);
  const width = segment.readUInt16BE(3);
  const count = segment[5] as number;
  if (count !== 1 && count !== 3) return undefined; // greyscale or YCbCr only

  const components: Component[] = [];
  let maxH = 1;
  let maxV = 1;
  for (let i = 0; i < count; i += 1) {
    const base = 6 + i * 3;
    const sampling = segment[base + 1] as number;
    const h = sampling >> 4;
    const v = sampling & 15;
    maxH = Math.max(maxH, h);
    maxV = Math.max(maxV, v);
    components.push({
      id: segment[base] as number,
      h,
      v,
      quantTableId: segment[base + 2] as number,
      dcTableId: 0,
      acTableId: 0,
      pred: 0,
      samples: new Int32Array(0),
      blocksPerLine: 0,
      blocksPerColumn: 0,
    });
  }

  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  for (const component of components) {
    component.blocksPerLine = mcusPerLine * component.h;
    component.blocksPerColumn = mcusPerColumn * component.v;
    component.samples = new Int32Array(
      component.blocksPerLine * component.blocksPerColumn,
    );
  }

  return { width, height, components, maxH, maxV };
}

function readScanHeader(segment: Buffer, components: Component[]): Component[] {
  const count = segment[0] as number;
  const scan: Component[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = segment[1 + i * 2] as number;
    const tables = segment[2 + i * 2] as number;
    const component = components.find((c) => c.id === id);
    if (!component) throw new Error("scan references an unknown component");
    component.dcTableId = tables >> 4;
    component.acTableId = tables & 15;
    scan.push(component);
  }
  return scan;
}

/** Bit reader that transparently unstuffs 0xFF00 and stops at markers. */
class BitReader {
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(
    private readonly bytes: Buffer,
    public offset: number,
  ) {}

  readBit(): number {
    if (this.bitCount === 0) {
      if (this.offset >= this.bytes.length) throw new Error("out of data");
      let byte = this.bytes[this.offset] as number;
      this.offset += 1;
      if (byte === 0xff) {
        const next = this.bytes[this.offset] as number;
        if (next === 0x00) {
          this.offset += 1;
        } else {
          throw new Error("hit a marker mid-scan");
        }
      }
      this.bitBuffer = byte;
      this.bitCount = 8;
    }
    this.bitCount -= 1;
    return (this.bitBuffer >> this.bitCount) & 1;
  }

  receive(length: number): number {
    let value = 0;
    for (let i = 0; i < length; i += 1) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }

  reset(): void {
    this.bitCount = 0;
  }
}

function decodeHuffman(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  for (let length = 1; length <= table.maxLength; length += 1) {
    code = (code << 1) | reader.readBit();
    const value = table.lookup.get((length << 16) | code);
    if (value !== undefined) return value;
  }
  throw new Error("invalid Huffman code");
}

/** Sign-extends a JPEG variable-length integer. */
function extend(value: number, length: number): number {
  return value < 1 << (length - 1) ? value - (1 << length) + 1 : value;
}

function decodeScan(
  bytes: Buffer,
  start: number,
  frame: { components: Component[]; maxH: number; maxV: number; width: number; height: number },
  scanComponents: Component[],
  dcTables: Array<HuffmanTable | undefined>,
  acTables: Array<HuffmanTable | undefined>,
  restartInterval: number,
): void {
  const reader = new BitReader(bytes, start);
  const mcusPerLine = Math.ceil(frame.width / (8 * frame.maxH));
  const mcusPerColumn = Math.ceil(frame.height / (8 * frame.maxV));
  const totalMcus = mcusPerLine * mcusPerColumn;

  for (const component of scanComponents) component.pred = 0;

  let mcu = 0;
  while (mcu < totalMcus) {
    const chunk = restartInterval > 0 ? Math.min(restartInterval, totalMcus - mcu) : totalMcus - mcu;

    for (let n = 0; n < chunk; n += 1, mcu += 1) {
      const mcuRow = Math.floor(mcu / mcusPerLine);
      const mcuCol = mcu % mcusPerLine;

      for (const component of scanComponents) {
        for (let v = 0; v < component.v; v += 1) {
          for (let h = 0; h < component.h; h += 1) {
            const blockRow = mcuRow * component.v + v;
            const blockCol = mcuCol * component.h + h;
            decodeBlock(reader, component, dcTables, acTables, blockRow, blockCol);
          }
        }
      }
    }

    if (restartInterval > 0 && mcu < totalMcus) {
      // Skip the RSTn marker and reset the DC predictors.
      reader.reset();
      while (
        reader.offset + 1 < bytes.length &&
        !(bytes[reader.offset] === 0xff &&
          (bytes[reader.offset + 1] as number) >= 0xd0 &&
          (bytes[reader.offset + 1] as number) <= 0xd7)
      ) {
        reader.offset += 1;
      }
      reader.offset += 2;
      for (const component of scanComponents) component.pred = 0;
    }
  }
}

function decodeBlock(
  reader: BitReader,
  component: Component,
  dcTables: Array<HuffmanTable | undefined>,
  acTables: Array<HuffmanTable | undefined>,
  blockRow: number,
  blockCol: number,
): void {
  const dcTable = dcTables[component.dcTableId];
  const acTable = acTables[component.acTableId];
  if (!dcTable || !acTable) throw new Error("missing Huffman table");

  const dcLength = decodeHuffman(reader, dcTable);
  const diff = dcLength === 0 ? 0 : extend(reader.receive(dcLength), dcLength);
  component.pred += diff;

  if (blockRow < component.blocksPerColumn && blockCol < component.blocksPerLine) {
    component.samples[blockRow * component.blocksPerLine + blockCol] = component.pred;
  }

  // AC coefficients are consumed and thrown away — the bitstream cannot be
  // advanced without decoding them, but a 1/8-scale image does not need them.
  let k = 1;
  while (k < 64) {
    const rs = decodeHuffman(reader, acTable);
    const run = rs >> 4;
    const size = rs & 15;
    if (size === 0) {
      if (run !== 15) break; // EOB
      k += 16;
      continue;
    }
    k += run + 1;
    reader.receive(size);
  }
}

function assemble(
  frame: { width: number; height: number; components: Component[]; maxH: number; maxV: number },
  quantTables: Array<Int32Array | undefined>,
): RasterImage | undefined {
  const width = Math.max(1, Math.ceil(frame.width / 8));
  const height = Math.max(1, Math.ceil(frame.height / 8));
  const rgba = new Uint8Array(width * height * 4);

  const [y, cb, cr] = frame.components;
  if (!y) return undefined;

  const sample = (component: Component, x: number, row: number): number => {
    // Map preview pixel -> this component's block grid, honouring subsampling.
    const bx = Math.min(
      component.blocksPerLine - 1,
      Math.floor((x * component.h) / frame.maxH),
    );
    const by = Math.min(
      component.blocksPerColumn - 1,
      Math.floor((row * component.v) / frame.maxV),
    );
    const quant = quantTables[component.quantTableId];
    const dc = component.samples[by * component.blocksPerLine + bx] ?? 0;
    const scale = quant ? (quant[ZIGZAG_DC] as number) : 1;
    return clamp(Math.round((dc * scale) / 8) + 128);
  };

  for (let row = 0; row < height; row += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (row * width + x) * 4;
      const luma = sample(y, x, row);
      if (!cb || !cr) {
        rgba[i] = luma;
        rgba[i + 1] = luma;
        rgba[i + 2] = luma;
      } else {
        const b = sample(cb, x, row) - 128;
        const r = sample(cr, x, row) - 128;
        rgba[i] = clamp(luma + 1.402 * r);
        rgba[i + 1] = clamp(luma - 0.344136 * b - 0.714136 * r);
        rgba[i + 2] = clamp(luma + 1.772 * b);
      }
      rgba[i + 3] = 255;
    }
  }

  return { width, height, rgba };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}
