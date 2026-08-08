import { describe, expect, it } from "vitest";
import { encodePng, sniffMimeType } from "../src/index.js";

describe("sniffMimeType", () => {
  it("identifies our own PNG output", () => {
    const png = encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(9));
    expect(sniffMimeType(png)).toBe("image/png");
  });

  it("identifies a JPEG, which is what Ark actually returns", () => {
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(16),
    ]);
    expect(sniffMimeType(jpeg)).toBe("image/jpeg");
  });

  it("identifies WebP, GIF and MP4 containers", () => {
    const webp = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "ascii"),
    ]);
    expect(sniffMimeType(webp)).toBe("image/webp");

    const gif = Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(8)]);
    expect(sniffMimeType(gif)).toBe("image/gif");

    const mp4 = Buffer.concat([
      Buffer.alloc(4),
      Buffer.from("ftyp", "ascii"),
      Buffer.from("isom", "ascii"),
    ]);
    expect(sniffMimeType(mp4)).toBe("video/mp4");
  });

  it("returns undefined rather than guessing for unknown bytes", () => {
    expect(sniffMimeType(Buffer.from("just some plain text here"))).toBeUndefined();
    expect(sniffMimeType(Buffer.alloc(4))).toBeUndefined();
  });
});
