import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStillPreset } from "../src/pproPresets.js";

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fakeHome(presets: Array<{ file: string; xml: string }>) {
  const home = await mkdtemp(path.join(tmpdir(), "seed ppro "));
  made.push(home);
  const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
  await mkdir(dir, { recursive: true });
  for (const { file, xml } of presets) await writeFile(path.join(dir, file), xml);
  return home;
}

const preset = (name: string, exporter: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3">` +
  `<PresetName>${name}</PresetName><ExporterName>${exporter}</ExporterName>` +
  `</PremiereData>`;

describe("findStillPreset", () => {
  it("finds a PNG preset by reading it, not by its filename", async () => {
    const home = await fakeHome([
      { file: "a.epr", xml: preset("Hive_HEVC_50MBs", "HEVC") },
      { file: "b.epr", xml: preset("Whatever", "PNG") },
    ]);
    const found = await findStillPreset(home);
    expect(found?.name).toBe("Whatever");
    expect(found?.path.endsWith("b.epr")).toBe(true);
  });

  it("is not fooled by a video preset with png in its name", async () => {
    // Someone's "png_lookalike" is H.264; the exporter is what counts.
    const home = await fakeHome([
      { file: "a.epr", xml: preset("png_lookalike", "H.264") },
    ]);
    expect(await findStillPreset(home)).toBeUndefined();
  });

  it("returns undefined rather than guessing when nothing matches", async () => {
    const home = await fakeHome([
      { file: "a.epr", xml: preset("Hive_HEVC_800MBs", "HEVC") },
    ]);
    expect(await findStillPreset(home)).toBeUndefined();
  });

  it("survives a home directory with no preset folders at all", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed empty "));
    made.push(home);
    expect(await findStillPreset(home)).toBeUndefined();
  });
});
