// What the grain controls actually do, measured.
#include <cstdio>
#include <cmath>
#include "../src/core/look.h"

static double StdDev(const seed::Image& img, int c) {
  const int n = img.width * img.height;
  double s = 0, sq = 0;
  for (int p = 0; p < n; ++p) s += img.data[std::size_t(p) * 4 + c];
  const double mean = s / n;
  for (int p = 0; p < n; ++p) {
    const double d = img.data[std::size_t(p) * 4 + c] - mean;
    sq += d * d;
  }
  return std::sqrt(sq / n);
}

// Correlation with the pixel to the right. Clumped grain is correlated with
// its neighbours; per-pixel noise is not. This is what Size changes — the
// amplitude is deliberately held constant by the renormalisation, so a
// standard deviation cannot see it.
static double Neighbour(const seed::Image& img, int c) {
  const int n = img.width * img.height;
  double s = 0;
  for (int p = 0; p < n; ++p) s += img.data[std::size_t(p) * 4 + c];
  const double mean = s / n;
  double cov = 0, var = 0;
  for (int y = 0; y < img.height; ++y) {
    for (int x = 0; x + 1 < img.width; ++x) {
      const double a = img.At(x, y)[c] - mean;
      const double b = img.At(x + 1, y)[c] - mean;
      cov += a * b;
      var += a * a;
    }
  }
  return var > 0 ? cov / var : 0.0;
}

static seed::Image Grey(int w, int h) {
  seed::Image img(w, h);
  for (std::size_t i = 0; i < img.data.size(); i += 4) {
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 0.18f;
    img.data[i + 3] = 1.0f;
  }
  return img;
}

int main() {
  const int W = 1920, H = 1080;
  const seed::Stock stock = seed::Kodak5217();

  std::printf("Frame %dx%d, show-match defaults, grain only.\n", W, H);
  std::printf("%-8s %-8s %-10s %-10s %-10s %s\n", "amount", "size", "sigma_B",
              "sd_B(/255)", "neighbour", "note");

  const float amounts[] = {0.0f, 0.5f, 1.5f, 3.0f};
  const float sizes[] = {0.5f, 2.0f, 4.0f};

  for (float amount : amounts) {
    for (float size : sizes) {
      seed::Config cfg;                 // show-match defaults
      cfg.wp_tonemap = 0; cfg.exposure = 1;
      cfg.distortion_k1 = cfg.distortion_k2 = cfg.ca_lateral = 0;
      cfg.vignette = cfg.vignette_mech = 0; cfg.glare_intensity = 0;
      cfg.halation_scale = 0;
      cfg.grain_scale = amount;
      cfg.grain_size = size;

      const float genScale = float(W) / float(cfg.grain_ref_longedge);
      const float sigmaB = cfg.grain_size * stock.grain_size *
                           stock.grain_size_mul[2] * genScale;

      seed::Image img = Grey(W, H);
      seed::ApplyFilmLook(img, cfg, stock, 0);

      std::printf("%-8.2f %-8.2f %-10.3f %-11.2f %-11.3f %s\n", amount, size,
                  sigmaB, StdDev(img, 2) * 255.0, Neighbour(img, 2),
                  sigmaB > 1.0f ? "box" : "three-tap");
    }
  }
  return 0;
}
