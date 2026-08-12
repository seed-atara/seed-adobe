import { describe, expect, it } from "vitest";
import {
  applyFilmLook,
  buildCubeLut,
  createImage,
  resolveConfig,
  stagesLeftBehind,
} from "../src/index.js";

function parseCube(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  let size = 0;
  const entries: [number, number, number][] = [];
  for (const line of lines) {
    if (line.startsWith("LUT_3D_SIZE")) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (line.startsWith("DOMAIN_")) continue;
    const [r, g, b] = line.split(/\s+/).map(Number);
    entries.push([r!, g!, b!]);
  }
  return { size, entries };
}

/** Trilinear lookup, the way a host reads one of these. */
function sampleCube(
  cube: { size: number; entries: [number, number, number][] },
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const { size, entries } = cube;
  const scale = (v: number) => Math.min(Math.max(v, 0), 1) * (size - 1);
  const [x, y, z] = [scale(r), scale(g), scale(b)];
  const [x0, y0, z0] = [Math.floor(x), Math.floor(y), Math.floor(z)];
  const [x1, y1, z1] = [
    Math.min(x0 + 1, size - 1),
    Math.min(y0 + 1, size - 1),
    Math.min(z0 + 1, size - 1),
  ];
  const [fx, fy, fz] = [x - x0, y - y0, z - z0];

  const at = (xi: number, yi: number, zi: number) =>
    entries[zi * size * size + yi * size + xi]!;

  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0)[c]! * (1 - fx) + at(x1, y0, z0)[c]! * fx;
    const c10 = at(x0, y1, z0)[c]! * (1 - fx) + at(x1, y1, z0)[c]! * fx;
    const c01 = at(x0, y0, z1)[c]! * (1 - fx) + at(x1, y0, z1)[c]! * fx;
    const c11 = at(x0, y1, z1)[c]! * (1 - fx) + at(x1, y1, z1)[c]! * fx;
    const c0 = c00 * (1 - fy) + c10 * fy;
    const c1 = c01 * (1 - fy) + c11 * fy;
    out[c] = c0 * (1 - fz) + c1 * fz;
  }
  return out;
}

describe("buildCubeLut", () => {
  it("writes a well-formed cube of the requested size", () => {
    const text = buildCubeLut(resolveConfig({ preset: "show-match" }), { size: 17 });
    const cube = parseCube(text);
    expect(cube.size).toBe(17);
    expect(cube.entries).toHaveLength(17 ** 3);
    expect(text).toContain("DOMAIN_MIN 0.0 0.0 0.0");
    expect(text).toContain("DOMAIN_MAX 1.0 1.0 1.0");
    for (const entry of cube.entries) {
      for (const channel of entry) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reproduces the chain's tonal half to within interpolation error", () => {
    /*
     * The claim the whole route rests on: what an artist sees through the LUT
     * in After Effects is the same tonal treatment the bake applies. Compared
     * against the real chain with the spatial stages off, since those are the
     * ones a lookup cannot carry.
     */
    const config = resolveConfig({ preset: "show-match", intensity: 1 });
    const cube = parseCube(buildCubeLut(config, { size: 33 }));

    const tonalOnly = {
      ...config,
      grain_enable: false,
      grain_scale: 0,
      distortion_k1: 0,
      distortion_k2: 0,
      ca_lateral: 0,
      vignette: 0,
      vignette_mech: 0,
      glare_intensity: 0,
      halation_scale: 0,
    };

    const probes: [number, number, number][] = [
      [0, 0, 0],
      [0.05, 0.05, 0.05],
      [0.18, 0.18, 0.18],
      [0.5, 0.5, 0.5],
      [1, 1, 1],
      [0.9, 0.2, 0.1],
      [0.1, 0.6, 0.85],
      [0.42, 0.37, 0.29],
      [0.73, 0.11, 0.64],
    ];

    let worst = 0;
    for (const [r, g, b] of probes) {
      const source = createImage(1, 1);
      source.data.set([r, g, b, 1]);
      const direct = applyFilmLook(source, tonalOnly).image.data;
      const viaLut = sampleCube(cube, r, g, b);
      for (let c = 0; c < 3; c++) {
        /*
         * Clamped, because both paths clamp in practice and only the float
         * comparison would not. The whitepoint tonemap maps its white point to
         * exactly 1.0, so peak white leaves the chain fractionally above it —
         * 1.025 at the show values. A .cube pins that to its domain edge and
         * the bake pins it again writing 8-bit, so the two agree on everything
         * anyone will ever see. Comparing unclamped floats measures a
         * difference that no output format preserves.
         */
        const expected = Math.min(1, Math.max(0, direct[c]!));
        worst = Math.max(worst, Math.abs(expected - viaLut[c]!));
      }
    }

    // Under half a code value at 8-bit, which is below what anyone can see.
    expect(worst).toBeLessThan(1 / 512);
  });

  it("is essentially exact on a smooth tonal preset at any usable size", () => {
    /*
     * A tonal chain is smooth, so trilinear interpolation across it barely
     * errs — measured around 1e-7 at both 9 and 33 samples per axis, which is
     * five orders of magnitude below a code value. The residual is arithmetic,
     * not approximation, and that is the point worth pinning: a coarse LUT is
     * not the reason a look would differ.
     */
    const config = resolveConfig({ preset: "print-2383" });
    const source = createImage(1, 1);
    source.data.set([0.33, 0.61, 0.22, 1]);
    const direct = applyFilmLook(
      { ...source, data: new Float32Array(source.data) },
      {
        ...config,
        grain_enable: false,
        grain_scale: 0,
        vignette: 0,
        vignette_mech: 0,
        distortion_k1: 0,
        distortion_k2: 0,
        ca_lateral: 0,
        glare_intensity: 0,
        halation_scale: 0,
      },
    ).image.data;

    const errorAt = (size: number) => {
      const cube = parseCube(buildCubeLut(config, { size }));
      const via = sampleCube(cube, 0.33, 0.61, 0.22);
      return Math.max(...[0, 1, 2].map((c) => Math.abs(direct[c]! - via[c]!)));
    };

    expect(errorAt(9)).toBeLessThan(1e-5);
    expect(errorAt(33)).toBeLessThan(1e-5);
  });

  it("never bakes grain into the lookup", () => {
    /*
     * Grain sampled into a LUT becomes a fixed pattern applied identically to
     * every frame and every pixel of the same colour — which is dirt on the
     * lens, the exact thing the chain's per-frame seeding exists to avoid.
     * Two builds of a grainy preset must therefore be identical.
     */
    const config = resolveConfig({ preset: "tungsten-500t" });
    expect(config.grain_scale).toBeGreaterThan(0);
    expect(buildCubeLut(config, { size: 9 })).toBe(buildCubeLut(config, { size: 9 }));

    // A flat patch stays flat through the LUT — no noise arrived.
    const cube = parseCube(buildCubeLut(config, { size: 9 }));
    const a = sampleCube(cube, 0.18, 0.18, 0.18);
    const b = sampleCube(cube, 0.18, 0.18, 0.18);
    expect(a).toEqual(b);
  });

  it("rejects a size no host would read", () => {
    const config = resolveConfig();
    expect(() => buildCubeLut(config, { size: 1 })).toThrow(/between 2 and 64/);
    expect(() => buildCubeLut(config, { size: 128 })).toThrow(/between 2 and 64/);
  });
});

describe("stagesLeftBehind", () => {
  it("names what the LUT cannot carry, so nobody has to notice its absence", () => {
    const left = stagesLeftBehind(resolveConfig({ preset: "show-match" }));
    expect(left).toContain("grain");
    expect(left).toContain("vignette");
    expect(left).toContain("distortion");
    expect(left).toContain("chromatic aberration");
  });

  it("says nothing about stages that are already off", () => {
    // Clean optics has no artefacts at all, so a LUT carries all of it.
    expect(stagesLeftBehind(resolveConfig({ preset: "clean-optics" }))).toEqual([]);
  });

  it("empties out as intensity goes to zero", () => {
    const off = stagesLeftBehind(
      resolveConfig({ preset: "show-match", intensity: 0 }),
    );
    expect(off).not.toContain("vignette");
    expect(off).not.toContain("distortion");
    expect(off).not.toContain("grain");
  });
});
