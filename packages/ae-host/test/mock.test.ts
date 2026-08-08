import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockAeHostAdapter, encodePng, readPngSize } from "../src/index.js";

const tempRoot = await mkdtemp(path.join(tmpdir(), "seed ae host "));

afterAll(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

describe("png encoder", () => {
  it("writes a decodable header with the requested dimensions", () => {
    const png = encodePng(4, 3, new Uint8Array(4 * 3 * 4).fill(128));
    expect(readPngSize(png)).toEqual({ width: 4, height: 3 });
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("rejects a mismatched pixel buffer", () => {
    expect(() => encodePng(4, 3, new Uint8Array(10))).toThrow(/RGBA bytes/);
  });
});

describe("MockAeHostAdapter", () => {
  it("reports a comp context", async () => {
    const host = new MockAeHostAdapter({ outputDir: tempRoot });
    const context = await host.getActiveContext();
    expect(context.compName).toBe("HERO_SHOT_v003");
    expect(context.width).toBe(1920);
    expect(context.fps).toBe(24);
  });

  it("captures a real PNG matching the comp dimensions", async () => {
    const dir = path.join(tempRoot, "capture one");
    const host = new MockAeHostAdapter({
      outputDir: dir,
      context: { width: 320, height: 180, frameNumber: 12 },
    });

    const captured = await host.captureCurrentFrame();
    expect(captured.mimeType).toBe("image/png");
    expect(captured.width).toBe(320);
    expect(readPngSize(await readFile(captured.path))).toEqual({
      width: 320,
      height: 180,
    });
    expect(captured.sourceContext.frameNumber).toBe(12);
    expect(path.basename(captured.path)).toContain("f00012");
  });

  it("never overwrites a previous capture", async () => {
    const dir = path.join(tempRoot, "capture two");
    const host = new MockAeHostAdapter({
      outputDir: dir,
      context: { width: 32, height: 18 },
    });
    const first = await host.captureCurrentFrame();
    const second = await host.captureCurrentFrame();
    expect(first.path).not.toBe(second.path);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it("produces different pixels as the playhead moves", async () => {
    const dir = path.join(tempRoot, "capture three");
    const host = new MockAeHostAdapter({
      outputDir: dir,
      context: { width: 32, height: 18, frameNumber: 0 },
    });
    const atZero = await readFile((await host.captureCurrentFrame()).path);
    host.setContext({ frameNumber: 60 });
    const atSixty = await readFile((await host.captureCurrentFrame()).path);
    expect(atZero.equals(atSixty)).toBe(false);
  });

  it("declines formats it cannot render instead of faking them", async () => {
    const host = new MockAeHostAdapter({ outputDir: tempRoot });
    await expect(host.captureCurrentFrame({ format: "exr" })).rejects.toThrow(
      /PNG only/,
    );
  });

  it("records imports and playhead insertions", async () => {
    const host = new MockAeHostAdapter({ outputDir: tempRoot });
    const imported = await host.importMedia("C:/Client Work/plate.png");
    expect(imported.name).toBe("plate.png");
    await host.insertAtPlayhead(imported.projectItemId as string);
    expect(host.importedMedia).toHaveLength(1);
    expect(host.insertions[0]?.projectItemId).toBe(imported.projectItemId);
  });
});
