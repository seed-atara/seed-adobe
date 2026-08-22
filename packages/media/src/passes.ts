import type { RasterImage } from "./png.js";

/**
 * Recombining render passes — the arithmetic half of "beeble with this tool".
 *
 * Passes on their own are something to look at. What makes them worth having
 * is putting them back together: a normal map derived from measured depth, and
 * a relight computed from albedo and normals. Both are deterministic, both run
 * instantly, and neither needs a model.
 *
 * The shading model is Lambert plus Blinn-Phong, which is the same diffuse and
 * specular split Beeble computes with Cook-Torrance. Cook-Torrance is the
 * better model — microfacet distribution, geometric attenuation and a real
 * Fresnel term — and this is deliberately not pretending to be it. It is the
 * approximation that is correct enough to composite with and simple enough to
 * be obviously right.
 */

/** A direction in the space the normal map is encoded in. Need not be unit. */
export interface LightDirection {
  x: number;
  y: number;
  z: number;
}

function normalise(x: number, y: number, z: number): [number, number, number] {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length < 1e-6) return [0, 0, 1];
  return [x / length, y / length, z / length];
}

/**
 * A separable box blur over a single channel, run three times.
 *
 * Three boxes approximate a Gaussian closely enough for a high-pass, and a
 * running sum makes each pass independent of the radius. Only luminance is
 * blurred here — the caller wants a scalar field, not a picture.
 */
function blurScalar(
  field: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius < 1) return field;
  let current = field;

  for (let pass = 0; pass < 3; pass += 1) {
    for (const horizontal of [true, false]) {
      const out = new Float32Array(current.length);
      const outer = horizontal ? height : width;
      const inner = horizontal ? width : height;
      const at = (a: number, b: number) => (horizontal ? b * width + a : a * width + b);

      for (let o = 0; o < outer; o += 1) {
        let sum = 0;
        for (let i = -radius; i <= radius; i += 1) {
          sum += current[at(Math.max(0, Math.min(inner - 1, i)), o)] as number;
        }
        const span = radius * 2 + 1;
        for (let i = 0; i < inner; i += 1) {
          out[at(i, o)] = sum / span;
          sum += (current[at(Math.min(inner - 1, i + radius + 1), o)] as number) -
                 (current[at(Math.max(0, i - radius), o)] as number);
        }
      }
      current = out;
    }
  }
  return current;
}

/**
 * The fine relief in a picture, as a scalar field.
 *
 * Luminance minus its own blur. Large tonal variation is *shape* and belongs
 * to the depth map; what is left after the blur is fur, weave, pores and
 * creases — the surface. Mixing the two would have the picture's lighting
 * fight the geometry.
 */
function detailField(image: RasterImage, radius: number): Float32Array {
  const { width, height } = image;
  const luma = new Float32Array(width * height);
  for (let index = 0; index < luma.length; index += 1) {
    const at = index * 4;
    luma[index] =
      (0.2126 * (image.rgba[at] ?? 0) +
        0.7152 * (image.rgba[at + 1] ?? 0) +
        0.0722 * (image.rgba[at + 2] ?? 0)) /
      255;
  }
  const low = blurScalar(luma, width, height, radius);
  const high = new Float32Array(luma.length);
  for (let index = 0; index < luma.length; index += 1) {
    high[index] = (luma[index] as number) - (low[index] as number);
  }
  return high;
}

/**
 * A tangent-space normal map, from a depth map.
 *
 * The surface normal is the cross product of the depth surface's two
 * gradients. Sobel rather than a plain difference, because a one-pixel
 * difference on a depth map — which is nearly always slightly noisy — produces
 * a normal map that sparkles.
 *
 * `strength` scales the gradients before the cross product: it is the
 * difference between reading the depth as millimetres and reading it as
 * metres, and there is no way to know which was meant. Higher means more
 * relief.
 *
 * Encoded the way every normal map is: X in red, Y in green, Z in blue, with
 * 128 as zero, so a surface facing the camera is the familiar lavender-blue.
 */
export function normalsFromDepth(
  depth: RasterImage,
  strength = 4,
  detail?: {
    image: RasterImage;
    amount?: number;
    radius?: number;
    /**
     * Whether `image` is a normal map rather than a picture.
     *
     * Luminance cannot separate surface from paint: a striped shirt embosses
     * and a tattoo becomes a groove, because both are dark and nothing in the
     * pixel says which is geometry. A normal map carries surface *without*
     * albedo, so where one exists it is a strictly better detail source — and
     * it is read as tilt rather than high-passed as brightness.
     */
    isNormalMap?: boolean;
  },
  /**
   * Focal length as a fraction of the frame's long edge. 1.0 is roughly a
   * normal lens; smaller is wider. Only the shape term is divided by it —
   * surface detail comes from the picture and is already in screen space.
   */
  focalRatio = 1,
): RasterImage {
  const { width, height } = depth;
  const focal = Math.max(0.05, focalRatio);
  const out = new Uint8Array(width * height * 4);

  /*
   * Smoothed before differencing.
   *
   * A depth map is eight bits, so a slow gradient across a background is a
   * staircase. Differentiating a staircase gives a comb, and the perspective
   * term below multiplies it — the result was concentric contour rings across
   * every flat wall. One pixel of blur costs no real shape and removes them.
   */
  const smooth = blurScalar(
    (() => {
      const field = new Float32Array(width * height);
      for (let index = 0; index < field.length; index += 1) {
        field[index] = (depth.rgba[index * 4] ?? 0) / 255;
      }
      return field;
    })(),
    width,
    height,
    1,
  );

  const at = (x: number, y: number): number => {
    const cx = Math.max(0, Math.min(width - 1, x));
    const cy = Math.max(0, Math.min(height - 1, y));
    return smooth[cy * width + cx] as number;
  };

  /*
   * The middle of the depth range, so the perspective term is 1 for a typical
   * surface and only leans on things that are unusually near or far.
   */
  let total = 0;
  for (let index = 0; index < smooth.length; index += 1) total += smooth[index] as number;
  const middle = Math.max(0.05, total / smooth.length);

  /*
   * Depth alone gives a silhouette, not a surface.
   *
   * Monocular depth is smooth by construction: across a horse's flank it
   * barely changes, so the gradient is nothing and the normals come back flat
   * lavender with coloured edges only where the subject meets the background.
   * That is a cut-out map, not a normal map, and raising `strength` amplifies
   * zero.
   *
   * The relief is in the *picture*. Fur, weave, pores and creases are all
   * visible in luminance, so the high-frequency part of the image is added to
   * the depth gradients before the normal is formed — shape from the geometry,
   * detail from the photograph, which is how normal maps are authored from
   * stills. Only the high-frequency part: large tonal variation is shape, and
   * letting it through would have the picture's lighting argue with the depth.
   */
  const detailAmount = detail?.amount ?? 0;
  const usingNormalMap = detail?.isNormalMap === true;
  const field =
    detail && detailAmount > 0 && !usingNormalMap
      ? detailField(detail.image, Math.max(1, Math.round(detail.radius ?? 3)))
      : undefined;

  const sampleDetail = (x: number, y: number): [number, number] => {
    if (!detail || detailAmount <= 0) return [0, 0];
    const source = detail.image;
    const sx = Math.min(source.width - 1, Math.max(0, Math.round((x / width) * source.width)));
    const sy = Math.min(source.height - 1, Math.max(0, Math.round((y / height) * source.height)));

    if (usingNormalMap) {
      /*
       * Already a direction, so it is added as one rather than differenced.
       * A normal map's own tilt *is* the surface, and running a Sobel over it
       * would measure how fast the surface turns, which is curvature.
       */
      const at = (sy * source.width + sx) * 4;
      return [
        ((source.rgba[at] ?? 128) / 255) * 2 - 1,
        ((source.rgba[at + 1] ?? 128) / 255) * 2 - 1,
      ];
    }
    return [field ? (field[sy * source.width + sx] as number) : 0, 0];
  };

  /** The high-passed luminance at a point, for the Sobel below. */
  const detailAt = (x: number, y: number): number => sampleDetail(x, y)[0];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Sobel, both axes.
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));

      /*
       * Perspective, not a height field.
       *
       * Treating depth as a height map in screen space is wrong the moment
       * anything is at a different distance: the same physical tilt produces a
       * larger screen gradient up close and a smaller one far away, so a wall
       * twenty metres off reads as almost flat-on and the same wall two metres
       * off reads as steeply raked. Both are the same wall.
       *
       * The fix is to unproject before differencing. A pixel at (x, y) with
       * depth z sits at ((x - cx)·z/f, (y - cy)·z/f, z), so the normal is the
       * cross product of the two surface tangents in *view space*. What that
       * amounts to per pixel is dividing the depth gradient by z and by the
       * focal length — near surfaces stop being exaggerated, and the normals
       * can be composited against real geometry.
       *
       * The gradients are still negated: a brighter depth pixel is nearer, the
       * opposite sign to a height field, and the mistake that produces a normal
       * map lit from the wrong side.
       */
      /*
       * Bounded, and relative to the middle of the frame's own range.
       *
       * Depth Anything answers in *relative disparity*, not metres — brighter
       * is nearer, and the far field tends towards zero. Dividing by it
       * unbounded gave a fiftyfold gain on the background, which turned the
       * eight-bit staircase into contour rings and swamped the picture.
       *
       * Two to one either way is enough to stop a distant wall reading as
       * flat-on without inventing detail that is not in the data. Beyond that
       * the honest answer is that relative depth cannot say.
       */
      const z = Math.max(0.02, at(x, y));
      const perspective = Math.max(0.5, Math.min(2, middle / z)) / focal;
      let ex: number;
      let ey: number;
      if (usingNormalMap) {
        // A direction, taken as it stands.
        const [tiltX, tiltY] = sampleDetail(x, y);
        ex = -tiltX;
        ey = -tiltY;
      } else {
        // The same Sobel over the picture's fine relief.
        ex =
          detailAt(x + 1, y - 1) + 2 * detailAt(x + 1, y) + detailAt(x + 1, y + 1) -
          (detailAt(x - 1, y - 1) + 2 * detailAt(x - 1, y) + detailAt(x - 1, y + 1));
        ey =
          detailAt(x - 1, y + 1) + 2 * detailAt(x, y + 1) + detailAt(x + 1, y + 1) -
          (detailAt(x - 1, y - 1) + 2 * detailAt(x, y - 1) + detailAt(x + 1, y - 1));
      }

      const [nx, ny, nz] = normalise(
        -(dx * strength * perspective + ex * detailAmount),
        -(dy * strength * perspective + ey * detailAmount),
        1,
      );

      const index = (y * width + x) * 4;
      out[index] = Math.round((nx * 0.5 + 0.5) * 255);
      out[index + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[index + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[index + 3] = 255;
    }
  }

  return { width, height, rgba: out };
}

export interface RelightOptions {
  /** Where the key is, in normal-map space. +x right, +y down, +z at camera. */
  light?: LightDirection;
  /** Key strength. 1 is a full-power lambert term. */
  intensity?: number;
  /** How much light arrives from everywhere. Without it, shadows are black. */
  ambient?: number;
  /** Blinn-Phong highlight strength. 0 turns specular off entirely. */
  specular?: number;
  /** Highlight tightness. Higher is glossier; roughness overrides it per pixel. */
  shininess?: number;
  /** Optional per-pixel roughness. White is rough, black is glossy. */
  roughness?: RasterImage;
  /** Optional per-pixel occlusion, multiplied into the ambient term only. */
  occlusion?: RasterImage;
  /** Tint of the key light, 0–255 per channel. */
  lightColour?: [number, number, number];
}

/**
 * A relit frame, from albedo and normals.
 *
 * `out = albedo * (ambient * occlusion + N·L * intensity * lightColour)`
 * plus a Blinn-Phong specular term.
 *
 * Occlusion multiplies **only** the ambient term, which is what ambient
 * occlusion means: it describes how much of the sky a point can see, not
 * whether the key reaches it. Multiplying the key by it as well is the common
 * mistake and it produces contact shadows that survive being lit directly.
 *
 * Albedo is treated as already linear enough for this to be useful. It is not
 * strictly — an albedo pass out of a generative model is display-encoded — and
 * a proper implementation would linearise first. Doing so here would make the
 * result darker than the artist expects from a pass they can see, and this is
 * a compositing starting point rather than a renderer.
 */
export function relight(
  albedo: RasterImage,
  normals: RasterImage,
  options: RelightOptions = {},
): RasterImage {
  const light = options.light ?? { x: -0.4, y: -0.6, z: 0.7 };
  const intensity = options.intensity ?? 1;
  const ambient = options.ambient ?? 0.25;
  const specularAmount = options.specular ?? 0.2;
  const shininess = options.shininess ?? 24;
  const tint = options.lightColour ?? [255, 255, 255];

  const [lx, ly, lz] = normalise(light.x, light.y, light.z);
  // The viewer is at the camera; the half vector is between light and view.
  const [hx, hy, hz] = normalise(lx, ly, lz + 1);

  const { width, height } = albedo;
  const out = new Uint8Array(width * height * 4);

  const sample = (image: RasterImage | undefined, x: number, y: number): number => {
    if (!image) return 1;
    // Nearest, scaled: a roughness pass need not match the albedo's size.
    const sx = Math.min(image.width - 1, Math.floor((x / width) * image.width));
    const sy = Math.min(image.height - 1, Math.floor((y / height) * image.height));
    return (image.rgba[(sy * image.width + sx) * 4] ?? 255) / 255;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;

      // Normals may be a different size to the albedo; sample proportionally.
      const nxAt = Math.min(normals.width - 1, Math.floor((x / width) * normals.width));
      const nyAt = Math.min(normals.height - 1, Math.floor((y / height) * normals.height));
      const nIndex = (nyAt * normals.width + nxAt) * 4;

      const [nx, ny, nz] = normalise(
        ((normals.rgba[nIndex] ?? 128) / 255) * 2 - 1,
        ((normals.rgba[nIndex + 1] ?? 128) / 255) * 2 - 1,
        ((normals.rgba[nIndex + 2] ?? 255) / 255) * 2 - 1,
      );

      const lambert = Math.max(0, nx * lx + ny * ly + nz * lz) * intensity;
      const occluded = ambient * sample(options.occlusion, x, y);

      let highlight = 0;
      if (specularAmount > 0) {
        const rough = options.roughness ? sample(options.roughness, x, y) : 0.5;
        // Rough surfaces scatter: a wide, weak lobe. Glossy ones concentrate.
        const tightness = Math.max(2, shininess * (1 - rough) * 2);
        const facing = Math.max(0, nx * hx + ny * hy + nz * hz);
        highlight = Math.pow(facing, tightness) * specularAmount * (1 - rough);
      }

      for (let c = 0; c < 3; c += 1) {
        const base = (albedo.rgba[index + c] ?? 0) / 255;
        const keyed = lambert * ((tint[c] as number) / 255);
        const value = base * (occluded + keyed) + highlight;
        out[index + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
      }
      out[index + 3] = albedo.rgba[index + 3] ?? 255;
    }
  }

  return { width, height, rgba: out };
}

/**
 * Puts a normal map's fine relief back into a picture.
 *
 * The frequency detailer recovers detail by transferring a ratio between two
 * images and guards it with a gradient comparison — a guess at where the
 * surface is. A real normal map answers that directly, so where one exists
 * this is the better tool: the relief comes from measured geometry rather than
 * from another image that might have drifted.
 *
 * The shading term is N·L against a light that is deliberately head-on, so it
 * adds *surface* rather than a lighting direction the shot does not have.
 */
export function enhanceWithNormals(
  image: RasterImage,
  normals: RasterImage,
  amount = 0.35,
  light: LightDirection = { x: -0.5, y: -0.5, z: 0.71 },
): RasterImage {
  const { width, height } = image;
  const out = new Uint8Array(image.rgba.length);
  const strength = Math.max(0, Math.min(1, amount));

  /*
   * Relief is how much more or less light a surface catches than a flat one,
   * so the flat response is subtracted and a flat region comes back untouched.
   *
   * The light is a parameter because any single direction has a blind axis:
   * relief whose surface varies *perpendicular* to the light's in-plane
   * direction is strongly suppressed — not quite to nothing, because the normal
   * is a unit vector, but by an order of magnitude. The default is
   * the conventional top-left, which is blind to relief running along the
   * other diagonal — so being able to turn it matters on anything with a
   * regular weave.
   */
  const [lx, ly, lz] = normalise(light.x, light.y, light.z);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const nxAt = Math.min(normals.width - 1, Math.floor((x / width) * normals.width));
      const nyAt = Math.min(normals.height - 1, Math.floor((y / height) * normals.height));
      const nIndex = (nyAt * normals.width + nxAt) * 4;

      const [nx, ny, nz] = normalise(
        ((normals.rgba[nIndex] ?? 128) / 255) * 2 - 1,
        ((normals.rgba[nIndex + 1] ?? 128) / 255) * 2 - 1,
        ((normals.rgba[nIndex + 2] ?? 255) / 255) * 2 - 1,
      );
      // Against a flat surface, which catches exactly `lz`.
      const relief = nx * lx + ny * ly + nz * lz - lz;

      for (let c = 0; c < 3; c += 1) {
        const base = (image.rgba[index + c] ?? 0) / 255;
        // Multiplicative, so the relief is relative contrast and does not
        // wash out the shadows the way an additive term would.
        const value = base * (1 + relief * strength);
        out[index + c] = Math.max(0, Math.min(255, Math.round(value * 255)));
      }
      out[index + 3] = image.rgba[index + 3] ?? 255;
    }
  }

  return { width, height, rgba: out };
}
