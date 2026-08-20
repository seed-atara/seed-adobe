#include "detail.h"

#include <algorithm>
#include <cmath>

namespace seed {
namespace {

inline float SmoothStep(float edge0, float edge1, float x) {
  if (edge1 <= edge0) return x < edge0 ? 0.0f : 1.0f;
  const float t = Clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3.0f - 2.0f * t);
}

/*
 * The source, resampled to the target's frame.
 *
 * A layer parameter is not guaranteed to arrive at the same size as the layer
 * the effect sits on — a different comp, a scaled precomp, a reduced-resolution
 * preview. Sampling here rather than refusing means the effect works on the
 * arrangement people actually build, and the identity case costs one copy.
 */
Image MatchSize(const Image& src, int width, int height) {
  if (src.width == width && src.height == height) return src;

  Image out(width, height);
  const float sx = src.width > 1 ? float(src.width - 1) / std::max(1, width - 1) : 0.0f;
  const float sy = src.height > 1 ? float(src.height - 1) / std::max(1, height - 1) : 0.0f;
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      float* dst = out.At(x, y);
      for (int c = 0; c < 4; ++c) {
        dst[c] = SampleChannelBilinear(src, x * sx, y * sy, c);
      }
    }
  }
  return out;
}

/** sRGB-encoded to scene-linear, in place, alpha untouched. */
void ToLinear(Image& image) {
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    image.data[i] = SrgbToLinear(image.data[i]);
    image.data[i + 1] = SrgbToLinear(image.data[i + 1]);
    image.data[i + 2] = SrgbToLinear(image.data[i + 2]);
  }
}

void ToDisplay(Image& image) {
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    image.data[i] = LinearToSrgb(image.data[i]);
    image.data[i + 1] = LinearToSrgb(image.data[i + 1]);
    image.data[i + 2] = LinearToSrgb(image.data[i + 2]);
  }
}

inline float LumaAt(const Image& image, int x, int y) {
  const float* px = image.At(x, y);
  return Luminance(px[0], px[1], px[2]);
}

}  // namespace

/*
 * How much the two images agree about where things are.
 *
 * Compared as *gradient direction*, not value. The plate and the render are
 * graded differently and may differ in exposure by any amount, so comparing
 * brightness would report disagreement everywhere. The direction a local edge
 * runs in is invariant to all of that — normalise both gradients and take
 * their cosine similarity, and what is left is purely a question of whether
 * the same feature is in the same place.
 *
 * Where *neither* has structure there is nothing to disagree about, so those
 * areas agree by default — otherwise flat regions would compare noise against
 * noise and the guard would flicker. But where one has an edge and the other
 * does not, that is disagreement rather than absence of evidence: it is
 * precisely what drift looks like.
 */
Image StructureAgreement(const Image& blurredSource, const Image& blurredTarget,
                         float tolerance) {
  const int w = blurredSource.width;
  const int h = blurredSource.height;
  Image out(w, h);

  // Below this a gradient is noise rather than an edge, in linear light.
  const float kFloor = 1e-3f;

  ParallelBands(h, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      const int yUp = std::max(0, y - 1);
      const int yDn = std::min(h - 1, y + 1);
      for (int x = 0; x < w; ++x) {
        const int xL = std::max(0, x - 1);
        const int xR = std::min(w - 1, x + 1);

        const float sx = LumaAt(blurredSource, xR, y) - LumaAt(blurredSource, xL, y);
        const float sy = LumaAt(blurredSource, x, yDn) - LumaAt(blurredSource, x, yUp);
        const float tx = LumaAt(blurredTarget, xR, y) - LumaAt(blurredTarget, xL, y);
        const float ty = LumaAt(blurredTarget, x, yDn) - LumaAt(blurredTarget, x, yUp);

        const float ms = std::sqrt(sx * sx + sy * sy);
        const float mt = std::sqrt(tx * tx + ty * ty);

        const float strongest = std::max(ms, mt);
        const float weakest = std::min(ms, mt);

        float agree = 1.0f;
        if (strongest > kFloor) {
          // Cosine similarity of the two gradients. Negative means the edge
          // runs the other way, which is disagreement, not partial agreement.
          const float cosine =
              weakest > kFloor * 0.1f
                  ? std::max(0.0f, (sx * tx + sy * ty) / (ms * mt))
                  : 0.0f;

          /*
           * One image having an edge the other lacks is *disagreement*, not
           * absence of evidence — it is exactly what drift looks like, and
           * treating it as "nothing to dispute" let the guard pass detail
           * straight onto a feature that had moved.
           *
           * The threshold is generous because the render is legitimately
           * allowed to be lower in contrast than the plate; only a gradient
           * that is essentially one-sided counts against it.
           */
          const float shared = SmoothStep(0.05f, 0.35f, weakest / strongest);
          agree = cosine * shared;
        }

        // Tolerance moves the point at which disagreement starts to cost
        // detail; at 1 almost nothing is refused, at 0 only near-perfect
        // agreement survives.
        const float t = Clamp01(tolerance);
        agree = SmoothStep(0.0f, 1.0f - t * 0.9f, agree);

        float* px = out.At(x, y);
        px[0] = px[1] = px[2] = agree;
        px[3] = 1.0f;
      }
    }
  });

  return out;
}

void ApplyFrequencyDetail(Image& target, const Image& source,
                          const DetailConfig& config) {
  if (target.width <= 0 || target.height <= 0) return;
  if (config.mix <= 0.0f && !config.showGuard) return;

  const Image plate = MatchSize(source, target.width, target.height);

  Image work = target;
  Image detailPlate = plate;
  if (config.linearSpace) {
    ToLinear(work);
    ToLinear(detailPlate);
  }

  const float sigma = RadiusPixels(target.width, target.height,
                                   config.radiusFraction);
  const Image blurredPlate = GaussianBlur(detailPlate, sigma);
  const Image blurredWork = GaussianBlur(work, sigma);

  const bool guarding = config.structureGuard > 0.0f || config.showGuard;
  const Image agreement =
      guarding ? StructureAgreement(blurredPlate, blurredWork, config.guardTolerance)
               : Image();

  if (config.showGuard) {
    target = agreement;
    return;
  }

  const float floorValue = std::max(1e-4f, config.shadowFloor);
  const float limit = std::max(1.0f, config.detailLimit);
  const float lowLimit = 1.0f / limit;

  ParallelBands(target.height, [&](int y0, int y1) {
    for (int y = y0; y < y1; ++y) {
      for (int x = 0; x < target.width; ++x) {
        const float* p = detailPlate.At(x, y);
        const float* bp = blurredPlate.At(x, y);
        const float* bw = blurredWork.At(x, y);
        float* out = work.At(x, y);

        /*
         * Detail as a ratio. Guarded by a floor rather than an epsilon: the
         * divide does not merely become imprecise as the blurred plate
         * approaches black, it explodes, and that is the single most common
         * way this technique produces garbage.
         */
        float ratio[3];
        if (config.lumaOnly) {
          const float ls = Luminance(p[0], p[1], p[2]);
          const float lb = Luminance(bp[0], bp[1], bp[2]);
          const float r = ls / std::max(floorValue, lb);
          ratio[0] = ratio[1] = ratio[2] = r;
        } else {
          for (int c = 0; c < 3; ++c) {
            ratio[c] = p[c] / std::max(floorValue, bp[c]);
          }
        }

        // Fade out where there is nothing but noise to carry, and approaching
        // white where detail would only clip.
        const float plateLuma = Luminance(bp[0], bp[1], bp[2]);
        const float targetLuma = Luminance(bw[0], bw[1], bw[2]);
        float strength = plateLuma / (plateLuma + floorValue);
        strength *= 1.0f - config.highlightRolloff *
                               SmoothStep(0.7f, 1.05f, targetLuma);

        if (config.structureGuard > 0.0f) {
          strength *= Lerp(1.0f, agreement.At(x, y)[0], config.structureGuard);
        }

        for (int c = 0; c < 3; ++c) {
          float d = std::pow(std::max(1e-6f, ratio[c]), config.gain);
          d = std::min(limit, std::max(lowLimit, d));
          // Toward 1.0 is toward no change, which is what every protection
          // above is asking for.
          d = 1.0f + (d - 1.0f) * strength;

          // The render's own high frequency, dropped by `replace` before the
          // plate's is multiplied in — otherwise both are present and edges
          // double.
          const float base = Lerp(out[c], bw[c], Clamp01(config.replace));
          out[c] = base * d;
        }
      }
    }
  });

  if (config.linearSpace) ToDisplay(work);

  const float mix = Clamp01(config.mix);
  ParallelPixels(target.data.size() / 4, [&](std::size_t p0, std::size_t p1) {
    for (std::size_t p = p0; p < p1; ++p) {
      const std::size_t at = p * 4;
      for (int c = 0; c < 3; ++c) {
        target.data[at + c] = Lerp(target.data[at + c], work.data[at + c], mix);
      }
      // Alpha is the layer's shape and no business of a detail transfer.
    }
  });
}

}  // namespace seed
