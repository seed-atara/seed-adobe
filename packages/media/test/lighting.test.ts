import { describe, expect, it } from "vitest";
import {
  applyLighting,
  averageLighting,
  estimateLighting,
  relight,
  type LightingSolution,
  type RasterImage,
} from "../src/index.js";

/**
 * A sphere's worth of normals, so the solve has the whole hemisphere to work
 * with. A flat card cannot pin lighting down and should not be used to claim
 * the maths works.
 */
function normalSphere(size = 96): RasterImage {
  const rgba = new Uint8Array(size * size * 4);
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const dx = (x - size / 2) / radius;
      const dy = (y - size / 2) / radius;
      const outside = dx * dx + dy * dy;
      const dz = outside < 1 ? Math.sqrt(1 - outside) : 1;
      const [nx, ny, nz] = outside < 1 ? [dx, dy, dz] : [0, 0, 1];
      rgba[at] = Math.round((nx * 0.5 + 0.5) * 255);
      rgba[at + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgba[at + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      rgba[at + 3] = 255;
    }
  }
  return { width: size, height: size, rgba };
}

function flat(size: number, r: number, g: number, b: number): RasterImage {
  const rgba = new Uint8Array(size * size * 4);
  for (let at = 0; at < rgba.length; at += 4) {
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    rgba[at + 3] = 255;
  }
  return { width: size, height: size, rgba };
}

function meanAbs(a: RasterImage, b: RasterImage): number {
  let sum = 0;
  let count = 0;
  for (let at = 0; at < a.rgba.length; at += 4) {
    for (let c = 0; c < 3; c += 1) {
      sum += Math.abs((a.rgba[at + c] ?? 0) - (b.rgba[at + c] ?? 0));
      count += 1;
    }
  }
  return sum / count;
}

describe("estimateLighting", () => {
  const normals = normalSphere();
  const albedo = flat(96, 180, 170, 160);

  it("recovers a light it never saw, and reproduces the shot", () => {
    /*
     * The test that matters. Light a sphere from a known direction, hand the
     * solver only the result, its normals and its albedo, and ask it to
     * reproduce the shot. If the recovered lighting cannot repaint the image
     * it was solved from, nothing downstream means anything.
     */
    const lit = relight(albedo, normals, {
      light: { x: -0.6, y: -0.4, z: 0.7 },
      ambient: 0.2,
      specular: 0,
    });

    const solution = estimateLighting(lit, normals, albedo);
    expect(solution.samples).toBeGreaterThan(1000);

    const repainted = applyLighting(albedo, normals, solution, 1);
    expect(meanAbs(repainted, lit)).toBeLessThan(12);
  });

  it("tells a light from the left from one from the right", () => {
    const fromLeft = relight(albedo, normals, {
      light: { x: -1, y: 0, z: 0.3 },
      ambient: 0.15,
      specular: 0,
    });
    const fromRight = relight(albedo, normals, {
      light: { x: 1, y: 0, z: 0.3 },
      ambient: 0.15,
      specular: 0,
    });

    // Y3 is the x term: it must change sign with the key.
    const left = estimateLighting(fromLeft, normals, albedo);
    const right = estimateLighting(fromRight, normals, albedo);
    expect(Math.sign(left.coefficients[0][3] as number)).not.toBe(
      Math.sign(right.coefficients[0][3] as number),
    );
  });

  it("carries the colour of the light", () => {
    const warm = relight(albedo, normals, {
      light: { x: 0, y: 0, z: 1 },
      lightColour: [255, 150, 90],
      ambient: 0.1,
      specular: 0,
    });
    const solution = estimateLighting(warm, normals, albedo);
    // The flat term is overall level per channel; red must exceed blue.
    expect(solution.coefficients[0][0] as number).toBeGreaterThan(
      solution.coefficients[2][0] as number,
    );
  });

  it("refuses to invent an answer from too few samples", () => {
    const tiny: RasterImage = { width: 2, height: 2, rgba: new Uint8Array(16) };
    const solution = estimateLighting(tiny, tiny, tiny);
    expect(solution.samples).toBeLessThan(32);
  });
});

describe("applyLighting", () => {
  const normals = normalSphere();
  const albedo = flat(96, 180, 170, 160);

  it("transfers one shot's light onto another shot", () => {
    /*
     * The thing Beeble cannot do: it relights one image to an HDRI you author.
     * Here the lighting is *measured off a reference shot* and applied to a
     * different one, which is what "make these two cut together" actually
     * asks for.
     */
    const reference = relight(albedo, normals, {
      light: { x: -0.8, y: -0.2, z: 0.5 },
      lightColour: [255, 200, 150],
      ambient: 0.2,
      specular: 0,
    });
    const solution = estimateLighting(reference, normals, albedo);

    // A different subject colour, the same geometry.
    const otherAlbedo = flat(96, 120, 130, 150);
    const transferred = applyLighting(otherAlbedo, normals, solution, 1);

    // It must be warmer on the left, like the reference, and not flat.
    const at = (x: number, y: number, c: number) =>
      transferred.rgba[(y * 96 + x) * 4 + c] ?? 0;
    expect(at(30, 48, 0)).toBeGreaterThan(at(66, 48, 0));
    expect(at(30, 48, 0)).toBeGreaterThan(at(30, 48, 2));
  });

  it("does nothing at zero", () => {
    const solution = estimateLighting(
      relight(albedo, normals, { ambient: 0.3, specular: 0 }),
      normals,
      albedo,
    );
    const untouched = applyLighting(albedo, normals, solution, 0);
    expect(meanAbs(untouched, albedo)).toBeLessThan(1);
  });

  it("hands back the albedo when there is no solution", () => {
    const empty = { coefficients: [[], [], []], residual: 0, samples: 0 } as never;
    const out = applyLighting(albedo, normals, empty as LightingSolution, 1);
    expect(Array.from(out.rgba)).toEqual(Array.from(albedo.rgba));
  });
});

describe("averageLighting", () => {
  const normals = normalSphere();
  const albedo = flat(96, 180, 170, 160);

  it("steadies a solve that trembles frame to frame", () => {
    /*
     * Per-frame estimation is exact per frame and the frames disagree, which
     * reads as the lamp shaking. Averaging across the shot is the other thing
     * a tool with a timeline can do that a tool with one image cannot.
     */
    const solutions = [-0.05, 0, 0.05].map((jitter) =>
      estimateLighting(
        relight(albedo, normals, {
          light: { x: -0.6 + jitter, y: -0.4, z: 0.7 },
          ambient: 0.2,
          specular: 0,
        }),
        normals,
        albedo,
      ),
    );

    const averaged = averageLighting(solutions);
    const middle = solutions[1] as LightingSolution;

    // The average must sit between the extremes, not outside them.
    const low = Math.min(
      solutions[0]?.coefficients[0][3] as number,
      solutions[2]?.coefficients[0][3] as number,
    );
    const high = Math.max(
      solutions[0]?.coefficients[0][3] as number,
      solutions[2]?.coefficients[0][3] as number,
    );
    const value = averaged.coefficients[0][3] as number;
    expect(value).toBeGreaterThanOrEqual(low);
    expect(value).toBeLessThanOrEqual(high);
    expect(Math.abs(value - (middle.coefficients[0][3] as number))).toBeLessThan(0.1);
  });

  it("survives being given nothing", () => {
    expect(averageLighting([]).samples).toBe(0);
  });
});
