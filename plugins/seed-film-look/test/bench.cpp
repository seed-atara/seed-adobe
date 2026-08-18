/*
 * Where the film look actually spends its time, at a real resolution.
 *
 * The plugin is slow enough in Premiere to be unusable while scrubbing, and
 * the notes record roughly 3.4s for a 1080p frame — but not *which* stage.
 * Optimising without that number is guessing, and the two obvious suspects
 * (the blurs, the grain) are not obviously the answer: the blurs are already
 * box approximations rather than true Gaussians.
 */
#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "../src/core/look.h"

using Clock = std::chrono::steady_clock;

static double MsSince(Clock::time_point start) {
  return std::chrono::duration<double, std::milli>(Clock::now() - start).count();
}

int main(int argc, char** argv) {
  const int width = argc > 1 ? std::atoi(argv[1]) : 1920;
  const int height = argc > 2 ? std::atoi(argv[2]) : 1080;
  const int runs = argc > 3 ? std::atoi(argv[3]) : 3;

  seed::Image source(width, height);
  // Something with structure, so the blurs and grain have real work to do.
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      float* p = source.At(x, y);
      p[0] = float(x) / float(width);
      p[1] = float(y) / float(height);
      p[2] = 0.5f * (p[0] + p[1]);
      p[3] = 1.0f;
    }
  }

  seed::Config config;
  seed::Stock stock;

  printf("%dx%d, %d run(s)\n\n", width, height, runs);

  double total = 0.0;
  double phaseA = 0.0;
  double phaseB = 0.0;

  for (int run = 0; run < runs; ++run) {
    seed::Image a = source;
    Clock::time_point t = Clock::now();
    seed::ApplyPhaseA(a, config, stock);
    phaseA += MsSince(t);

    t = Clock::now();
    seed::ApplyPhaseB(a, config, stock, run);
    phaseB += MsSince(t);
  }
  total = phaseA + phaseB;

  printf("phase A (optical)   %8.1f ms/frame\n", phaseA / runs);
  printf("phase B (grain etc) %8.1f ms/frame\n", phaseB / runs);
  printf("-----------------------------------\n");
  printf("total               %8.1f ms/frame\n", total / runs);
  printf("\n%.2f s for 10s at 24fps\n", (total / runs) * 240.0 / 1000.0);
  return 0;
}
