// Parity between the C++ core and the TypeScript engine.
//
// Two implementations of one look is a promise to keep them identical. This is
// how the promise is kept: the vectors are generated from the engine that has
// the golden config behind it, and this runs the same picture through the port
// and compares every float.
//
// A minimal JSON reader is inlined rather than pulled in as a dependency —
// the file is written by our own script and has a known shape, and a plugin
// build should not acquire a package manager to run its tests.
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "../src/core/look.h"

namespace {

std::string ReadFile(const char* path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    std::fprintf(stderr, "could not open %s\n", path);
    std::exit(2);
  }
  std::ostringstream buffer;
  buffer << in.rdbuf();
  return buffer.str();
}

// Reads the numbers of one "key": [ ... ] array. Enough for a file we write.
std::vector<float> ReadArray(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\":[";
  const std::size_t start = json.find(needle);
  if (start == std::string::npos) {
    std::fprintf(stderr, "missing key %s\n", key.c_str());
    std::exit(2);
  }
  std::size_t i = start + needle.size();
  std::vector<float> out;
  std::string token;
  for (; i < json.size() && json[i] != ']'; ++i) {
    const char c = json[i];
    if (c == ',') {
      if (!token.empty()) out.push_back(std::stof(token));
      token.clear();
    } else {
      token.push_back(c);
    }
  }
  if (!token.empty()) out.push_back(std::stof(token));
  return out;
}

int ReadInt(const std::string& json, const std::string& key) {
  const std::string needle = "\"" + key + "\":";
  const std::size_t start = json.find(needle);
  if (start == std::string::npos) return 0;
  return std::atoi(json.c_str() + start + needle.size());
}

int failures = 0;

void Check(bool condition, const char* what) {
  if (condition) {
    std::printf("  ok    %s\n", what);
  } else {
    std::printf("  FAIL  %s\n", what);
    ++failures;
  }
}

}  // namespace

int main(int argc, char** argv) {
  const char* path =
      argc > 1 ? argv[1] : "plugins/seed-film-look/test/vectors.json";
  const std::string json = ReadFile(path);

  const int width = ReadInt(json, "width");
  const int height = ReadInt(json, "height");
  const int frame = ReadInt(json, "frame");
  const std::vector<float> source = ReadArray(json, "source");
  const std::vector<float> expected = ReadArray(json, "expected");
  const std::vector<float> srgb = ReadArray(json, "srgbToLinear");
  const std::vector<float> whitepoint = ReadArray(json, "whitepoint");

  std::printf("SEED film look — C++ core parity (%dx%d, frame %d)\n", width,
              height, frame);

  // --- scalars ------------------------------------------------------------
  {
    const float inputs[4] = {0.02f, 0.18f, 0.5f, 1.0f};
    float worst = 0.0f;
    for (std::size_t i = 0; i < srgb.size(); ++i) {
      worst = std::max(worst, std::fabs(seed::SrgbToLinear(inputs[i]) - srgb[i]));
    }
    Check(worst < 1e-6f, "sRGB transfer matches");
  }
  {
    const float inputs[4] = {0.1f, 0.18f, 0.5f, 0.9167f};
    float worst = 0.0f;
    for (std::size_t i = 0; i < whitepoint.size(); ++i) {
      const float got =
          seed::WhitepointTonemap(inputs[i], 1.2f, 1.1f, 0.937f, 1.0f);
      worst = std::max(worst, std::fabs(got - whitepoint[i]));
    }
    Check(worst < 1e-6f, "whitepoint tonemap matches");
  }

  // --- the whole chain ----------------------------------------------------
  seed::Image image(width, height);
  image.data.assign(source.begin(), source.end());

  seed::Config config;  // defaults are the show preset at intensity 1
  const seed::Stock stock = seed::Kodak5217();
  seed::ApplyFilmLook(image, config, stock, frame);

  if (image.data.size() != expected.size()) {
    std::printf("  FAIL  size %zu != %zu\n", image.data.size(), expected.size());
    return 1;
  }

  double total = 0.0;
  float worst = 0.0f;
  std::size_t worstIndex = 0;
  for (std::size_t i = 0; i < expected.size(); ++i) {
    const float diff = std::fabs(image.data[i] - expected[i]);
    if (diff > worst) {
      worst = diff;
      worstIndex = i;
    }
    total += diff;
  }
  const double mean = total / double(expected.size());

  std::printf("  mean |diff| %.8f, worst %.8f at index %zu (got %.6f, want %.6f)\n",
              mean, worst, worstIndex, image.data[worstIndex],
              expected[worstIndex]);

  // Float arithmetic in two languages will not agree bit for bit — the
  // grain hash, the powers and the box-blur accumulations all round
  // differently. Half a code value at 8-bit is the bar that matters, because
  // that is the point below which no output format can tell them apart.
  Check(worst < 1.0f / 512.0f, "every pixel within half a code value");
  Check(mean < 1.0f / 4096.0f, "mean difference far below a code value");

  std::printf(failures == 0 ? "\nPASS\n" : "\nFAILED (%d)\n", failures);
  return failures == 0 ? 0 : 1;
}
