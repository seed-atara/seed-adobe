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

/**
 * Where Adobe ships its own presets.
 *
 * Searched as well as the per-user folders because a user preset for H.264 is
 * not something most editors ever make — they pick "Match Source" from a
 * dropdown, which lives here. Verified on this install: the folders are named
 * `<exporter>_<filetype>` in hex, so `4E49434B_48323634` is "NICK"/"H264".
 */
const SYSTEM_PRESET_GLOBS = [
  "C:/Program Files/Adobe",
  "/Applications",
];

export interface StillPreset {
  path: string;
  name: string;
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
 * Whether a preset writes H.264 video.
 *
 * The four-character code is the whole answer here, and unlike the still case
 * there is no usable fallback: Adobe's shipped presets carry a localisation
 * token as their name (`$$$/AME/EncoderHost/Presets/9bb57b43-...`), so nothing
 * readable says "H.264" anywhere in the file. Measured against a real install.
 *
 * HEVC is deliberately not accepted. It is also an .mp4 and it is what this
 * machine happens to have a shelf of, but no provider has been shown to accept
 * one, and a reference that fails after upload is worse than one we declined
 * to make.
 */
function looksLikeH264(xml: string): boolean {
  return exporterFourCc(xml)?.trim().toUpperCase() === "H264";
}

/**
 * Adobe's own preset folders, found by walking Program Files shallowly.
 *
 * The version is in the folder name ("Adobe Media Encoder 2026"), so it is
 * discovered rather than assumed — an install a year newer would otherwise
 * silently stop being found.
 */
async function systemPresetRoots(bases: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const base of bases) {
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^Adobe (Media Encoder|Premiere Pro)/i.test(entry)) continue;
      roots.push(path.join(base, entry, "MediaIO", "systempresets"));
    }
  }
  return roots;
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
  /** Injectable so a test can look at a fake install rather than this one. */
  systemBases: string[] = SYSTEM_PRESET_GLOBS,
): Promise<StillPreset | undefined> {
  const roots = [
    ...(home ? PRESET_ROOTS.map((relative) => path.join(home, relative)) : []),
    ...(await systemPresetRoots(systemBases)),
  ];

  const candidates: { path: string; name: string; preferred: boolean }[] = [];
  for (const root of roots) {
    for (const file of await eprFilesUnder(root)) {
      let xml: string;
      try {
        xml = await readFile(file, "utf8");
      } catch {
        continue;
      }
      if (!looksLikeH264(xml)) continue;
      const base = path.basename(file);
      candidates.push({
        path: file,
        name: readableName(presetName(xml, base), base),
        preferred: /match source/i.test(base),
      });
    }
    const best = candidates.find((entry) => entry.preferred) ?? candidates[0];
    if (best) return { path: best.path, name: best.name };
  }
  return undefined;
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
