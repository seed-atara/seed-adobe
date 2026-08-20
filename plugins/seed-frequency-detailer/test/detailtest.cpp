// Properties the detail transfer must hold, checked without Adobe present.
//
// Nothing here can run an .aex, so anything only true inside the plugin glue
// is unverified until a human opens After Effects. These are the parts that do
// not need it.
#include <cmath>
#include <cstdio>
#include <string>

#include "../src/core/detail.h"

namespace {

int failures = 0;

void Check(bool ok, const std::string& what, const std::string& detail = "") {
  std::printf("  %-5s %s%s%s\n", ok ? "ok" : "FAIL", what.c_str(),
              detail.empty() ? "" : " - ", detail.c_str());
  if (!ok) ++failures;
}

/** A flat field with a fine checker of `amplitude` laid over it. */
seed::Image Textured(int w, int h, float base, float amplitude, int period = 2) {
  seed::Image image(w, h);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const bool on = ((x / period) + (y / period)) % 2 == 0;
      const float v = base * (on ? 1.0f + amplitude : 1.0f - amplitude);
      float* px = image.At(x, y);
      px[0] = px[1] = px[2] = v;
      px[3] = 1.0f;
    }
  }
  return image;
}

seed::Image Flat(int w, int h, float value) { return Textured(w, h, value, 0.0f); }

/** Peak-to-trough spread along a row, which is what "has detail" means here. */
float Contrast(const seed::Image& image, int y = 8) {
  float lo = 1e9f;
  float hi = -1e9f;
  for (int x = 4; x < image.width - 4; ++x) {
    const float v = image.At(x, y)[0];
    lo = std::min(lo, v);
    hi = std::max(hi, v);
  }
  return hi - lo;
}

float MeanLuma(const seed::Image& image) {
  double sum = 0;
  for (std::size_t i = 0; i < image.data.size(); i += 4) sum += image.data[i];
  return float(sum / double(image.data.size() / 4));
}

seed::DetailConfig Plain() {
  seed::DetailConfig config;
  config.structureGuard = 0.0f;
  config.highlightRolloff = 0.0f;
  config.radiusFraction = 0.02f;
  return config;
}

void DetailIsTransferred() {
  std::printf("\ndetail transfer\n");

  const seed::Image plate = Textured(64, 64, 0.5f, 0.30f);
  seed::Image soft = Flat(64, 64, 0.5f);
  const float before = Contrast(soft);

  seed::ApplyFrequencyDetail(soft, plate, Plain());

  Check(before < 0.001f, "the render started with no detail");
  Check(Contrast(soft) > 0.05f, "detail arrived",
        "contrast " + std::to_string(Contrast(soft)));
}

/**
 * A texture whose contrast is multiplicative *in linear light*, handed back
 * sRGB-encoded.
 *
 * Textured() builds its checker in whatever space it is given, and the effect
 * works in linear — so two sRGB plates with the same nominal amplitude do not
 * have the same linear contrast at different brightnesses. Testing exposure
 * invariance with those would be testing the encoding, not the technique.
 */
seed::Image LinearTextured(int w, int h, float linearBase, float amplitude,
                           int period = 2) {
  seed::Image image(w, h);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const bool on = ((x / period) + (y / period)) % 2 == 0;
      const float v = linearBase * (on ? 1.0f + amplitude : 1.0f - amplitude);
      float* px = image.At(x, y);
      px[0] = px[1] = px[2] = seed::LinearToSrgb(v);
      px[3] = 1.0f;
    }
  }
  return image;
}

void ExposureInvariance() {
  std::printf("\nexposure invariance - the reason for the ratio form\n");

  // The same *linear* relative texture, one plate four times brighter. A ratio
  // carries relative contrast, so what lands on the render must not care.
  // Both bases sit well above the shadow floor, which deliberately does care.
  const seed::Image dim = LinearTextured(64, 64, 0.10f, 0.30f);
  const seed::Image bright = LinearTextured(64, 64, 0.40f, 0.30f);

  seed::Image a = Flat(64, 64, 0.5f);
  seed::Image b = Flat(64, 64, 0.5f);
  seed::ApplyFrequencyDetail(a, dim, Plain());
  seed::ApplyFrequencyDetail(b, bright, Plain());

  const float ca = Contrast(a);
  const float cb = Contrast(b);
  const float ratio = ca > 0 ? cb / ca : 0.0f;
  Check(ratio > 0.75f && ratio < 1.34f,
        "a plate 4x brighter transfers the same detail",
        "ratio " + std::to_string(ratio));
  // The additive form fails exactly here: its amplitude scales with exposure.
}

void FlatPlateChangesNothing() {
  std::printf("\na plate with no detail\n");

  const seed::Image flat = Flat(64, 64, 0.42f);
  seed::Image render = Textured(64, 64, 0.5f, 0.2f);
  const seed::Image before = render;

  seed::DetailConfig config = Plain();
  config.replace = 0.0f;  // keep the render's own detail
  seed::ApplyFrequencyDetail(render, flat, config);

  float worst = 0.0f;
  for (std::size_t i = 0; i < render.data.size(); ++i) {
    worst = std::max(worst, std::abs(render.data[i] - before.data[i]));
  }
  Check(worst < 0.01f, "leaves the render alone", "worst " + std::to_string(worst));
}

void ReplaceDropsTheRendersOwnDetail() {
  std::printf("\nreplace\n");

  const seed::Image plate = Flat(64, 64, 0.5f);
  seed::Image render = Textured(64, 64, 0.5f, 0.25f);

  seed::DetailConfig config = Plain();
  config.replace = 1.0f;
  seed::ApplyFrequencyDetail(render, plate, config);

  Check(Contrast(render) < 0.02f,
        "at 1.0 the render's own high frequency is gone",
        "contrast " + std::to_string(Contrast(render)));
}

void ShadowsAreProtected() {
  std::printf("\nprotection\n");

  // The divide explodes toward black. Near-black must stay near-black rather
  // than becoming amplified noise.
  const seed::Image darkPlate = Textured(64, 64, 0.002f, 0.5f);
  seed::Image render = Flat(64, 64, 0.02f);

  seed::ApplyFrequencyDetail(render, darkPlate, Plain());

  float worst = 0.0f;
  for (std::size_t i = 0; i < render.data.size(); i += 4) {
    worst = std::max(worst, render.data[i]);
  }
  Check(worst < 0.2f, "a near-black plate does not blow up",
        "brightest " + std::to_string(worst));
}

void DetailLimitBoundsTheRatio() {
  std::printf("\ndetail limit\n");

  const seed::Image extreme = Textured(64, 64, 0.5f, 0.95f);
  seed::Image render = Flat(64, 64, 0.5f);

  seed::DetailConfig config = Plain();
  config.detailLimit = 1.5f;
  config.gain = 3.0f;
  seed::ApplyFrequencyDetail(render, extreme, config);

  float worst = 0.0f;
  for (std::size_t i = 0; i < render.data.size(); i += 4) {
    worst = std::max(worst, render.data[i]);
  }
  Check(worst < 0.95f, "the ratio is bounded", "brightest " + std::to_string(worst));
}

void StructureGuardFadesOnDisagreement() {
  std::printf("\ndrift guard\n");

  // An edge on the left in one image and further right in the other: the same
  // amount of structure, in the wrong place. That is drift.
  seed::Image plate(64, 64);
  seed::Image render(64, 64);
  for (int y = 0; y < 64; ++y) {
    for (int x = 0; x < 64; ++x) {
      float* p = plate.At(x, y);
      float* r = render.At(x, y);
      p[0] = p[1] = p[2] = x < 20 ? 0.25f : 0.65f;
      r[0] = r[1] = r[2] = x < 44 ? 0.25f : 0.65f;
      p[3] = r[3] = 1.0f;
    }
  }

  const seed::Image blurredPlate = seed::GaussianBlur(plate, 3.0f);
  const seed::Image blurredRender = seed::GaussianBlur(render, 3.0f);
  const seed::Image agree =
      seed::StructureAgreement(blurredPlate, blurredRender, 0.3f);

  Check(agree.At(20, 32)[0] < 0.6f, "disagrees where the plate's edge is alone",
        "agreement " + std::to_string(agree.At(20, 32)[0]));
  Check(agree.At(2, 32)[0] > 0.9f, "agrees where neither has structure",
        "agreement " + std::to_string(agree.At(2, 32)[0]));

  const seed::Image same =
      seed::StructureAgreement(blurredPlate, blurredPlate, 0.3f);
  Check(same.At(20, 32)[0] > 0.9f, "agrees with itself",
        "agreement " + std::to_string(same.At(20, 32)[0]));
}

void MixAndAlpha() {
  std::printf("\nmix and alpha\n");

  const seed::Image plate = Textured(64, 64, 0.5f, 0.30f);
  seed::Image render = Flat(64, 64, 0.5f);

  seed::DetailConfig config = Plain();
  config.mix = 0.0f;
  const seed::Image before = render;
  seed::ApplyFrequencyDetail(render, plate, config);

  float worst = 0.0f;
  for (std::size_t i = 0; i < render.data.size(); ++i) {
    worst = std::max(worst, std::abs(render.data[i] - before.data[i]));
  }
  Check(worst < 1e-6f, "mix 0 is a no-op");

  seed::Image withAlpha = Flat(64, 64, 0.5f);
  for (std::size_t i = 3; i < withAlpha.data.size(); i += 4) {
    withAlpha.data[i] = 0.37f;
  }
  seed::ApplyFrequencyDetail(withAlpha, plate, Plain());
  bool alphaHeld = true;
  for (std::size_t i = 3; i < withAlpha.data.size(); i += 4) {
    if (std::abs(withAlpha.data[i] - 0.37f) > 1e-6f) alphaHeld = false;
  }
  Check(alphaHeld, "alpha is untouched");
}

void SizeMismatch() {
  std::printf("\na detail source of a different size\n");

  const seed::Image plate = Textured(128, 128, 0.5f, 0.30f);
  seed::Image render = Flat(64, 64, 0.5f);
  seed::ApplyFrequencyDetail(render, plate, Plain());

  Check(render.width == 64 && render.height == 64, "the frame is unchanged");
  Check(std::abs(MeanLuma(render) - 0.5f) < 0.08f,
        "and the picture is still there",
        "mean " + std::to_string(MeanLuma(render)));
}

}  // namespace

int main() {
  std::printf("SEED Frequency Detailer - core\n");

  DetailIsTransferred();
  ExposureInvariance();
  FlatPlateChangesNothing();
  ReplaceDropsTheRendersOwnDetail();
  ShadowsAreProtected();
  DetailLimitBoundsTheRatio();
  StructureGuardFadesOnDisagreement();
  MixAndAlpha();
  SizeMismatch();

  std::printf("\n%s\n", failures == 0 ? "PASS" : "FAIL");
  return failures == 0 ? 0 : 1;
}
