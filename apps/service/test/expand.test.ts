import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { encodePng } from "@seed-ae/media";
import { readJson, startTestService } from "./helpers.js";

/**
 * Expanding a shot into another aspect, over HTTP.
 *
 * The mosaic itself is tested in `@seed-ae/media`. What is tested here is the
 * route around it: that frames come back out of the library as pixels, that
 * where the original sits changes the answer, and that the plate and the mask
 * are registered as ordinary assets rather than left in memory.
 */

const WIDTH = 160;
const HEIGHT = 120;

/**
 * A frame of a panning shot.
 *
 * Value noise rather than a checkerboard or stripes: a periodic pattern
 * matches equally well at every multiple of its period, so a tracker either
 * finds the wrong offset or refuses — and either way the test would be
 * measuring the pattern rather than the code.
 */
function panFrame(shift: number): Buffer {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const wx = x + shift;
      let h = Math.imul(wx | 0, 374_761_393) ^ Math.imul(y | 0, 668_265_263);
      h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
      const value = ((h ^ (h >>> 16)) >>> 0) % 256;
      const at = (y * WIDTH + x) * 4;
      rgba[at] = value;
      rgba[at + 1] = (value * 3) % 256;
      rgba[at + 2] = (value * 7) % 256;
      rgba[at + 3] = 255;
    }
  }
  return encodePng(WIDTH, HEIGHT, rgba);
}

/** Registers a panning shot in the library and returns the frame ids. */
async function shot(
  service: Awaited<ReturnType<typeof startTestService>>,
  shifts: number[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, shift] of shifts.entries()) {
    const file = path.join(
      service.deps.workspace.originalsDir,
      `pan_${String(index).padStart(3, "0")}.png`,
    );
    await writeFile(file, panFrame(shift));
    const response = await service.call("/v1/ae/register-capture", {
      method: "POST",
      body: JSON.stringify({
        path: file,
        width: WIDTH,
        height: HEIGHT,
        context: { compName: "pan", frameNumber: index },
      }),
    });
    const body = await readJson(response);
    if (!body.asset) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
    ids.push(body.asset.id);
  }
  return ids;
}

describe("expanding a shot", () => {
  it("recovers from a pan, and says where the original should sit", async () => {
    const service = await startTestService();
    try {
      // Travelling right: the pixels off the right edge of frame one were
      // photographed later, and the ones off the left never were.
      const frames = await shot(service, [0, 24, 48, 72, 96, 120]);

      const centred = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          body: JSON.stringify({ frameAssetIds: frames, aspect: "21:9" }),
        }),
      );

      /*
       * A camera panning right never sees what is off the left edge, so a
       * centred expansion can only ever recover one of its two margins. That
       * is the honest ceiling, not a shortfall — and it is exactly what the
       * placement control exists to move.
       */
      expect(centred.coverage.edges.right).toBeGreaterThan(0.5);
      expect(centred.coverage.edges.left).toBeLessThan(0.1);

      const pinned = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          body: JSON.stringify({
            frameAssetIds: frames,
            aspect: "21:9",
            // Hard against the left, so the whole expansion is to the right —
            // which is the only direction this shot photographed.
            sourceRect: { x: 0, y: 0, width: (WIDTH / HEIGHT) / (21 / 9), height: 1 },
          }),
        }),
      );

      /*
       * The whole argument for the control, in two numbers. Centred, the shot
       * can only ever fill one of its two margins — half. Pinned left, the
       * entire expansion lies in the direction the camera actually travelled,
       * and the footage pays for all of it.
       */
      expect(centred.coverage.coverage).toBeCloseTo(0.5, 1);
      expect(pinned.coverage.coverage).toBeGreaterThan(0.95);
      expect(typeof pinned.verdict).toBe("string");
    } finally {
      await service.close();
    }
    // Two full measurements over six frames; the default 5s is not enough.
  }, 30_000);

  it("registers the plate and the mask as assets, wider than the source", async () => {
    const service = await startTestService();
    try {
      const frames = await shot(service, [0, 10, 20, 30, 40]);
      const recovered = await readJson(
        await service.call("/v1/expand/recover", {
          method: "POST",
          body: JSON.stringify({ frameAssetIds: frames, aspect: "21:9" }),
        }),
      );

      expect(recovered.plate.width).toBeGreaterThan(WIDTH);
      expect(recovered.plate.height).toBe(HEIGHT);
      // Same canvas: the mask says which pixels of *this* plate were invented,
      // so a different size would make it meaningless as a mask.
      expect(recovered.residual.width).toBe(recovered.plate.width);
      expect(recovered.residual.height).toBe(recovered.plate.height);

      // Both are ordinary library assets, and can be attached to a generation
      // like anything else.
      for (const id of [recovered.plate.id, recovered.residual.id]) {
        const { asset } = await readJson(await service.call(`/v1/assets/${id}`));
        expect(asset.status).toBe("ready");
      }
    } finally {
      await service.close();
    }
  }, 30_000);

  it("reports a locked-off shot as nothing recoverable rather than failing", async () => {
    /*
     * A shot that never moves is a valid input with an honest answer: none of
     * the new area was ever photographed. Refusing it would push the artist
     * towards guessing, when the number is the thing worth telling them.
     */
    const service = await startTestService();
    try {
      const frames = await shot(service, [0, 0, 0, 0]);
      const measured = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          body: JSON.stringify({ frameAssetIds: frames, aspect: "16:9" }),
        }),
      );

      expect(measured.coverage.coverage).toBe(0);
      expect(measured.coverage.travel).toEqual({ x: 0, y: 0 });
      expect(measured.verdict).toMatch(/never moves/i);
    } finally {
      await service.close();
    }
  });

  it("refuses an aspect it cannot read, before doing any work", async () => {
    const service = await startTestService();
    try {
      const frames = await shot(service, [0, 8]);
      const response = await service.call("/v1/expand/coverage", {
        method: "POST",
        body: JSON.stringify({ frameAssetIds: frames, aspect: "widescreen" }),
      });
      expect(response.status).toBe(400);
    } finally {
      await service.close();
    }
  });
});

describe("a shot already at the target aspect", () => {
  /*
   * The real report this came from: a square clip sitting pillarboxed in a
   * 1920x1080 comp, sampled from the comp, asked to become 16:9. Coverage was
   * "0%" — 0 of 0 pixels — and the verdict blamed the camera, which sent the
   * artist looking for a problem in their footage that was not there.
   */
  it("says there is nothing to expand into, rather than blaming the camera", async () => {
    const service = await startTestService();
    try {
      const ids = await shot(service, [0, 6, 12, 18]);
      const body = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          // The frames are 4:3 already; this is the shape they are.
          body: JSON.stringify({ frameAssetIds: ids, aspect: "4:3" }),
        }),
      );

      expect(body.coverage.newArea).toBe(0);
      expect(body.verdict).toMatch(/already at this aspect/i);
      expect(body.verdict).not.toMatch(/camera moved/i);
    } finally {
      await service.close();
    }
  }, 30_000);
});

describe("a clip with bars baked into the delivery", () => {
  /*
   * Straight from the field: a 1:1 shot delivered as HD, so the file really is
   * 16:9 and every honest answer about it was useless. Expanding to 16:9 added
   * nothing, and the static bars — nearly half the frame — pulled the tracker
   * towards reporting no motion at all.
   */
  it("finds the picture, tracks it, and says what it took off", async () => {
    const service = await startTestService();
    try {
      const ids: string[] = [];
      const BAR = 40;
      for (const [index, shift] of [0, 7, 14, 21, 28].entries()) {
        const rgba = new Uint8Array(WIDTH * HEIGHT * 4);
        for (let y = 0; y < HEIGHT; y += 1) {
          for (let x = 0; x < WIDTH; x += 1) {
            const at = (y * WIDTH + x) * 4;
            rgba[at + 3] = 255;
            if (x < BAR || x >= WIDTH - BAR) continue; // the pillarbox
            for (let c = 0; c < 3; c += 1) {
              let h =
                Math.imul(x + shift, 374761393) ^
                Math.imul(y, 668265263) ^
                Math.imul(c + 1, 2246822519);
              h = Math.imul(h ^ (h >>> 13), 1274126177);
              rgba[at + c] = 30 + (((h ^ (h >>> 16)) >>> 0) % 200);
            }
          }
        }
        const file = path.join(
          service.deps.workspace.originalsDir,
          `boxed_${String(index).padStart(3, "0")}.png`,
        );
        await writeFile(file, encodePng(WIDTH, HEIGHT, rgba));
        const body = await readJson(
          await service.call("/v1/ae/register-capture", {
            method: "POST",
            body: JSON.stringify({
              path: file,
              width: WIDTH,
              height: HEIGHT,
              context: { compName: "boxed", frameNumber: index },
            }),
          }),
        );
        ids.push(body.asset.id);
      }

      const body = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          body: JSON.stringify({ frameAssetIds: ids, aspect: "16:9" }),
        }),
      );

      // The bars came off, and the artist is told so.
      expect(body.cropped).toMatchObject({ x: BAR, width: WIDTH - BAR * 2 });
      expect(body.croppedNote).toMatch(/pillarbox/i);

      /*
       * And now the request means something: the picture is 4:3-ish rather than
       * 16:9, so expanding to 16:9 genuinely adds area — where before it added
       * none and reported a truthful, useless zero.
       */
      expect(body.coverage.newArea).toBeGreaterThan(0);
      expect(body.verdict).not.toMatch(/already at this aspect/i);
    } finally {
      await service.close();
    }
  }, 30_000);
});

describe("the prompt that goes with a plate", () => {
  it("names the margins and forbids changing the middle", async () => {
    const service = await startTestService();
    try {
      const ids = await shot(service, [0, 6]);
      const body = await readJson(
        await service.call("/v1/expand/coverage", {
          method: "POST",
          body: JSON.stringify({ frameAssetIds: ids, aspect: "21:9" }),
        }),
      );

      // Specific about where, because "make this wider" re-imagines the frame.
      expect(body.suggestedPrompt).toMatch(/to the left/);
      expect(body.suggestedPrompt).toMatch(/to the right/);
      expect(body.suggestedPrompt).toMatch(/must not change/i);
      // And explicit that the margins are background, not a new composition.
      expect(body.suggestedPrompt).toMatch(/not add new subjects/i);
    } finally {
      await service.close();
    }
  }, 30_000);
});
