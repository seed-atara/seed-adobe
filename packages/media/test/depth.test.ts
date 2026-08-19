import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng, encodePng, readPngDepth } from "../src/index.js";

/**
 * A 16-bit RGBA PNG, built by hand.
 *
 * After Effects writes these from any project above 8 bpc, and there was no
 * fixture for one — which is exactly why the decoder rejecting them went
 * unnoticed until every capture from a 32 bpc project came back as a black
 * card in the library.
 */
function deepPng(
  width: number,
  height: number,
  sample: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(16, 8); // bit depth
  ihdr.writeUInt8(6, 9); // colour type: RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // One filter byte (0 = none) then big-endian 16-bit samples, RGBA.
  const stride = width * 4 * 2;
  const rawData = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    rawData.writeUInt8(0, rowStart);
    for (let x = 0; x < width; x += 1) {
      const values = sample(x, y);
      for (let c = 0; c < 4; c += 1) {
        rawData.writeUInt16BE(values[c] as number, rowStart + 1 + (x * 4 + c) * 2);
      }
    }
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rawData)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return c ^ 0xffffffff;
}

describe("readPngDepth", () => {
  it("reads the header without inflating the image", () => {
    expect(readPngDepth(deepPng(2, 2, () => [0, 0, 0, 65535]))).toBe(16);
    expect(readPngDepth(encodePng(2, 2, new Uint8Array(2 * 2 * 4)))).toBe(8);
  });

  it("says nothing about something that is not a PNG", () => {
    expect(readPngDepth(Buffer.from("not a png at all"))).toBeUndefined();
  });
});

describe("decodePng at 16 bits per sample", () => {
  it("decodes what it used to reject outright", () => {
    // The whole failure: undefined here meant no thumbnail, and a black card
    // indistinguishable from a genuinely black frame.
    const png = deepPng(4, 3, () => [65535, 32768, 0, 65535]);
    const image = decodePng(png);
    expect(image).toBeDefined();
    expect(image?.width).toBe(4);
    expect(image?.height).toBe(3);
  });

  it("narrows by keeping the high byte of each sample", () => {
    const image = decodePng(deepPng(1, 1, () => [65535, 32768, 256, 65535]));
    expect(Array.from(image?.rgba.slice(0, 4) ?? [])).toEqual([255, 128, 1, 255]);
  });

  it("unfilters on the byte stride, not the pixel count", () => {
    /*
     * A 16-bit pixel is twice as many bytes, so the "left" neighbour a filter
     * refers to is that much further back. Getting it wrong decodes to plausible
     * noise rather than to nothing, which is the kind of wrong that ships.
     */
    const png = deepPng(8, 2, (x, y) => [x * 8000, y * 30000, 65535 - x * 8000, 65535]);
    const image = decodePng(png);
    expect(image).toBeDefined();
    for (let x = 0; x < 8; x += 1) {
      const at = x * 4;
      expect(image?.rgba[at]).toBe((x * 8000) >> 8);
      expect(image?.rgba[at + 2]).toBe((65535 - x * 8000) >> 8);
    }
  });

  it("still reads an ordinary 8-bit PNG", () => {
    const rgba = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
    const image = decodePng(encodePng(2, 1, rgba));
    expect(Array.from(image?.rgba ?? [])).toEqual(Array.from(rgba));
  });
});
