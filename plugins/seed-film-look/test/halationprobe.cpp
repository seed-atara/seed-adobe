// Does the halation control do anything, and on which stocks?
//
// Measured as red bleed into the dark ring around a bright disc — which is
// what halation looks like, and what a whole-frame average cannot see.
#include <cstdio>
#include <cmath>
#include "../src/core/look.h"

static seed::Image Disc(int w, int h) {
  seed::Image img(w, h);
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const float dx = float(x - w / 2), dy = float(y - h / 2);
      const bool hot = std::sqrt(dx * dx + dy * dy) < w * 0.10f;
      float* p = img.At(x, y);
      p[0] = p[1] = p[2] = hot ? 1.0f : 0.02f;
      p[3] = 1.0f;
    }
  }
  return img;
}

// Mean red minus mean blue in an annulus outside the disc. Halation is
// red-orange, so it shows as a positive difference; nothing else here does.
static double RedBleed(const seed::Image& img) {
  const int w = img.width, h = img.height;
  double sum = 0; int n = 0;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const float dx = float(x - w / 2), dy = float(y - h / 2);
      const float r = std::sqrt(dx * dx + dy * dy) / w;
      if (r < 0.12f || r > 0.20f) continue;
      sum += img.At(x, y)[0] - img.At(x, y)[2];
      ++n;
    }
  }
  return n ? (sum / n) * 255.0 : 0.0;
}

int main() {
  std::printf("Red bleed around a highlight (code values), 512x512\n");
  std::printf("%-22s %-10s %-10s %-10s\n", "stock", "slider 0", "slider 0.5", "slider 2");

  struct Entry { const char* name; seed::Stock stock; };
  Entry entries[] = {
      {"kodak_5217 (show)", seed::Kodak5217()},
      {"vision3_500t", seed::Vision3_500T()},
  };

  for (auto& e : entries) {
    double out[3];
    const float sliders[3] = {0.0f, 0.5f, 2.0f};
    for (int i = 0; i < 3; ++i) {
      seed::Config cfg;
      cfg.grain_enable = false; cfg.grain_scale = 0;
      cfg.distortion_k1 = cfg.distortion_k2 = cfg.ca_lateral = 0;
      cfg.vignette = cfg.vignette_mech = 0; cfg.glare_intensity = 0;
      cfg.wp_tonemap = 0; cfg.exposure = 1;

      // What the plugin now does: the slider is the absolute strength.
      seed::Stock stock = e.stock;
      if (stock.halation > 0.0f) {
        cfg.halation_scale = sliders[i] / stock.halation;
      } else {
        stock.halation = 1.0f;
        cfg.halation_scale = sliders[i];
      }

      seed::Image img = Disc(512, 512);
      seed::ApplyFilmLook(img, cfg, stock, 0);
      out[i] = RedBleed(img);
    }
    std::printf("%-22s %-10.2f %-10.2f %-10.2f\n", e.name, out[0], out[1], out[2]);
  }
  return 0;
}
