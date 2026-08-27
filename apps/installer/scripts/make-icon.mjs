/**
 * Draws the companion's icon.
 *
 * Generated rather than checked in as a binary, for two reasons: a PNG in git
 * is a blob nobody can review or adjust, and electron-builder derives both the
 * Windows .ico and the macOS icon from this one file at package time — so it
 * has to exist before a build, on a machine that may have no image tooling at
 * all. Twenty lines of zlib beats a dependency.
 *
 * The mark is the panel's own chrome: Adobe-navy ground, teal aperture. Not a
 * logo, and not pretending to be one — a placeholder that is recognisably SEED
 * rather than the default Electron atom, which is what ships otherwise.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 512;
const NAVY = [0x14, 0x1e, 0x4a];
const TEAL = [0x2f, 0xa8, 0xa0];
const PALE = [0xe8, 0xec, 0xf6];

/** Rounded-square coverage, so the mark is not a hard rectangle. */
function inRoundedSquare(x, y, inset, radius) {
  const lo = inset;
  const hi = SIZE - 1 - inset;
  if (x < lo || x > hi || y < lo || y > hi) return false;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

const rows = [];
for (let y = 0; y < SIZE; y += 1) {
  // Filter byte 0 (None) at the start of every scanline.
  const row = Buffer.alloc(SIZE * 4 + 1);
  row[0] = 0;
  for (let x = 0; x < SIZE; x += 1) {
    const at = 1 + x * 4;
    if (!inRoundedSquare(x, y, 24, 96)) {
      row[at + 3] = 0; // transparent outside the tile
      continue;
    }

    // A ring, read as an aperture: the panel looking at a frame.
    const dx = x - SIZE / 2;
    const dy = y - SIZE / 2;
    const r = Math.hypot(dx, dy);
    let colour = NAVY;
    if (r > 108 && r < 156) colour = TEAL;
    else if (r <= 108) colour = PALE;

    row[at] = colour[0];
    row[at + 1] = colour[1];
    row[at + 2] = colour[2];
    row[at + 3] = 255;
  }
  rows.push(row);
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
// 10-12 stay zero: deflate, adaptive filtering, no interlace.

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, "../build");
mkdirSync(buildDir, { recursive: true });

const icon = path.join(buildDir, "icon.png");
writeFileSync(icon, png);
console.log(`wrote ${icon} (${SIZE}x${SIZE}, ${png.length} bytes)`);

// The tray wants a small, monochrome-friendly version. Same drawing, scaled by
// sampling — good enough for a 32px glyph and keeps this file dependency-free.
const TRAY = 32;
const trayRows = [];
for (let y = 0; y < TRAY; y += 1) {
  const row = Buffer.alloc(TRAY * 4 + 1);
  for (let x = 0; x < TRAY; x += 1) {
    const sx = Math.floor((x * SIZE) / TRAY);
    const sy = Math.floor((y * SIZE) / TRAY);
    const source = rows[sy];
    const at = 1 + x * 4;
    const from = 1 + sx * 4;
    row[at] = source[from];
    row[at + 1] = source[from + 1];
    row[at + 2] = source[from + 2];
    row[at + 3] = source[from + 3];
  }
  trayRows.push(row);
}

const trayIhdr = Buffer.alloc(13);
trayIhdr.writeUInt32BE(TRAY, 0);
trayIhdr.writeUInt32BE(TRAY, 4);
trayIhdr[8] = 8;
trayIhdr[9] = 6;

const trayPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", trayIhdr),
  chunk("IDAT", deflateSync(Buffer.concat(trayRows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const tray = path.join(buildDir, "trayTemplate.png");
writeFileSync(tray, trayPng);
console.log(`wrote ${tray} (${TRAY}x${TRAY}, ${trayPng.length} bytes)`);
