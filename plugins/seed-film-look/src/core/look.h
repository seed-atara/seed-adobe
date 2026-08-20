// SEED film look — the chain, in C++.
//
// A direct port of packages/filmlook, deliberately free of Adobe headers,
// platform headers and allocation policy so that it compiles and is tested on
// its own. The After Effects glue in ../ae is the only part that needs the
// SDK, and keeping the maths out of it is what lets most of this plugin be
// verified without Adobe present at all.
//
// Two implementations of one look is a promise to keep them identical. The
// parity test checks that promise against vectors generated from the
// TypeScript engine; anything that changes here must change there too.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <thread>
#include <vector>

namespace seed {

// ------------------------------------------------------------- threading
//
// Templates, so they live in the header — and shared, so every SEED effect
// splits a frame the same way rather than each inventing its own policy.

/*
 * How many workers to split a frame across.
 *
 * Cached: hardware_concurrency is not free and this is called several times a
 * frame. Capped at 16 because the host may already be rendering other frames
 * in parallel — the effect declares threaded rendering — and oversubscribing
 * a machine costs more in contention than it wins in throughput.
 */
inline int WorkerCount() {
  static const int workers = [] {
    const unsigned hinted = std::thread::hardware_concurrency();
    const int n = hinted == 0 ? 4 : int(hinted);
    return std::max(1, std::min(n, 16));
  }();
  return workers;
}

/** Runs `body(begin, end)` over disjoint slices of [0, count). */
template <typename Body>
void ParallelBands(int count, const Body& body) {
  const int workers = std::min(WorkerCount(), std::max(1, count));
  if (workers <= 1 || count <= 1) {
    body(0, count);
    return;
  }
  std::vector<std::thread> threads;
  threads.reserve(std::size_t(workers - 1));
  const int band = (count + workers - 1) / workers;
  for (int w = 1; w < workers; ++w) {
    const int begin = std::min(count, w * band);
    const int end = std::min(count, begin + band);
    if (begin >= end) break;
    threads.emplace_back([&body, begin, end] { body(begin, end); });
  }
  body(0, std::min(count, band));
  for (std::thread& thread : threads) thread.join();
}


/*
 * Splits a whole-image pixel pass across workers.
 *
 * Every stage below is independent per pixel, so this is the same loop with
 * the range handed out in bands. Kept separate from ParallelBands because it
 * counts pixels rather than rows and the arithmetic reads better that way.
 */
template <typename Body>
void ParallelPixels(std::size_t pixels, const Body& body) {
  ParallelBands(int(pixels), [&](int begin, int end) {
    body(std::size_t(begin), std::size_t(end));
  });
}

// ---------------------------------------------------------------- colour

// The exact piecewise sRGB definitions, not a 2.2 power. The difference lives
// in the bottom two stops, which is where the optical half does its work.
inline float SrgbToLinear(float v) {
  return v <= 0.04045f ? v / 12.92f : std::pow((v + 0.055f) / 1.055f, 2.4f);
}

inline float LinearToSrgb(float v) {
  return v <= 0.0031308f ? v * 12.92f
                         : 1.055f * std::pow(v, 1.0f / 2.4f) - 0.055f;
}

inline float Luminance(float r, float g, float b) {
  return r * 0.2126f + g * 0.7152f + b * 0.0722f;
}

inline float Clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

inline float Lerp(float a, float b, float t) { return a + (b - a) * t; }

// The signature stage: extended Reinhard. Not interchangeable with a generic
// filmic curve — this is the one that produces this highlight rolloff, and it
// was reverse-engineered from the show's master comp rather than authored.
//
//   x   = wp_gain * c
//   out = x(1 + x/wp^2) / (1 + x)
//   out = out ^ (1/wp_gamma)
inline float WhitepointTonemap(float c, float gain, float wp, float gamma,
                               float amount) {
  if (amount <= 0.0f) return c;
  const float x = gain * c;
  float out = (x * (1.0f + x / (wp * wp))) / (1.0f + x);
  out = std::pow(std::max(0.0f, out), 1.0f / gamma);
  return c + (out - c) * amount;
}

inline float Hable(float x) {
  const float a = 0.15f, b = 0.50f, c = 0.10f, d = 0.20f, e = 0.02f, f = 0.30f;
  return (x * (a * x + c * b) + d * e) / (x * (a * x + b) + d * f) - e / f;
}

inline float HableTonemap(float x) {
  static const float white = Hable(11.2f);
  return Hable(x) / white;
}

// AgX-style highlight desaturation: a smooth path to white, killing the
// over-saturated highlights a digital renderer produces.
inline void PathToWhite(float& r, float& g, float& b, float amount) {
  if (amount <= 0.0f) return;
  const float peak = std::max(r, std::max(g, b));
  if (peak <= 0.0f) return;
  const float t = Clamp01(peak / (1.0f + peak)) * amount;
  r += (peak - r) * t;
  g += (peak - g) * t;
  b += (peak - b) * t;
}

// ------------------------------------------------------------------ stock

struct Stock {
  float matrix[3][3];
  float saturation;
  float black_lift;
  float white_rolloff;
  float contrast;
  float pivot;
  float grain_rms[3];
  float grain_size;
  float grain_size_mul[3];
  float halation;
  float warmth;
};

// The show stock. Identity matrix and a global desaturation, with no black
// lift or white rolloff because the whitepoint tonemap already does that work
// — and a deliberately asymmetric grain: red fine and weak, blue large and
// strong. That asymmetry is a real property of the emulsion and much of why
// the result reads as film rather than as noise.
inline Stock Kodak5217() {
  Stock s{};
  s.matrix[0][0] = 1; s.matrix[0][1] = 0; s.matrix[0][2] = 0;
  s.matrix[1][0] = 0; s.matrix[1][1] = 1; s.matrix[1][2] = 0;
  s.matrix[2][0] = 0; s.matrix[2][1] = 0; s.matrix[2][2] = 1;
  s.saturation = 0.85f;
  s.black_lift = 0.0f;
  s.white_rolloff = 1.0f;
  s.contrast = 1.0f;
  s.pivot = 0.45f;
  s.grain_rms[0] = 0.0145f; s.grain_rms[1] = 0.0127f; s.grain_rms[2] = 0.0262f;
  s.grain_size = 1.0f;
  s.grain_size_mul[0] = 0.19f; s.grain_size_mul[1] = 1.0f; s.grain_size_mul[2] = 1.17f;
  s.halation = 0.0f;
  s.warmth = 0.0f;
  return s;
}

inline Stock Vision3_500T() {
  Stock s{};
  s.matrix[0][0] = 1.03f; s.matrix[0][1] = 0.02f; s.matrix[0][2] = -0.05f;
  s.matrix[1][0] = 0.0f;  s.matrix[1][1] = 1.0f;  s.matrix[1][2] = 0.0f;
  s.matrix[2][0] = -0.03f; s.matrix[2][1] = 0.0f; s.matrix[2][2] = 1.04f;
  s.saturation = 1.0f;
  s.black_lift = 0.024f;
  s.white_rolloff = 0.9f;
  s.contrast = 1.07f;
  s.pivot = 0.46f;
  s.grain_rms[0] = 0.018f; s.grain_rms[1] = 0.02f; s.grain_rms[2] = 0.03f;
  s.grain_size = 1.35f;
  s.grain_size_mul[0] = 1.0f; s.grain_size_mul[1] = 1.0f; s.grain_size_mul[2] = 1.0f;
  s.halation = 0.32f;
  s.warmth = 0.05f;
  return s;
}

// ----------------------------------------------------------------- config

// Only the parameters the plugin exposes. The full 66 live in the config
// package and reach here resolved; a plugin surfacing all of them would be the
// twenty-effect mistake the architecture note warns about.
struct Config {
  float exposure = 0.97f;

  // Camera geometry
  float distortion_k1 = -0.0075f;
  float distortion_k2 = 0.002f;
  float ca_lateral = 0.0015f;
  float vignette = 0.15f;
  float vignette_mech = 0.05f;

  // Highlights
  float glare_threshold = 0.8f;
  float glare_radius = 0.012f;
  float glare_intensity = 0.05f;
  float halation_scale = 0.5f;
  float halation_radius = 0.01f;
  float halation_tint[3] = {1.0f, 0.45f, 0.25f};
  float halation_color = 0.12f;

  // Tonemaps
  float path_to_white = 0.0f;
  float tonemap = 0.0f;
  float wp_tonemap = 1.0f;
  float wp = 1.1f;
  float wp_gain = 1.2f;
  float wp_gamma = 0.937f;

  // Grade
  float contrast = 1.0f;
  float contrast_pivot = 0.5f;
  float saturation = 1.0f;
  float lift = 0.0f;
  float gain = 1.0f;
  float temp = 0.0f;
  float tint = 0.0f;

  // Grain
  bool grain_enable = true;
  float grain_scale = 0.5f;
  float grain_size = 0.5f;
  float grain_chroma = 0.8f;
  float grain_gate = 0.0f;
  int grain_ref_longedge = 4096;
  int seed = 7;
};

// ------------------------------------------------------------------ image

// RGBA float, straight (not premultiplied). Alpha is carried through every
// stage untouched by colour, and warped only by the geometry — a region
// capture has a matte that must keep lining up with its picture.
struct Image {
  int width = 0;
  int height = 0;
  std::vector<float> data;

  Image() = default;
  Image(int w, int h) : width(w), height(h), data(std::size_t(w) * h * 4, 0.0f) {}

  inline float* At(int x, int y) { return &data[(std::size_t(y) * width + x) * 4]; }
  inline const float* At(int x, int y) const {
    return &data[(std::size_t(y) * width + x) * 4];
  }
};

inline float Diagonal(int width, int height) {
  return std::sqrt(float(width) * width + float(height) * height);
}

// Every spatial radius in the specification is a fraction of the diagonal.
// That is what makes one preset hold at 1920x1080 and at 4096x2304 — and it
// must be computed from the buffer actually being rendered, including a
// reduced preview resolution.
inline float RadiusPixels(int width, int height, float fraction) {
  return std::max(0.0f, fraction) * Diagonal(width, height);
}

float SampleChannelBilinear(const Image& img, float x, float y, int channel);

// ------------------------------------------------------------------- chain

// Both phases, in the specified order, which is not open to rearrangement.
// Input and output are sRGB-encoded 0..1; the first half runs in scene-linear.
void ApplyFilmLook(Image& image, const Config& config, const Stock& stock,
                   int frame);

// Individual stages, exposed for the parity test rather than for reordering.
void ApplyPhaseA(Image& image, const Config& config, const Stock& stock);
void ApplyPhaseB(Image& image, const Config& config, const Stock& stock,
                 int frame);
void ApplyGrain(Image& image, const Config& config, const Stock& stock,
                int frame);
Image DistortAndAberrate(const Image& src, float k1, float k2, float ca);
void ApplyVignette(Image& image, float amount, float mechanical);
Image GaussianBlur(const Image& src, float sigma);

}  // namespace seed
