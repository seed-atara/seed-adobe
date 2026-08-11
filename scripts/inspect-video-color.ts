/**
 * Reads the colour signalling out of an H.264 file's own bitstream.
 *
 * The MP4 container's `colr` box is one place this can be stated and the
 * encoder's SPS is the other. A file can be silent in the container and
 * explicit in the bitstream, and decoders read the bitstream — so a question
 * about what colour space a video is in is only answered here.
 *
 *   npx tsx scripts/inspect-video-color.ts <file.mp4>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const PRIMARIES: Record<number, string> = {
  1: "BT.709", 2: "unspecified", 5: "BT.601 625", 6: "BT.601 525", 9: "BT.2020", 12: "Display P3",
};
const TRANSFER: Record<number, string> = {
  1: "BT.709", 2: "unspecified", 4: "gamma 2.2", 6: "BT.601", 8: "linear",
  13: "sRGB", 16: "PQ", 18: "HLG",
};
const MATRIX: Record<number, string> = {
  0: "RGB (identity)", 1: "BT.709", 2: "unspecified", 5: "BT.601", 6: "BT.601", 9: "BT.2020",
};

/** Reads the bit-oriented syntax the SPS is written in. */
class Bits {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}

  bit(): number {
    const byte = this.bytes[this.at >> 3] ?? 0;
    const value = (byte >> (7 - (this.at & 7))) & 1;
    this.at += 1;
    return value;
  }

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) value = (value << 1) | this.bit();
    return value;
  }

  /** Unsigned Exp-Golomb. */
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0 && zeros < 32) zeros += 1;
    return zeros === 0 ? 0 : (1 << zeros) - 1 + this.bits(zeros);
  }

  /** Signed Exp-Golomb. */
  se(): number {
    const value = this.ue();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

/** Removes the emulation-prevention bytes the bitstream is escaped with. */
function unescape(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i += 1) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i] as number);
  }
  return Uint8Array.from(out);
}

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/inspect-video-color.ts <file.mp4>");
  process.exit(2);
}

const b = readFileSync(file);
console.log(path.basename(file) + "  " + Math.round(b.length / 1024) + "KB\n");

// --- container ------------------------------------------------------------
let container = "no colr box — the container says nothing";
for (let i = 0; i + 16 < b.length; i += 1) {
  if (b.toString("ascii", i, i + 4) !== "colr") continue;
  const kind = b.toString("ascii", i + 4, i + 8);
  if (kind !== "nclx" && kind !== "nclc") continue;
  const p = b.readUInt16BE(i + 8);
  const t = b.readUInt16BE(i + 10);
  const m = b.readUInt16BE(i + 12);
  container =
    `colr(${kind}): ${PRIMARIES[p] ?? p} / ${TRANSFER[t] ?? t} / ${MATRIX[m] ?? m}` +
    (kind === "nclx" ? `, ${(b[i + 14]! & 0x80) !== 0 ? "full" : "limited"} range` : "");
  break;
}
console.log("container:  " + container);

// --- bitstream ------------------------------------------------------------
const avcc = b.indexOf(Buffer.from("avcC", "ascii"));
if (avcc < 0) {
  console.log("bitstream:  no avcC box; not H.264 in the expected layout");
  process.exit(0);
}

const spsCount = (b[avcc + 9] as number) & 0x1f;
if (spsCount === 0) {
  console.log("bitstream:  no SPS in avcC");
  process.exit(0);
}

const spsLength = b.readUInt16BE(avcc + 10);
const sps = unescape(b.subarray(avcc + 12 + 1, avcc + 12 + spsLength)); // skip NAL header

const bits = new Bits(sps);
const profile = bits.bits(8);
bits.bits(8); // constraint flags
const level = bits.bits(8);
bits.ue(); // sps id

let chromaFormat = 1;
let bitDepth = 8;
if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
  chromaFormat = bits.ue();
  if (chromaFormat === 3) bits.bit();
  bitDepth = bits.ue() + 8;
  bits.ue(); // chroma bit depth
  bits.bit(); // transform bypass
  if (bits.bit() === 1) {
    // Scaling lists, which have to be walked past rather than read.
    const lists = chromaFormat !== 3 ? 8 : 12;
    for (let i = 0; i < lists; i += 1) {
      if (bits.bit() === 1) {
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j += 1) {
          if (next !== 0) next = (last + bits.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
}

bits.ue(); // log2_max_frame_num_minus4
const pocType = bits.ue();
if (pocType === 0) bits.ue();
else if (pocType === 1) {
  bits.bit();
  bits.se();
  bits.se();
  const cycle = bits.ue();
  for (let i = 0; i < cycle; i += 1) bits.se();
}
bits.ue(); // max_num_ref_frames
bits.bit(); // gaps_in_frame_num
bits.ue(); // width in mbs
bits.ue(); // height in map units
const frameMbsOnly = bits.bit();
if (frameMbsOnly === 0) bits.bit();
bits.bit(); // direct_8x8
if (bits.bit() === 1) {
  bits.ue(); bits.ue(); bits.ue(); bits.ue(); // cropping
}

const CHROMA = ["monochrome", "4:2:0", "4:2:2", "4:4:4"];
console.log(
  `bitstream:  profile ${profile}, level ${level / 10}, ` +
  `${CHROMA[chromaFormat] ?? chromaFormat} ${bitDepth}-bit`,
);

if (bits.bit() === 0) {
  console.log("            no VUI — the encoder stated nothing about colour");
} else {
  if (bits.bit() === 1) {
    const idc = bits.bits(8);
    if (idc === 255) { bits.bits(16); bits.bits(16); }
  }
  if (bits.bit() === 1) bits.bit(); // overscan

  if (bits.bit() === 1) {
    bits.bits(3); // video_format
    const fullRange = bits.bit() === 1;
    console.log(`            video_full_range_flag = ${fullRange ? "1 (FULL)" : "0 (LIMITED)"}`);
    if (bits.bit() === 1) {
      const p = bits.bits(8);
      const t = bits.bits(8);
      const m = bits.bits(8);
      console.log(`            primaries ${p} (${PRIMARIES[p] ?? "?"})`);
      console.log(`            transfer  ${t} (${TRANSFER[t] ?? "?"})`);
      console.log(`            matrix    ${m} (${MATRIX[m] ?? "?"})`);
    } else {
      console.log("            no colour_description — primaries/transfer/matrix unstated");
    }
  } else {
    console.log("            no video_signal_type — range and colour both unstated");
  }
}
