import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findStillPreset, findVideoPreset } from "../src/pproPresets.js";

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

describe("ExporterFileType four-character code", () => {
  const withFourCc = (name: string, fileType: number) =>
    `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3">` +
    `<PresetName>${name}</PresetName><ExporterName></ExporterName>` +
    `<ExporterFileType>${fileType}</ExporterFileType></PremiereData>`;

  it("identifies PNG from the code, whatever the preset is called", async () => {
    // 1347307296 === 0x504E4720 === "PNG " — as written by Premiere itself.
    const home = await fakeHome([
      { file: "a.epr", xml: withFourCc("anything at all", 1347307296) },
    ]);
    const found = await findStillPreset(home);
    expect(found?.name).toBe("anything at all");
  });

  it("rejects a video preset even when its name promises PNG stills", async () => {
    // 1212503619 is the HEVC exporter on a real install.
    const home = await fakeHome([
      { file: "a.epr", xml: withFourCc("PNG still (honest)", 1212503619) },
    ]);
    expect(await findStillPreset(home)).toBeUndefined();
  });
});

describe("finding an H.264 preset", () => {
  it("identifies H.264 by its four-character code, not its name", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed presets "));
    const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
    await mkdir(dir, { recursive: true });

    /*
     * Adobe's shipped presets carry a localisation token instead of a name, so
     * nothing readable in the file says "H.264" — the code is the only signal.
     * 1211250228 is 0x48323634, "H264", read off a real install.
     */
    await writeFile(
      path.join(dir, "anonymous.epr"),
      `<PresetName>($$$/AME/EncoderHost/Presets/abc/PresetName=Match Source - High bitrate)</PresetName>
       <ExporterFileType>1211250228</ExporterFileType>`,
    );
    // HEVC is also an .mp4 and is not accepted: no provider has been shown to
    // take one, and a reference that fails after upload is worse than none.
    await writeFile(
      path.join(dir, "tempting.epr"),
      `<PresetName>H.264 High Quality</PresetName>
       <ExporterFileType>1213027651</ExporterFileType>`,
    );

    const found = await findVideoPreset(home, []);
    expect(found?.path.endsWith("anonymous.epr")).toBe(true);
    // The readable half of the token, not the token itself.
    expect(found?.name).toBe("Match Source - High bitrate");
  });

  it("finds nothing rather than offering a still preset as a clip exporter", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed presets "));
    const dir = path.join(home, "Documents/Adobe/Premiere Pro/Presets");
    await mkdir(dir, { recursive: true });
    // 1347307296 is "PNG " — the still preset the other finder wants.
    await writeFile(
      path.join(dir, "still.epr"),
      `<PresetName>PNG still</PresetName><ExporterFileType>1347307296</ExporterFileType>`,
    );
    expect(await findVideoPreset(home, [])).toBeUndefined();
  });
});
