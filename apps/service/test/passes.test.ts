import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { encodePng } from "@seed-ae/media";
import { readJson, startTestService, type TestService } from "./helpers.js";

let service: TestService;

beforeAll(async () => {
  service = await startTestService();
});

afterAll(async () => {
  await service.close();
});

async function post(pathname: string, body: unknown): Promise<Response> {
  return service.call(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A frame with real structure, adopted into the library. */
async function adopt(
  name: string,
  paint: (x: number, y: number, size: number) => [number, number, number],
  size = 192,
): Promise<string> {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const [r, g, b] = paint(x, y, size);
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = 255;
    }
  }
  const dir = await mkdtemp(nodePath.join(tmpdir(), "seed-pass-"));
  const file = nodePath.join(dir, `${name}.png`);
  await writeFile(file, encodePng(size, size, rgba));
  const response = await post("/v1/assets/adopt", { path: file });
  expect(response.status).toBe(201);
  return (await readJson(response)).asset.id as string;
}

/** Blocky midtone texture — edges to measure, no gradient across the frame. */
const textured = (x: number, y: number): [number, number, number] => {
  const block = ((x >> 4) + (y >> 4)) % 2 === 0 ? 118 : 152;
  return [block, block, block];
};

describe("the pass catalogue", () => {
  it("hands over the prompts rather than hiding them", async () => {
    /*
     * The prompts are the product for the generated passes, and an artist
     * should be able to read what was asked on their behalf.
     */
    const { presets } = (await readJson(
      await service.call("/v1/passes/presets"),
    )) as { presets: Array<{ kind: string; prompt: string; usableAsIdentity: boolean }> };

    const albedo = presets.find((preset) => preset.kind === "albedo");
    expect(albedo?.prompt).toContain("ALBEDO");
    expect(albedo?.usableAsIdentity).toBe(true);

    // Every pass must pin the geometry, or it is not a pass of *this* shot.
    for (const preset of presets) {
      expect(preset.prompt.toLowerCase()).toContain("identical framing");
    }
  });
});

describe("camera transfer", () => {
  it("measures a reference and reports what it could not measure", async () => {
    const reference = await adopt("reference", textured);
    const result = (await readJson(
      await post("/v1/passes/camera-transfer", { referenceAssetId: reference }),
    )) as {
      settings: Record<string, number>;
      skipped: string[];
      reference: { grain: { confidence: number }; halation: { confidence: number } };
      note: string;
    };

    // Midtone texture supports a grain reading.
    expect(result.reference.grain.confidence).toBeGreaterThan(0);
    // Nothing is clipped, so halation genuinely cannot be answered — and that
    // has to be reported rather than returned as a confident zero.
    expect(result.reference.halation.confidence).toBe(0);
    expect(result.skipped.some((entry) => entry.includes("halation"))).toBe(true);
    expect(result.settings.halation_scale).toBeUndefined();
  });

  it("returns a difference when a target is given", async () => {
    /*
     * A shot that already has grain does not want the reference's grain on
     * top of its own, so with both shots the answer is what to *add*.
     */
    let state = 5;
    const noisy = (x: number, y: number): [number, number, number] => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const jitter = (state / 0x7fffffff - 0.5) * 36;
      const [base] = textured(x, y);
      const value = Math.max(0, Math.min(255, Math.round(base + jitter)));
      return [value, value, value];
    };

    const clean = await adopt("clean", textured);
    const grainy = await adopt("grainy", noisy);

    const withoutTarget = (await readJson(
      await post("/v1/passes/camera-transfer", { referenceAssetId: grainy }),
    )) as { settings: Record<string, number> };
    const againstGrainy = (await readJson(
      await post("/v1/passes/camera-transfer", {
        referenceAssetId: grainy,
        targetAssetId: grainy,
      }),
    )) as { settings: Record<string, number> };

    expect(withoutTarget.settings.grain_scale).toBeGreaterThan(0);
    // Matching a shot to itself asks for nothing to be added.
    expect(againstGrainy.settings.grain_scale).toBeLessThan(
      withoutTarget.settings.grain_scale as number,
    );

    const againstClean = (await readJson(
      await post("/v1/passes/camera-transfer", {
        referenceAssetId: grainy,
        targetAssetId: clean,
      }),
    )) as { settings: Record<string, number> };
    expect(againstClean.settings.grain_scale).toBeGreaterThan(
      againstGrainy.settings.grain_scale as number,
    );
  });
});

describe("relighting", () => {
  it("lights an albedo by its normals, without generating anything", async () => {
    const albedo = await adopt("albedo", () => [190, 175, 160]);
    // A sphere's normals, so there is a surface to catch the light.
    const normals = await adopt("normals", (x, y, size) => {
      const dx = (x - size / 2) / (size / 2);
      const dy = (y - size / 2) / (size / 2);
      const outside = dx * dx + dy * dy;
      const dz = outside < 1 ? Math.sqrt(1 - outside) : 1;
      const [nx, ny, nz] = outside < 1 ? [dx, dy, dz] : [0, 0, 1];
      return [
        Math.round((nx * 0.5 + 0.5) * 255),
        Math.round((ny * 0.5 + 0.5) * 255),
        Math.round((nz * 0.5 + 0.5) * 255),
      ];
    });

    const response = await post("/v1/passes/relight", {
      albedoAssetId: albedo,
      normalAssetId: normals,
      light: { x: -1, y: 0, z: 0.4 },
      ambient: 0.1,
      specular: 0,
    });
    expect(response.status).toBe(201);
    const { asset } = (await readJson(response)) as { asset: { id: string; kind: string } };
    expect(asset.kind).toBe("image");
  });

  it("refuses a shot with no still to work from", async () => {
    const response = await post("/v1/passes/relight", {
      albedoAssetId: "ast_missing",
      normalAssetId: "ast_missing",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
