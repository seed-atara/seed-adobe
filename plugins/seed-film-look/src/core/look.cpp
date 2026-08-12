#include "look.h"

namespace seed {
namespace {

// Running-sum box blur, clamped at the edges so a bright border does not bleed
// darkness inward the way a zero-padded blur would.
Image BoxBlurH(const Image& src, int radius) {
  Image out(src.width, src.height);
  const int r = std::max(1, radius);
  const float span = float(r * 2 + 1);

  for (int y = 0; y < src.height; ++y) {
    for (int c = 0; c < 4; ++c) {
      float sum = 0.0f;
      for (int i = -r; i <= r; ++i) {
        const int x = std::min(std::max(i, 0), src.width - 1);
        sum += src.At(x, y)[c];
      }
      for (int x = 0; x < src.width; ++x) {
        out.At(x, y)[c] = sum / span;
        const int leaving = std::min(std::max(x - r, 0), src.width - 1);
        const int entering = std::min(std::max(x + r + 1, 0), src.width - 1);
        sum += src.At(entering, y)[c] - src.At(leaving, y)[c];
      }
    }
  }
  return out;
}

Image BoxBlurV(const Image& src, int radius) {
  Image out(src.width, src.height);
  const int r = std::max(1, radius);
  const float span = float(r * 2 + 1);

  for (int x = 0; x < src.width; ++x) {
    for (int c = 0; c < 4; ++c) {
      float sum = 0.0f;
      for (int i = -r; i <= r; ++i) {
        const int y = std::min(std::max(i, 0), src.height - 1);
        sum += src.At(x, y)[c];
      }
      for (int y = 0; y < src.height; ++y) {
        out.At(x, y)[c] = sum / span;
        const int leaving = std::min(std::max(y - r, 0), src.height - 1);
        const int entering = std::min(std::max(y + r + 1, 0), src.height - 1);
        sum += src.At(x, entering)[c] - src.At(x, leaving)[c];
      }
    }
  }
  return out;
}

// Kovesi's derivation for approximating a Gaussian with n boxes.
std::vector<int> BoxSizes(float sigma, int n) {
  const float ideal = std::sqrt((12.0f * sigma * sigma) / n + 1.0f);
  int wl = int(std::floor(ideal));
  if (wl % 2 == 0) --wl;
  const int wu = wl + 2;

  const float mIdeal = (12.0f * sigma * sigma - float(n * wl * wl) -
                        float(4 * n * wl) - float(3 * n)) /
                       (-4.0f * wl - 4.0f);
  const int m = int(std::round(mIdeal));

  std::vector<int> sizes;
  for (int i = 0; i < n; ++i) {
    const int size = i < m ? wl : wu;
    if (size > 1) sizes.push_back(size);
  }
  return sizes;
}

// Everything above a threshold, everything else black.
Image ThresholdCopy(const Image& src, float threshold) {
  Image out = src;
  for (std::size_t i = 0; i < out.data.size(); i += 4) {
    const float y = Luminance(out.data[i], out.data[i + 1], out.data[i + 2]);
    const float keep = y > threshold ? (y - threshold) / std::max(y, 1e-6f) : 0.0f;
    out.data[i] *= keep;
    out.data[i + 1] *= keep;
    out.data[i + 2] *= keep;
  }
  return out;
}

void AddScaled(Image& target, const Image& source, float scale) {
  for (std::size_t i = 0; i < target.data.size(); i += 4) {
    target.data[i] += source.data[i] * scale;
    target.data[i + 1] += source.data[i + 1] * scale;
    target.data[i + 2] += source.data[i + 2] * scale;
  }
}

// 32-bit hash to a float in [0,1). Hashed rather than sequential so any pixel
// can be evaluated independently — which is what makes this portable to a
// shader later without the grain changing.
inline float Hash(int seed, int frame, int channel, int x, int y, int salt) {
  std::uint32_t h = 2166136261u;
  const int values[6] = {seed, frame, channel, x, y, salt};
  for (int i = 0; i < 6; ++i) {
    h ^= std::uint32_t(values[i]);
    h *= 16777619u;
    h ^= h >> 13;
  }
  h ^= h >> 16;
  return float(double(h) / 4294967296.0);
}

inline float GaussianAt(int seed, int frame, int channel, int x, int y) {
  const float u1 = std::max(Hash(seed, frame, channel, x, y, 0), 1e-7f);
  const float u2 = Hash(seed, frame, channel, x, y, 1);
  return std::sqrt(-2.0f * std::log(u1)) * std::cos(6.283185307179586f * u2);
}

// Clump the noise, then restore its standard deviation. Blurring reduces
// variance, so a clumped field left alone is quieter than the stock asks for —
// and the grain test measures exactly that.
std::vector<float> Clump(const std::vector<float>& noise, int width, int height,
                         float sigma) {
  Image carrier(width, height);
  for (std::size_t p = 0; p < noise.size(); ++p) carrier.data[p * 4] = noise[p];

  const Image blurred = GaussianBlur(carrier, sigma);

  double sum = 0.0, sumSq = 0.0;
  for (std::size_t p = 0; p < noise.size(); ++p) {
    const double v = blurred.data[p * 4];
    sum += v;
    sumSq += v * v;
  }
  const double mean = sum / double(noise.size());
  const double variance = std::max(sumSq / double(noise.size()) - mean * mean, 1e-12);
  const double correction = 1.0 / std::sqrt(variance);

  std::vector<float> out(noise.size());
  for (std::size_t p = 0; p < noise.size(); ++p) {
    out[p] = float((blurred.data[p * 4] - mean) * correction);
  }
  return out;
}

// Separable three-tap Gaussian, for sigma up to one pixel.
//
// Weights [s^2/2, 1-s^2, s^2/2] carry variance s^2 exactly. Iterated boxes
// cannot go below a pixel because their radii are integers, and bailing out
// instead left grain's Size control dead across the bottom of its range at any
// frame smaller than the grain reference.
Image ThreeTap(const Image& src, float sigma) {
  const float side = (sigma * sigma) * 0.5f;
  const float centre = 1.0f - 2.0f * side;

  auto pass = [&](const Image& in, bool horizontal) {
    Image out(in.width, in.height);
    for (int y = 0; y < in.height; ++y) {
      for (int x = 0; x < in.width; ++x) {
        const float* back = horizontal ? in.At(std::max(0, x - 1), y)
                                       : in.At(x, std::max(0, y - 1));
        const float* here = in.At(x, y);
        const float* forward = horizontal
                                   ? in.At(std::min(in.width - 1, x + 1), y)
                                   : in.At(x, std::min(in.height - 1, y + 1));
        float* o = out.At(x, y);
        for (int c = 0; c < 4; ++c) {
          o[c] = back[c] * side + here[c] * centre + forward[c] * side;
        }
      }
    }
    return out;
  };

  return pass(pass(src, true), false);
}

}  // namespace

float SampleChannelBilinear(const Image& img, float x, float y, int channel) {
  const float cx = std::min(std::max(x, 0.0f), float(img.width - 1));
  const float cy = std::min(std::max(y, 0.0f), float(img.height - 1));

  const int x0 = int(std::floor(cx));
  const int y0 = int(std::floor(cy));
  const int x1 = std::min(x0 + 1, img.width - 1);
  const int y1 = std::min(y0 + 1, img.height - 1);
  const float fx = cx - x0;
  const float fy = cy - y0;

  const float top = img.At(x0, y0)[channel] * (1 - fx) + img.At(x1, y0)[channel] * fx;
  const float bottom = img.At(x0, y1)[channel] * (1 - fx) + img.At(x1, y1)[channel] * fx;
  return top * (1 - fy) + bottom * fy;
}

Image GaussianBlur(const Image& src, float sigma) {
  if (!(sigma > 0.01f)) return src;
  if (sigma <= 1.0f) return ThreeTap(src, sigma);
  Image current = src;
  for (int width : BoxSizes(sigma, 3)) {
    current = BoxBlurH(current, (width - 1) / 2);
    current = BoxBlurV(current, (width - 1) / 2);
  }
  return current;
}

// Distortion and lateral chromatic aberration as a single gather. Two passes
// doubles both the softening and the cost, and the softening is the part that
// shows.
Image DistortAndAberrate(const Image& src, float k1, float k2, float ca) {
  if (k1 == 0.0f && k2 == 0.0f && ca == 0.0f) return src;

  Image out(src.width, src.height);
  const float cx = (src.width - 1) * 0.5f;
  const float cy = (src.height - 1) * 0.5f;
  const float half = Diagonal(src.width, src.height) * 0.5f;

  for (int y = 0; y < src.height; ++y) {
    for (int x = 0; x < src.width; ++x) {
      const float dx = x - cx;
      const float dy = y - cy;
      const float r = std::sqrt(dx * dx + dy * dy) / half;
      const float r2 = r * r;
      const float scale = 1.0f + k1 * r2 + k2 * r2 * r2;
      const float scaleR = scale * (1.0f + ca * r);
      const float scaleB = scale * (1.0f - ca * r);

      float* o = out.At(x, y);
      o[0] = SampleChannelBilinear(src, cx + dx * scaleR, cy + dy * scaleR, 0);
      o[1] = SampleChannelBilinear(src, cx + dx * scale, cy + dy * scale, 1);
      o[2] = SampleChannelBilinear(src, cx + dx * scaleB, cy + dy * scaleB, 2);
      // Alpha follows green's geometry: a matte has no dispersion.
      o[3] = SampleChannelBilinear(src, cx + dx * scale, cy + dy * scale, 3);
    }
  }
  return out;
}

// cos^4 illumination falloff plus a mechanical corner term, in linear. This is
// illumination falloff, not crushed corners — emphatically not a black ellipse
// multiplied over the picture in display space.
void ApplyVignette(Image& image, float amount, float mechanical) {
  if (amount == 0.0f && mechanical == 0.0f) return;

  const float cx = (image.width - 1) * 0.5f;
  const float cy = (image.height - 1) * 0.5f;
  const float half = Diagonal(image.width, image.height) * 0.5f;

  for (int y = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x) {
      const float dx = x - cx;
      const float dy = y - cy;
      const float r = std::sqrt(dx * dx + dy * dy) / half;
      const float denom = 1.0f + r * r;
      const float cos4 = 1.0f / (denom * denom);
      float factor = 1.0f - amount * (1.0f - cos4);

      if (mechanical != 0.0f) {
        const float bite = std::max(0.0f, (r - 0.66f) / 0.34f);
        factor *= 1.0f - mechanical * bite * bite;
      }

      float* p = image.At(x, y);
      p[0] *= factor;
      p[1] *= factor;
      p[2] *= factor;
    }
  }
}

void ApplyPhaseA(Image& image, const Config& config, const Stock& stock) {
  // sRGB in, linear internally. Values above 1.0 are allowed through: the
  // optical stages are meaningless without highlights beyond display white,
  // and clamping is the quiet way to lose every bloom and halation.
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    image.data[i] = SrgbToLinear(image.data[i]) * config.exposure;
    image.data[i + 1] = SrgbToLinear(image.data[i + 1]) * config.exposure;
    image.data[i + 2] = SrgbToLinear(image.data[i + 2]) * config.exposure;
  }

  image = DistortAndAberrate(image, config.distortion_k1, config.distortion_k2,
                             config.ca_lateral);
  ApplyVignette(image, config.vignette, config.vignette_mech);

  if (config.glare_intensity > 0.0f) {
    const Image highlights = ThresholdCopy(image, config.glare_threshold);
    const Image veil = GaussianBlur(
        highlights, RadiusPixels(image.width, image.height, config.glare_radius));
    AddScaled(image, veil, config.glare_intensity);
  }

  const float halation = stock.halation * config.halation_scale;
  if (halation > 0.0f) {
    // Thresholded where highlights begin, not at display white. Thresholding
    // at 1.0 meant halation never fired on ordinary footage: a maximum-white
    // sRGB pixel is exactly 1.0 in linear and the show exposure of 0.97 pulls
    // it below. The specification says to threshold the bright areas without
    // saying where, so this uses the config's own answer to that question.
    const Image highlights = ThresholdCopy(image, config.glare_threshold);
    const Image halo = GaussianBlur(
        highlights,
        RadiusPixels(image.width, image.height, config.halation_radius));
    const float green = config.halation_tint[1] + config.halation_color;
    for (std::size_t i = 0; i < image.data.size(); i += 4) {
      image.data[i] += halo.data[i] * config.halation_tint[0] * halation;
      image.data[i + 1] += halo.data[i + 1] * green * halation;
      image.data[i + 2] += halo.data[i + 2] * config.halation_tint[2] * halation;
    }
  }

  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    float r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];

    if (config.path_to_white > 0.0f) PathToWhite(r, g, b, config.path_to_white);

    if (config.tonemap > 0.0f) {
      r += (HableTonemap(r) - r) * config.tonemap;
      g += (HableTonemap(g) - g) * config.tonemap;
      b += (HableTonemap(b) - b) * config.tonemap;
    }
    if (config.wp_tonemap > 0.0f) {
      r = WhitepointTonemap(r, config.wp_gain, config.wp, config.wp_gamma,
                            config.wp_tonemap);
      g = WhitepointTonemap(g, config.wp_gain, config.wp, config.wp_gamma,
                            config.wp_tonemap);
      b = WhitepointTonemap(b, config.wp_gain, config.wp, config.wp_gamma,
                            config.wp_tonemap);
    }

    image.data[i] = LinearToSrgb(std::max(0.0f, r));
    image.data[i + 1] = LinearToSrgb(std::max(0.0f, g));
    image.data[i + 2] = LinearToSrgb(std::max(0.0f, b));
  }
}

void ApplyGrain(Image& image, const Config& config, const Stock& stock,
                int frame) {
  if (!config.grain_enable || config.grain_scale <= 0.0f) return;
  if (stock.grain_rms[0] == 0 && stock.grain_rms[1] == 0 && stock.grain_rms[2] == 0) {
    return;
  }

  const int pixels = image.width * image.height;
  const int longEdge = std::max(image.width, image.height);
  const int reference =
      config.grain_ref_longedge > 0 ? config.grain_ref_longedge : longEdge;
  const float genScale = reference > 0 ? float(longEdge) / float(reference) : 1.0f;

  // The mono field, so grain_chroma can blend luminance-only against
  // per-channel. Generated once and shared, matching the reference engine.
  // Braced, not parenthesised: `std::vector<float> v(std::size_t(pixels))`
  // declares a *function* taking a size_t. The most vexing parse, and it
  // reports itself several lines later as "overloaded-function".
  std::vector<float> monoRaw(static_cast<std::size_t>(pixels), 0.0f);
  for (int y = 0, p = 0; y < image.height; ++y) {
    for (int x = 0; x < image.width; ++x, ++p) {
      monoRaw[p] = GaussianAt(config.seed, frame, 0, x, y);
    }
  }

  for (int channel = 0; channel < 3; ++channel) {
    const float amplitude = stock.grain_rms[channel] * config.grain_scale;
    if (amplitude <= 0.0f) continue;

    const float sigma = config.grain_size * stock.grain_size *
                        stock.grain_size_mul[channel] * genScale;

    std::vector<float> ownRaw;
    if (channel == 0) {
      ownRaw = monoRaw;
    } else {
      ownRaw.resize(static_cast<std::size_t>(pixels));
      for (int y = 0, p = 0; y < image.height; ++y) {
        for (int x = 0; x < image.width; ++x, ++p) {
          ownRaw[p] = GaussianAt(config.seed, frame, channel, x, y);
        }
      }
    }

    std::vector<float> mono = monoRaw;
    std::vector<float> own = ownRaw;
    if (sigma > 0.01f) {
      mono = Clump(monoRaw, image.width, image.height, sigma);
      own = Clump(ownRaw, image.width, image.height, sigma);
    }

    for (int p = 0; p < pixels; ++p) {
      const std::size_t base = std::size_t(p) * 4;
      const float n = Lerp(mono[p], own[p], config.grain_chroma);

      const float y = Luminance(image.data[base], image.data[base + 1],
                                image.data[base + 2]);
      const float midWeight = 4.0f * y * (1.0f - y);
      const float shadowWeight = 1.0f - y;
      const float weight = Lerp(midWeight, shadowWeight, config.grain_gate);

      image.data[base + channel] += n * amplitude * weight;
    }
  }
}

void ApplyPhaseB(Image& image, const Config& config, const Stock& stock,
                 int frame) {
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    float r = image.data[i], g = image.data[i + 1], b = image.data[i + 2];

    // Stock colour: matrix, saturation, lift, rolloff, contrast, warmth.
    const float mr = stock.matrix[0][0] * r + stock.matrix[0][1] * g + stock.matrix[0][2] * b;
    const float mg = stock.matrix[1][0] * r + stock.matrix[1][1] * g + stock.matrix[1][2] * b;
    const float mb = stock.matrix[2][0] * r + stock.matrix[2][1] * g + stock.matrix[2][2] * b;
    r = mr; g = mg; b = mb;

    if (stock.saturation != 1.0f) {
      const float y = Luminance(r, g, b);
      r = y + (r - y) * stock.saturation;
      g = y + (g - y) * stock.saturation;
      b = y + (b - y) * stock.saturation;
    }
    if (stock.black_lift != 0.0f) {
      const float l = stock.black_lift;
      r = l + r * (1 - l); g = l + g * (1 - l); b = l + b * (1 - l);
    }
    if (stock.white_rolloff != 1.0f) {
      const float w = stock.white_rolloff;
      auto roll = [w](float v) {
        return v <= 0.0f ? v : (v * w) / (1.0f + std::max(0.0f, v - w) * 2.0f);
      };
      r = roll(r); g = roll(g); b = roll(b);
    }
    if (stock.contrast != 1.0f) {
      r = (r - stock.pivot) * stock.contrast + stock.pivot;
      g = (g - stock.pivot) * stock.contrast + stock.pivot;
      b = (b - stock.pivot) * stock.contrast + stock.pivot;
    }
    if (stock.warmth != 0.0f) {
      r *= 1.0f + stock.warmth * 0.25f;
      b *= 1.0f - stock.warmth * 0.25f;
    }

    // Grade.
    r = r * config.gain + config.lift;
    g = g * config.gain + config.lift;
    b = b * config.gain + config.lift;

    if (config.contrast != 1.0f) {
      r = (r - config.contrast_pivot) * config.contrast + config.contrast_pivot;
      g = (g - config.contrast_pivot) * config.contrast + config.contrast_pivot;
      b = (b - config.contrast_pivot) * config.contrast + config.contrast_pivot;
    }
    if (config.temp != 0.0f || config.tint != 0.0f) {
      const float rGain = 1.0f + config.temp * 0.25f + config.tint * 0.05f;
      const float gGain = 1.0f - config.tint * 0.15f;
      const float bGain = 1.0f - config.temp * 0.25f + config.tint * 0.05f;
      r *= rGain; g *= gGain; b *= bGain;
    }
    if (config.saturation != 1.0f) {
      const float y = Luminance(r, g, b);
      r = y + (r - y) * config.saturation;
      g = y + (g - y) * config.saturation;
      b = y + (b - y) * config.saturation;
    }

    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
  }

  // Grain last, always. Grain applied before a grade gets graded, and then
  // reads as digital noise rather than film.
  ApplyGrain(image, config, stock, frame);
}

void ApplyFilmLook(Image& image, const Config& config, const Stock& stock,
                   int frame) {
  ApplyPhaseA(image, config, stock);
  ApplyPhaseB(image, config, stock, frame);
}

}  // namespace seed
