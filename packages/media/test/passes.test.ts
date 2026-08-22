import { describe, expect, it } from "vitest";
import {
  enhanceWithNormals,
  normalsFromDepth,
  relight,
  type RasterImage,
} from "../src/index.js";

function grey(width: number, height: number, level: (x: number, y: number) => number): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const value = Math.max(0, Math.min(255, Math.round(level(x, y))));
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function pixel(image: RasterImage, x: number, y: number): [number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.rgba[at] ?? 0, image.rgba[at + 1] ?? 0, image.rgba[at + 2] ?? 0];
}

describe("normalsFromDepth", () => {
  it("gives flat lavender-blue for flat depth", () => {
    // The signature of a normal map: a surface facing the camera is
    // (128, 128, 255). If a flat plate does not produce it, nothing else here
    // means anything.
    const flat = normalsFromDepth(grey(16, 16, () => 120));
    const [r, g, b] = pixel(flat, 8, 8);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
    expect(b).toBeGreaterThan(250);
  });

  it("tilts red where depth changes across the frame", () => {
    // A ramp getting nearer to the right tilts the surface left-right, which
    // lives in the red channel.
    const ramp = normalsFromDepth(grey(32, 32, (x) => x * 6));
    const [r] = pixel(ramp, 16, 16);
    expect(Math.abs(r - 128)).toBeGreaterThan(10);
  });

  it("tilts green where depth changes down the frame", () => {
    const ramp = normalsFromDepth(grey(32, 32, (_x, y) => y * 6));
    const [, g] = pixel(ramp, 16, 16);
    expect(Math.abs(g - 128)).toBeGreaterThan(10);
  });

  it("leans the right way for a surface that nears the camera", () => {
    /*
     * The sign that is easy to get backwards, and produces a normal map that
     * lights from the wrong side. Brighter depth is nearer, so a surface
     * getting nearer to the right faces left — negative x, below 128.
     */
    const ramp = normalsFromDepth(grey(32, 32, (x) => x * 6));
    const [r] = pixel(ramp, 16, 16);
    expect(r).toBeLessThan(128);
  });

  it("responds to strength", () => {
    const gentle = normalsFromDepth(grey(32, 32, (x) => x * 3), 1);
    const steep = normalsFromDepth(grey(32, 32, (x) => x * 3), 8);
    expect(Math.abs((pixel(steep, 16, 16)[0]) - 128)).toBeGreaterThan(
      Math.abs((pixel(gentle, 16, 16)[0]) - 128),
    );
  });
});

describe("relight", () => {
  const albedo = grey(16, 16, () => 200);
  const flatNormals = normalsFromDepth(grey(16, 16, () => 100));

  it("lights a surface facing the light more than one facing away", () => {
    const towards = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      ambient: 0,
      specular: 0,
    });
    const across = relight(albedo, flatNormals, {
      light: { x: 1, y: 0, z: 0 },
      ambient: 0,
      specular: 0,
    });
    expect(pixel(towards, 8, 8)[0]).toBeGreaterThan(pixel(across, 8, 8)[0]);
  });

  it("never goes fully black once there is ambient", () => {
    const lit = relight(albedo, flatNormals, {
      light: { x: 0, y: -1, z: 0 },
      ambient: 0.3,
      specular: 0,
    });
    expect(pixel(lit, 8, 8)[0]).toBeGreaterThan(10);
  });

  it("tints with the light", () => {
    const warm = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      lightColour: [255, 180, 120],
      ambient: 0,
      specular: 0,
    });
    const [r, , b] = pixel(warm, 8, 8);
    expect(r).toBeGreaterThan(b);
  });

  it("occludes the ambient term and not the key", () => {
    /*
     * What ambient occlusion means: how much sky a point can see, not whether
     * the key reaches it. Multiplying the key by it too is the common mistake,
     * and it produces contact shadows that survive being lit directly.
     */
    const dark = grey(16, 16, () => 0);
    const keyOnly = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      ambient: 0,
      specular: 0,
      occlusion: dark,
    });
    const noOcclusion = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      ambient: 0,
      specular: 0,
    });
    expect(pixel(keyOnly, 8, 8)[0]).toBe(pixel(noOcclusion, 8, 8)[0]);

    const ambientOnly = relight(albedo, flatNormals, {
      light: { x: 0, y: -1, z: 0 },
      ambient: 0.5,
      specular: 0,
      occlusion: dark,
    });
    expect(pixel(ambientOnly, 8, 8)[0]).toBeLessThan(10);
  });

  it("puts a highlight on a glossy surface and not a rough one", () => {
    const glossy = grey(16, 16, () => 0);
    const rough = grey(16, 16, () => 255);
    const shiny = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      ambient: 0,
      specular: 0.8,
      roughness: glossy,
    });
    const matte = relight(albedo, flatNormals, {
      light: { x: 0, y: 0, z: 1 },
      ambient: 0,
      specular: 0.8,
      roughness: rough,
    });
    expect(pixel(shiny, 8, 8)[0]).toBeGreaterThan(pixel(matte, 8, 8)[0]);
  });

  it("keeps alpha", () => {
    const withAlpha = grey(16, 16, () => 200);
    for (let at = 3; at < withAlpha.rgba.length; at += 4) withAlpha.rgba[at] = 90;
    const lit = relight(withAlpha, flatNormals, {});
    for (let at = 3; at < lit.rgba.length; at += 4) expect(lit.rgba[at]).toBe(90);
  });

  it("takes passes at a different size to the albedo", () => {
    const small = normalsFromDepth(grey(8, 8, () => 100));
    const lit = relight(albedo, small, { ambient: 0.5, specular: 0 });
    expect(lit.width).toBe(16);
    expect(lit.height).toBe(16);
  });
});

describe("enhanceWithNormals", () => {
  it("leaves a flat surface alone", () => {
    // Flat normals carry no relief, so a flat region must come back untouched
    // rather than uniformly lifted.
    const image = grey(16, 16, () => 120);
    const flat = normalsFromDepth(grey(16, 16, () => 80));
    const enhanced = enhanceWithNormals(image, flat, 0.5);
    expect(Math.abs(pixel(enhanced, 8, 8)[0] - 120)).toBeLessThanOrEqual(1);
  });

  it("adds relief where the surface turns", () => {
    const image = grey(32, 32, () => 120);
    const ridged = normalsFromDepth(grey(32, 32, (x) => (x % 4) * 60));
    const enhanced = enhanceWithNormals(image, ridged, 0.6);

    let spread = 0;
    for (let x = 4; x < 28; x += 1) {
      spread = Math.max(spread, Math.abs(pixel(enhanced, x, 16)[0] - 120));
    }
    expect(spread).toBeGreaterThan(2);
  });

  it("has a null, and the light can be turned off it", () => {
    /*
     * Any single light has a blind axis: relief whose surface varies
     * perpendicular to the light's in-plane direction catches the same light
     * everywhere and vanishes.
     *
     * Worth a test rather than a comment, because the way out is to turn the
     * light and nobody will think of that unless the behaviour is stated —
     * and because I first wrote this assertion the wrong way round, assuming
     * relief *along* the light was the blind case.
     */
    const image = grey(32, 32, () => 120);
    const diagonal = normalsFromDepth(grey(32, 32, (x, y) => ((x + y) % 4) * 60));

    const spreadWith = (options: { x: number; y: number; z: number }) => {
      const enhanced = enhanceWithNormals(image, diagonal, 0.6, options);
      let spread = 0;
      for (let x = 4; x < 28; x += 1) {
        spread = Math.max(spread, Math.abs(pixel(enhanced, x, 16)[0] - 120));
      }
      return spread;
    };

    const along = spreadWith({ x: -0.5, y: -0.5, z: 0.71 });
    const across = spreadWith({ x: 0.7, y: -0.7, z: 0.14 });

    expect(along).toBeGreaterThan(2);
    /*
     * Strongly suppressed rather than exactly zero, and the difference is the
     * normal being a unit vector: N·L along the blind axis is constant in the
     * numerator but still divided by a length that grows with the relief. An
     * order of magnitude is the real behaviour, and asserting zero would be
     * asserting something that is not true.
     */
    expect(across).toBeLessThan(along / 5);
  });

  it("does nothing at zero", () => {
    const image = grey(16, 16, (x) => x * 8);
    const bumpy = normalsFromDepth(grey(16, 16, (x) => x * 10));
    const enhanced = enhanceWithNormals(image, bumpy, 0);
    expect(Array.from(enhanced.rgba)).toEqual(Array.from(image.rgba));
  });
});
