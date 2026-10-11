import { describe, expect, it } from "vitest";
import { readMp4Size } from "../src/mp4.js";

/**
 * Reading a frame size out of a container, and the two ways it quietly failed.
 *
 * Both cases here are the same real file: the first GYG element matted to
 * ProRes 4444, 537 MB, written by ffmpeg with its `moov` atom at the very end.
 * It registered in the library with no width, no height and no duration, and
 * nothing complained — which is the only reason it survived long enough to be
 * found.
 */

/** A `stsd` box holding one visual sample entry of the given codec and size. */
function stsd(codec: string, width: number, height: number): Buffer {
  const box = Buffer.alloc(52);
  box.write("stsd", 0, "ascii");
  // version+flags, entryCount — the reader skips 12 from the type.
  box.writeUInt32BE(1, 8);
  box.write(codec, 16, "ascii"); // entry + 4
  box.writeUInt16BE(width, 44); // entry + 32
  box.writeUInt16BE(height, 46);
  return box;
}

/** A movie header, so duration comes back too. */
function mvhd(seconds: number): Buffer {
  const box = Buffer.alloc(32);
  box.write("mvhd", 0, "ascii");
  box.writeUInt32BE(600, 16); // timescale
  box.writeUInt32BE(seconds * 600, 20); // duration
  return box;
}

describe("reading a frame size", () => {
  it("reads the delivery codecs it always could", () => {
    const file = Buffer.concat([mvhd(10), stsd("avc1", 1920, 1080)]);
    expect(readMp4Size(file)).toEqual({ width: 1920, height: 1080, durationSeconds: 10 });
  });

  it("reads ProRes 4444, which is what this pipeline actually writes", () => {
    /*
     * `ap4h`. Missing from the codec list, so every master SEED produced
     * itself was the one kind of file it could not measure, while every clip
     * downloaded from a provider read fine.
     */
    const file = Buffer.concat([mvhd(10.042), stsd("ap4h", 1664, 1248)]);
    expect(readMp4Size(file)).toMatchObject({ width: 1664, height: 1248 });
  });

  it("keeps looking past a stsd that is really pixel data", () => {
    /*
     * ffmpeg puts `moov` after `mdat` in a .mov, so the search crosses the
     * whole picture before reaching the real sample description. Four bytes
     * of ProRes can spell `stsd`; taking the first match meant one unlucky
     * frame cost the file its dimensions.
     */
    const decoy = Buffer.alloc(200);
    decoy.write("stsd", 64, "ascii");
    decoy.write("\u0000\u0000\u0000\u0000", 80, "ascii"); // not a visual codec

    const file = Buffer.concat([decoy, mvhd(10), stsd("ap4h", 1664, 1248)]);
    expect(readMp4Size(file)).toMatchObject({ width: 1664, height: 1248 });
  });

  it("says nothing rather than guessing when there is no sample description", () => {
    expect(readMp4Size(Buffer.alloc(4096))).toBeUndefined();
  });

  it("does not read past the end of a truncated box", () => {
    // A probe that caught the start of stsd but not the size fields.
    const file = stsd("ap4h", 1664, 1248).subarray(0, 30);
    expect(readMp4Size(file)).toBeUndefined();
  });
});
