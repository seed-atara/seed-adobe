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
  it("takes only what the export dialog wrote, not Adobe's factory presets", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed presets "));
    const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
    await mkdir(dir, { recursive: true });

    /*
     * A factory preset: right codec, wrong format. exportAsMediaDirect answers
     * "Unable to initialize export!" to these, which is how the first attempt
     * at Premiere range export failed six ways in a row.
     */
    await writeFile(
      path.join(dir, "factory.epr"),
      `<PremiereData Version="3"><ExportXMPOptionKey>10</ExportXMPOptionKey>
       <PresetName>($$$/AME/EncoderHost/Presets/abc/PresetName=Match Source)</PresetName>
       <ExporterFileType>1211250228</ExporterFileType></PremiereData>`,
    );
    // What Premiere's own Export Settings dialog writes.
    await writeFile(
      path.join(dir, "exported.epr"),
      `<PremiereData Version="3"><PresetName>SEED H264</PresetName>
       <PresetComments>Custom</PresetComments>
       <ExporterFileType>1211250228</ExporterFileType></PremiereData>`,
    );

    const found = await findVideoPreset(home);
    expect(found?.path.endsWith("exported.epr")).toBe(true);
    expect(found?.codec).toBe("H264");
  });

  it("falls back to HEVC only when there is no H.264, and says which", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed presets "));
    made.push(home);
    const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
    await mkdir(dir, { recursive: true });
    // 1212503619 is "HEVC".
    await writeFile(
      path.join(dir, "hevc.epr"),
      `<PremiereData Version="3"><PresetName>Hive HEVC</PresetName>
       <PresetComments>Custom</PresetComments>
       <ExporterFileType>1212503619</ExporterFileType></PremiereData>`,
    );

    const only = await findVideoPreset(home);
    expect(only?.codec).toBe("HEVC");

    await writeFile(
      path.join(dir, "h264.epr"),
      `<PremiereData Version="3"><PresetName>SEED H264</PresetName>
       <PresetComments>Custom</PresetComments>
       <ExporterFileType>1211250228</ExporterFileType></PremiereData>`,
    );
    // With both present the codec that is known to work wins.
    expect((await findVideoPreset(home))?.codec).toBe("H264");
  });

  it("finds nothing rather than offering a still preset as a clip exporter", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "seed presets "));
    const dir = path.join(home, "Documents/Adobe/Premiere Pro/Presets");
    await mkdir(dir, { recursive: true });
    // 1347307296 is "PNG " — the still preset the other finder wants.
    await writeFile(
      path.join(dir, "still.epr"),
      `<PremiereData Version="3"><PresetName>PNG still</PresetName>
       <PresetComments>Custom</PresetComments>
       <ExporterFileType>1347307296</ExporterFileType></PremiereData>`,
    );
    expect(await findVideoPreset(home)).toBeUndefined();
  });
});

describe("delivery and quality are different questions", () => {
  /** What Premiere's Export Settings dialog writes, for a given codec. */
  const exported = (name: string, fileType: string) =>
    `<PremiereData Version="3"><PresetName>${name}</PresetName>
     <PresetComments>Custom</PresetComments>
     <ExporterFileType>${fileType}</ExporterFileType></PremiereData>`;

  const H264 = "1211250228";
  const QUICKTIME = "1298425421";

  async function bothPresets() {
    const home = await mkdtemp(path.join(tmpdir(), "seed intent "));
    made.push(home);
    const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "prores.epr"), exported("SEED ProRes 4444", QUICKTIME));
    await writeFile(path.join(dir, "h264.epr"), exported("SEED H264", H264));
    return home;
  }

  it("never hands a provider clip a ProRes preset", async () => {
    // Ark accepts H.264 or H.265 and refuses the rest, so ProRes here is not a
    // better reference — it is a rejected one.
    expect((await findVideoPreset(await bothPresets()))?.codec).toBe("H264");
  });

  it("prefers ProRes once quality is asked for", async () => {
    expect((await findVideoPreset(await bothPresets(), "quality"))?.codec).toBe("ProRes");
  });

  it("falls back to a delivery codec when nothing lossless was exported", async () => {
    // Most installs have no ProRes preset, and that is not a failure.
    const home = await mkdtemp(path.join(tmpdir(), "seed nolossless "));
    made.push(home);
    const dir = path.join(home, "Documents/Adobe/Adobe Media Encoder/26.0/Presets");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "h264.epr"), exported("SEED H264", H264));
    expect((await findVideoPreset(home, "quality"))?.codec).toBe("H264");
  });
});
