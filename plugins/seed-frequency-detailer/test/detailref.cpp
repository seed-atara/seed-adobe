/*
 * The core's answer for a given pair, as a file.
 *
 * Exists so the After Effects glue can be graded against something rather than
 * looked at. The core is tested; the glue — world conversion, parameter
 * reading, the layer checkout, premultiply — is not, and cannot be from here.
 * Rendering the same input both ways and differencing them is the only way to
 * find out whether the plugin computes what the core computes.
 *
 *   detailref plate.raw target.raw out.raw WIDTH HEIGHT [name=value ...]
 *
 * Raw is headerless 8-bit RGBA, width*height*4 bytes, straight alpha. No PNG
 * codec here on purpose: adding one to the C++ side would be a second image
 * decoder in the repository, and scripts/detail-test.ts already has one.
 */
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../src/core/detail.h"

namespace {

bool ReadRaw(const char* path, int width, int height, seed::Image& out) {
  std::FILE* file = std::fopen(path, "rb");
  if (!file) return false;
  const std::size_t count = std::size_t(width) * height * 4;
  std::vector<unsigned char> bytes(count);
  const std::size_t read = std::fread(bytes.data(), 1, count, file);
  std::fclose(file);
  if (read != count) return false;

  out = seed::Image(width, height);
  for (std::size_t i = 0; i < count; ++i) out.data[i] = bytes[i] / 255.0f;
  return true;
}

bool WriteRaw(const char* path, const seed::Image& image) {
  std::FILE* file = std::fopen(path, "wb");
  if (!file) return false;
  std::vector<unsigned char> bytes(image.data.size());
  for (std::size_t i = 0; i < image.data.size(); ++i) {
    const float v = seed::Clamp01(image.data[i]);
    bytes[i] = (unsigned char)(v * 255.0f + 0.5f);
  }
  const std::size_t wrote = std::fwrite(bytes.data(), 1, bytes.size(), file);
  std::fclose(file);
  return wrote == bytes.size();
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 6) {
    std::fprintf(stderr,
                 "usage: detailref plate.raw target.raw out.raw W H "
                 "[radius=0.004 gain=1 replace=0.7 luma=1 linear=1 "
                 "shadow=0.02 highlight=0.3 limit=4 guard=0.5 tolerance=0.3 "
                 "showguard=0 mix=1]\n");
    return 2;
  }

  const int width = std::atoi(argv[4]);
  const int height = std::atoi(argv[5]);

  seed::Image plate;
  seed::Image target;
  if (!ReadRaw(argv[1], width, height, plate)) {
    std::fprintf(stderr, "could not read %s\n", argv[1]);
    return 1;
  }
  if (!ReadRaw(argv[2], width, height, target)) {
    std::fprintf(stderr, "could not read %s\n", argv[2]);
    return 1;
  }

  seed::DetailConfig config;
  for (int i = 6; i < argc; ++i) {
    const std::string arg = argv[i];
    const std::size_t eq = arg.find('=');
    if (eq == std::string::npos) continue;
    const std::string key = arg.substr(0, eq);
    const float value = float(std::atof(arg.c_str() + eq + 1));

    if (key == "radius") config.radiusFraction = value;
    else if (key == "gain") config.gain = value;
    else if (key == "replace") config.replace = value;
    else if (key == "luma") config.lumaOnly = value != 0.0f;
    else if (key == "linear") config.linearSpace = value != 0.0f;
    else if (key == "shadow") config.shadowFloor = value;
    else if (key == "highlight") config.highlightRolloff = value;
    else if (key == "limit") config.detailLimit = value;
    else if (key == "guard") config.structureGuard = value;
    else if (key == "tolerance") config.guardTolerance = value;
    else if (key == "showguard") config.showGuard = value != 0.0f;
    else if (key == "mix") config.mix = value;
    else std::fprintf(stderr, "ignoring unknown setting %s\n", key.c_str());
  }

  seed::ApplyFrequencyDetail(target, plate, config);

  if (!WriteRaw(argv[3], target)) {
    std::fprintf(stderr, "could not write %s\n", argv[3]);
    return 1;
  }
  return 0;
}
