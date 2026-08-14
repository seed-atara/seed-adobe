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

export interface VideoPreset extends StillPreset {
  /** What it actually encodes. HEVC is a fallback, not a preference. */
  codec: "H264" | "HEVC";
}

/**
 * A name a person would recognise.
 *
 * Adobe's shipped presets carry a localisation token rather than a name —
 * `($$$/AME/EncoderHost/Presets/<uuid>/PresetName=Match Source - High
 * bitrate)` — which contains the readable string at the end. Failing that, the
 * filename is what the artist sees in Premiere's own dropdown anyway.
 */
function readableName(raw: string, filename: string): string {
  const localised = /PresetName=([^)]+)\)?\s*$/.exec(raw)?.[1]?.trim();
  if (localised) return localised;
  return raw.includes("$$$") ? filename.replace(/\.epr$/i, "") : raw;
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
 * Whether this is a preset Premiere's own Export Settings dialog wrote.
 *
 * Adobe's factory presets are the same file extension and a different format:
 * they open with `<ExportXMPOptionKey>` and `<StandardFilters>` and carry a
 * localisation token where the name should be, while an exported preset opens
 * with `<PresetName>` and a `<PresetComments>`. `exportAsMediaDirect` accepts
 * only the second kind — a factory preset answers "Unable to initialize
 * export!", which is Premiere's reply to a great many objections and names
 * none of them.
 *
 * Learned the hard way: discovery found a factory "Match Source - High
 * bitrate", the panel offered the button, and every export refused.
 */
function isExportedPreset(xml: string): boolean {
  const name = /<PresetName>([^<]*)<\/PresetName>/.exec(xml)?.[1] ?? "";
  if (!name || name.startsWith("($$$") || name.includes("$$$/")) return false;
  return /<PresetComments>/.test(xml);
}

/**
 * Looks for an H.264 preset, which is what a range export needs.
 *
 * "Match Source" is preferred where it exists: it keeps the sequence's own
 * size and frame rate, which is the whole point of exporting a reference of
 * what the timeline already looks like. That preference reads the filename,
 * which is fine — it is a preference, not the identification.
 */
export async function findVideoPreset(
  home = process.env.USERPROFILE ?? process.env.HOME ?? "",
): Promise<VideoPreset | undefined> {
  if (!home) return undefined;

  const h264: VideoPreset[] = [];
  const hevc: VideoPreset[] = [];

  for (const relative of PRESET_ROOTS) {
    for (const file of await eprFilesUnder(path.join(home, relative))) {
      let xml: string;
      try {
        xml = await readFile(file, "utf8");
      } catch {
        continue;
      }
      // Only what the export dialog wrote; a factory preset cannot be used.
      if (!isExportedPreset(xml)) continue;

      const code = exporterFourCc(xml)?.trim().toUpperCase();
      const base = path.basename(file);
      const entry: VideoPreset = {
        path: file,
        name: readableName(presetName(xml, base), base),
        codec: code === "H264" ? "H264" : "HEVC",
      };
      if (code === "H264") h264.push(entry);
      else if (code === "HEVC") hevc.push(entry);
    }
  }

  /*
   * H.264 first, always. HEVC is offered only when there is no H.264 preset at
   * all, and the caller is told which it got: it is the same .mp4 container and
   * no provider has been shown to accept the codec, so it is a fallback worth
   * trying rather than one worth trusting.
   *
   * Within a codec the order is by name rather than by whatever the directory
   * walk happened to return — the same install should not pick a different
   * preset on different days. "Placeholder" goes last: Premiere writes one of
   * those itself, and it is nobody's idea of an export setting.
   */
  const rank = (entries: VideoPreset[]) =>
    [...entries].sort((a, b) => {
      const auto = (entry: VideoPreset) =>
        /placeholder/i.test(entry.name) || /placeholder/i.test(path.basename(entry.path));
      if (auto(a) !== auto(b)) return auto(a) ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

  return rank(h264)[0] ?? rank(hevc)[0];
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
