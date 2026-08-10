import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Finds a Premiere still-image export preset.
 *
 * Premiere has no documented single-frame export; the documented route is
 * `exportAsMediaDirect` with an `.epr` preset. Presets are per-install and
 * per-user so none can be shipped, and requiring the artist to find a file
 * path is a poor first-run experience — so the service looks for one.
 *
 * `.epr` files are plain XML, so a preset is identified by *reading* it rather
 * than by trusting its filename: someone's "png_export.epr" may well be H.264.
 */

const PRESET_ROOTS = [
  "Documents/Adobe/Adobe Media Encoder",
  "Documents/Adobe/Premiere Pro",
];

export interface StillPreset {
  path: string;
  name: string;
}

/** Reads the preset name out of the XML, for logging. */
function presetName(xml: string, fallback: string): string {
  return /<PresetName>([^<]*)<\/PresetName>/.exec(xml)?.[1]?.trim() || fallback;
}

/**
 * A still preset writes a single image. PNG is what SEED wants — the pipeline
 * decodes PNG natively for thumbnails — so that is what we look for, in the
 * exporter fields rather than anywhere the word might incidentally appear.
 */
/**
 * `ExporterFileType` is a four-character code stored as a 32-bit integer —
 * 1347307296 is 0x504E4720, "PNG ". Decoding it identifies the output format
 * from the file itself, with no reliance on what anyone named the preset.
 */
function exporterFourCc(xml: string): string | undefined {
  const raw = /<ExporterFileType>(\d+)<\/ExporterFileType>/.exec(xml)?.[1];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return undefined;

  let code = "";
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (value >>> shift) & 0xff;
    if (byte < 32 || byte > 126) return undefined;
    code += String.fromCharCode(byte);
  }
  return code;
}

function looksLikeStillPng(xml: string): boolean {
  // The four-character code is the real answer when it is present.
  const fourCc = exporterFourCc(xml);
  if (fourCc) return fourCc.trim().toUpperCase() === "PNG";

  const name = /<PresetName>([^<]*)<\/PresetName>/.exec(xml)?.[1] ?? "";
  const exporter = /<ExporterName>([^<]*)<\/ExporterName>/.exec(xml)?.[1] ?? "";
  if (/png/i.test(exporter)) return true;
  // A name is only trusted when it says both what and how — "PNG still", not
  // merely "png_something", which may well be an H.264 preset.
  return /png/i.test(name) && /still|frame/i.test(name);
}

async function eprFilesUnder(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let isDirectory = false;
      try {
        isDirectory = (await stat(full)).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) await walk(full, depth + 1);
      else if (entry.toLowerCase().endsWith(".epr")) found.push(full);
    }
  }

  await walk(root, 0);
  return found;
}

/**
 * Looks for a PNG still preset in the usual per-user locations. Returns
 * undefined rather than guessing when nothing matches.
 */
export async function findStillPreset(
  home = process.env.USERPROFILE ?? process.env.HOME ?? "",
): Promise<StillPreset | undefined> {
  if (!home) return undefined;

  for (const relative of PRESET_ROOTS) {
    const root = path.join(home, relative);
    for (const file of await eprFilesUnder(root)) {
      let xml: string;
      try {
        xml = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (looksLikeStillPng(xml)) {
        return { path: file, name: presetName(xml, path.basename(file)) };
      }
    }
  }
  return undefined;
}
