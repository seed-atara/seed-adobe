#include "SeedFilmLook.h"

#include <atomic>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "../core/look.h"

/*
 * Premiere hosts After Effects effects, and hands them a different pixel
 * buffer than After Effects does. Its native formats are BGRA and VUYA; it
 * never gives an effect the ARGB this plugin was written against. Read a BGRA
 * frame as ARGB and red and blue swap; read a VUYA frame as ARGB and you get
 * luma and chroma interpreted as colour, which is the black and the flicker.
 *
 * These headers ship with the After Effects SDK and declare the suite that
 * lets an effect say which formats it will accept, so Premiere converts once
 * rather than handing over whatever it happens to be holding.
 */
#include "PrSDKAESupport.h"
#include "PrSDKPixelFormat.h"

namespace {
/** Premiere's application id, as it arrives in PF_InData::appl_id. */
constexpr A_long kPremiereApplId = kAppID_Premiere;

bool HostIsPremiere(const PF_InData* in_data) {
  return in_data && in_data->appl_id == kPremiereApplId;
}

/*
 * A diagnostic log, because a plugin cannot be stepped through inside a host
 * and guessing at what Premiere hands over has already been wrong twice.
 *
 * Always on, and bounded rather than switched: a diagnostic that needs an
 * environment variable set before the host launches is a diagnostic nobody
 * runs, and this one exists precisely because the failure is only reproducible
 * inside Premiere. The cap keeps an always-on log from being a liability —
 * enough lines to see a pattern across a scrub, then silence forever.
 *
 * Writes to %TEMP%\seed-film-look.log, appended, one line per event. Delete
 * the file to start a fresh capture; the cap resets when the host restarts.
 */
constexpr int kLogLineLimit = 400;

void SeedLog(const char* format, ...) {
  static std::atomic<int> written{0};
  if (written.fetch_add(1) >= kLogLineLimit) return;

  const char* temp = std::getenv("TEMP");
  if (!temp) return;
  std::string path(temp);
  path += "\\seed-film-look.log";

  FILE* file = nullptr;
  if (fopen_s(&file, path.c_str(), "a") != 0 || !file) return;
  va_list args;
  va_start(args, format);
  vfprintf(file, format, args);
  va_end(args);
  fputc('\n', file);
  fclose(file);
}

/** A FourCC as four readable characters, for the log. */
std::string FourCC(unsigned long value) {
  char text[5] = {char((value >> 24) & 0xff), char((value >> 16) & 0xff),
                  char((value >> 8) & 0xff), char(value & 0xff), 0};
  for (int i = 0; i < 4; ++i) {
    if (text[i] < 32 || text[i] > 126) text[i] = '.';
  }
  return std::string(text);
}
}  // namespace

/*
 * The resource and this file must announce the same version or After Effects
 * refuses to load the effect with error 8001. Both derive from
 * SeedFilmLookVersion.h; this proves the hand-packed value the resource has to
 * use is identical to what PF_VERSION produces.
 */
static_assert(SEED_VERSION_PACKED ==
                  PF_VERSION(SEED_MAJOR_VERSION, SEED_MINOR_VERSION,
                             SEED_BUG_VERSION, SEED_STAGE_VERSION,
                             SEED_BUILD_VERSION),
              "PiPL version and code version must match, or AE reports 8001");

namespace {

// ---------------------------------------------------------------- presets

// The presets, resolved. These mirror packages/filmlook/src/presets.ts, and the
// intensity layer is the nine camera-artefact values *as authored* — the
// Intensity control scales these and nothing else, so the look can never drift
// while an artist decides how much camera they want.
struct Preset {
  seed::Config look;
  seed::Stock stock;
};

Preset PresetFor(A_long choice) {
  Preset p;
  p.stock = seed::Kodak5217();

  switch (choice) {
    case PRESET_CLEAN_OPTICS:
      // The honest base: no stock character, no tonemap, no artefacts.
      p.look.wp_tonemap = 0.0f;
      p.look.tonemap = 0.0f;
      p.look.grain_enable = false;
      p.look.grain_scale = 0.0f;
      p.look.ca_lateral = 0.0f;
      p.look.vignette = 0.0f;
      p.look.vignette_mech = 0.0f;
      p.look.halation_scale = 0.0f;
      p.look.glare_intensity = 0.0f;
      p.look.distortion_k1 = 0.0f;
      p.look.distortion_k2 = 0.0f;
      p.look.exposure = 1.0f;
      break;

    case PRESET_TUNGSTEN_500T:
      p.stock = seed::Vision3_500T();
      p.look.exposure = 1.0f;
      p.look.wp_tonemap = 0.0f;
      p.look.grain_scale = 1.0f;
      p.look.grain_size = 0.3f;
      p.look.grain_chroma = 0.6f;
      p.look.grain_ref_longedge = 0;
      p.look.ca_lateral = 0.0018f;
      p.look.vignette = 0.3f;
      p.look.vignette_mech = 0.1f;
      p.look.halation_scale = 1.0f;
      p.look.halation_color = 0.0f;
      p.look.glare_intensity = 0.1f;
      p.look.distortion_k1 = -0.015f;
      p.look.distortion_k2 = 0.004f;
      break;

    case PRESET_PRINT_2383: {
      seed::Stock print{};
      print.matrix[0][0] = 1.06f; print.matrix[0][1] = 0.0f;  print.matrix[0][2] = -0.06f;
      print.matrix[1][0] = -0.02f; print.matrix[1][1] = 1.04f; print.matrix[1][2] = -0.02f;
      print.matrix[2][0] = -0.04f; print.matrix[2][1] = -0.02f; print.matrix[2][2] = 1.08f;
      print.saturation = 1.08f;
      print.black_lift = 0.012f;
      print.white_rolloff = 0.88f;
      print.contrast = 1.12f;
      print.pivot = 0.44f;
      print.grain_rms[0] = 0.008f; print.grain_rms[1] = 0.01f; print.grain_rms[2] = 0.014f;
      print.grain_size = 1.0f;
      print.grain_size_mul[0] = 1.0f; print.grain_size_mul[1] = 1.0f;
      print.grain_size_mul[2] = 1.0f;
      print.halation = 0.4f;
      print.warmth = 0.04f;
      p.stock = print;
      p.look.exposure = 1.0f;
      p.look.wp_tonemap = 0.0f;
      p.look.grain_scale = 1.0f;
      p.look.grain_size = 0.3f;
      p.look.grain_chroma = 0.6f;
      p.look.grain_ref_longedge = 0;
      p.look.vignette = 0.3f;
      p.look.vignette_mech = 0.1f;
      p.look.halation_scale = 1.0f;
      break;
    }

    case PRESET_SHOW_MATCH:
    default:
      // seed::Config already defaults to the show preset at intensity 1.
      break;
  }
  return p;
}

// ------------------------------------------------------------ pixel bridge

// After Effects hands over a PF_EffectWorld: a rectangle of pixels with its own
// rowbytes, which is not the same as width * pixel size. Copying through the
// core's own buffer rather than processing in place is deliberate — the chain
// gathers from neighbours in several stages, so it needs a stable source that
// is not being written to underneath it.
/*
 * Whether the frame is laid out B,G,R,A rather than After Effects' A,R,G,B.
 *
 * PF_Pixel8's members are named for After Effects' order, so under Premiere
 * `.red` reads the blue byte and `.blue` reads the red one. Rather than
 * reinterpret the struct, the two colour channels are swapped on the way in
 * and again on the way out — the arithmetic in between never has to know.
 */
seed::Image WorldToImage8(const PF_EffectWorld& world, bool bgra) {
  seed::Image image(world.width, world.height);
  for (int y = 0; y < world.height; ++y) {
    const PF_Pixel8* row = reinterpret_cast<const PF_Pixel8*>(
        reinterpret_cast<const char*>(world.data) + y * world.rowbytes);
    for (int x = 0; x < world.width; ++x) {
      float* out = image.At(x, y);
      out[0] = (bgra ? row[x].blue : row[x].red) / 255.0f;
      out[1] = row[x].green / 255.0f;
      out[2] = (bgra ? row[x].red : row[x].blue) / 255.0f;
      out[3] = row[x].alpha / 255.0f;
    }
  }
  return image;
}

seed::Image WorldToImage16(const PF_EffectWorld& world, bool bgra) {
  seed::Image image(world.width, world.height);
  for (int y = 0; y < world.height; ++y) {
    const PF_Pixel16* row = reinterpret_cast<const PF_Pixel16*>(
        reinterpret_cast<const char*>(world.data) + y * world.rowbytes);
    for (int x = 0; x < world.width; ++x) {
      float* out = image.At(x, y);
      // 16-bit in After Effects is 0..32768, not 0..65535.
      out[0] = (bgra ? row[x].blue : row[x].red) / float(PF_MAX_CHAN16);
      out[1] = row[x].green / float(PF_MAX_CHAN16);
      out[2] = (bgra ? row[x].red : row[x].blue) / float(PF_MAX_CHAN16);
      out[3] = row[x].alpha / float(PF_MAX_CHAN16);
    }
  }
  return image;
}

seed::Image WorldToImage32(const PF_EffectWorld& world, bool bgra) {
  seed::Image image(world.width, world.height);
  for (int y = 0; y < world.height; ++y) {
    const PF_PixelFloat* row = reinterpret_cast<const PF_PixelFloat*>(
        reinterpret_cast<const char*>(world.data) + y * world.rowbytes);
    for (int x = 0; x < world.width; ++x) {
      float* out = image.At(x, y);
      out[0] = bgra ? row[x].blue : row[x].red;
      out[1] = row[x].green;
      out[2] = bgra ? row[x].red : row[x].blue;
      out[3] = row[x].alpha;
    }
  }
  return image;
}

inline A_u_char To8(float v) {
  const float c = seed::Clamp01(v);
  return A_u_char(c * 255.0f + 0.5f);
}

inline A_u_short To16(float v) {
  const float c = seed::Clamp01(v);
  return A_u_short(c * float(PF_MAX_CHAN16) + 0.5f);
}

void ImageToWorld(const seed::Image& image, PF_EffectWorld& world, int depth,
                  bool bgra) {
  for (int y = 0; y < world.height && y < image.height; ++y) {
    char* rowStart = reinterpret_cast<char*>(world.data) + y * world.rowbytes;
    for (int x = 0; x < world.width && x < image.width; ++x) {
      const float* in = image.At(x, y);
      if (depth == 32) {
        PF_PixelFloat* row = reinterpret_cast<PF_PixelFloat*>(rowStart);
        row[x].red = bgra ? in[2] : in[0];
        row[x].green = in[1];
        row[x].blue = bgra ? in[0] : in[2];
        row[x].alpha = in[3];
      } else if (depth == 16) {
        PF_Pixel16* row = reinterpret_cast<PF_Pixel16*>(rowStart);
        row[x].red = To16(bgra ? in[2] : in[0]);
        row[x].green = To16(in[1]);
        row[x].blue = To16(bgra ? in[0] : in[2]);
        row[x].alpha = To16(in[3]);
      } else {
        PF_Pixel8* row = reinterpret_cast<PF_Pixel8*>(rowStart);
        row[x].red = To8(bgra ? in[2] : in[0]);
        row[x].green = To8(in[1]);
        row[x].blue = To8(bgra ? in[0] : in[2]);
        row[x].alpha = To8(in[3]);
      }
    }
  }
}

// ------------------------------------------------------------------ params

PF_Err About(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* [],
             PF_LayerDef*) {
  PF_SPRINTF(out_data->return_msg,
             "SEED Film Look v%d.%d\r\r"
             "The film look, applied as specified: optics in scene-linear, "
             "film and grade in display space, grain last.\r\r"
             "The tonal half is also available as a .cube from the SEED "
             "panel; this is the half a lookup cannot carry.",
             MAJOR_VERSION, MINOR_VERSION);
  return PF_Err_NONE;
}

PF_Err GlobalSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* [],
                   PF_LayerDef*) {
  out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION,
                                    STAGE_VERSION, BUILD_VERSION);

  out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE | PF_OutFlag_USE_OUTPUT_EXTENT;

  /*
   * Deliberately NOT PF_OutFlag_PIX_INDEPENDENT. Several stages here — the
   * distortion gather, every blur, grain's clumping — read neighbouring
   * pixels, so a pixel's result is not independent of the ones around it.
   * Claiming otherwise would let After Effects split the frame into tiles and
   * render them separately, and the seams would show at every tile boundary.
   */
  out_data->out_flags2 = PF_OutFlag2_SUPPORTS_SMART_RENDER |
                         PF_OutFlag2_FLOAT_COLOR_AWARE |
                         PF_OutFlag2_SUPPORTS_THREADED_RENDERING |
                         PF_OutFlag2_PARAM_GROUP_START_COLLAPSED_FLAG;

  /*
   * Tell Premiere what we can actually read.
   *
   * Without this it supplies whatever suits its pipeline — usually VUYA, which
   * is YUV. This effect works in RGB, so a VUYA frame read as colour produces
   * black frames and flicker, and a BGRA frame read as ARGB swaps red and
   * blue. Declaring BGRA makes Premiere do the conversion, once, correctly.
   *
   * 32f is listed first because it is what Premiere prefers in a float
   * sequence and what keeps values above nominal white; 8u is the fallback.
   * VUYA is deliberately never listed.
   *
   * After Effects ignores all of this — the suite is absent there, and the
   * scoper simply yields nothing.
   */
  SeedLog("GlobalSetup: appl_id=%s premiere=%d", FourCC(in_data->appl_id).c_str(),
          HostIsPremiere(in_data) ? 1 : 0);

  if (HostIsPremiere(in_data)) {
    AEFX_SuiteScoper<PF_PixelFormatSuite1> pixelFormatSuite =
        AEFX_SuiteScoper<PF_PixelFormatSuite1>(in_data, kPFPixelFormatSuite,
                                               kPFPixelFormatSuiteVersion1,
                                               out_data);
    if (pixelFormatSuite.operator->() != nullptr) {
      PF_Err clearErr =
          pixelFormatSuite->ClearSupportedPixelFormats(in_data->effect_ref);
      PF_Err add32 = pixelFormatSuite->AddSupportedPixelFormat(
          in_data->effect_ref, PrPixelFormat_BGRA_4444_32f);
      PF_Err add8 = pixelFormatSuite->AddSupportedPixelFormat(
          in_data->effect_ref, PrPixelFormat_BGRA_4444_8u);
      SeedLog("GlobalSetup: declared formats clear=%d bgra32f=%d bgra8u=%d",
              int(clearErr), int(add32), int(add8));
    } else {
      SeedLog("GlobalSetup: PF_PixelFormatSuite unavailable");
    }
  }

  return PF_Err_NONE;
}

PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* [],
                   PF_LayerDef*) {
  PF_Err err = PF_Err_NONE;
  PF_ParamDef def;

  AEFX_CLR_STRUCT(def);
  PF_ADD_POPUP("Look", 4, PRESET_SHOW_MATCH, SEED_PRESET_CHOICES, PRESET_DISK_ID);

  /*
   * 0 to 2, defaulting to 1. One is the preset as authored, and 0 turns every
   * camera artefact off — which is the correct setting for footage that
   * already has real grain, vignetting or distortion of its own. Doubling
   * those is the classic tell.
   */
  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Intensity", 0, 2, 0, 2, 1,
                       PF_Precision_HUNDREDTHS, 0, 0, INTENSITY_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Optics", OPTICS_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Distortion", -0.1f, 0.1f, -0.05f, 0.05f, -0.0075f,
                       PF_Precision_TEN_THOUSANDTHS, 0, 0, DISTORTION_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Chromatic aberration", 0, 0.02f, 0, 0.01f, 0.0015f,
                       PF_Precision_TEN_THOUSANDTHS, 0, 0, CA_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Vignette", 0, 1, 0, 0.6f, 0.15f,
                       PF_Precision_HUNDREDTHS, 0, 0, VIGNETTE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(OPTICS_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Film", FILM_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Exposure", 0.25f, 4, 0.5f, 2, 0.97f,
                       PF_Precision_HUNDREDTHS, 0, 0, EXPOSURE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Tonemap", 0, 1, 0, 1, 1,
                       PF_Precision_HUNDREDTHS, 0, 0, WP_TONEMAP_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Halation", 0, 2, 0, 2, 0.5f,
                       PF_Precision_HUNDREDTHS, 0, 0, HALATION_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(FILM_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Grain", GRAIN_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Amount", 0, 3, 0, 2, 0.5f,
                       PF_Precision_HUNDREDTHS, 0, 0, GRAIN_AMOUNT_DISK_ID);

  // Smaller is finer. In pixels — the one spatial value in the whole chain
  // that is not a fraction of the diagonal.
  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Size", 0, 4, 0, 2, 0.5f,
                       PF_Precision_HUNDREDTHS, 0, 0, GRAIN_SIZE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_SLIDER("Seed", 0, 9999, 0, 100, 7, GRAIN_SEED_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(GRAIN_END_DISK_ID);

  out_data->num_params = SEED_NUM_PARAMS;
  return err;
}

// Reads the controls into a resolved config, applying the intensity rule: it
// scales the camera artefacts and never the look.
seed::Config ConfigFromParams(PF_ParamDef* params[], Preset& preset) {
  preset = PresetFor(params[SEED_PRESET]->u.pd.value);
  seed::Config config = preset.look;

  const float intensity = float(params[SEED_INTENSITY]->u.fs_d.value);

  config.exposure = float(params[SEED_EXPOSURE]->u.fs_d.value);
  config.wp_tonemap = float(params[SEED_WP_TONEMAP]->u.fs_d.value);

  config.distortion_k1 = float(params[SEED_DISTORTION]->u.fs_d.value) * intensity;
  config.distortion_k2 = config.distortion_k1 * -0.2667f;  // the preset's ratio
  config.ca_lateral = float(params[SEED_CA]->u.fs_d.value) * intensity;
  config.vignette = float(params[SEED_VIGNETTE]->u.fs_d.value) * intensity;
  config.vignette_mech = config.vignette / 3.0f;
  /*
   * Halation is an absolute strength here, not a multiple of the stock's own.
   *
   * The engine computes `stock.halation * halation_scale`, because halation is
   * a property of an emulsion that the artist then dials. That is right for a
   * recipe and wrong for a control: kodak_5217 — the show stock, and the
   * default preset — has halation 0, so the slider was multiplied by nothing
   * and did exactly nothing, on the one preset most people will use.
   *
   * So the slider states the strength it wants and this expresses it through
   * the engine's model. Worth knowing: it means the plugin's Show match can
   * halate where the bake's cannot, because the bake follows the recipe.
   */
  const float halation = float(params[SEED_HALATION]->u.fs_d.value) * intensity;
  if (preset.stock.halation > 0.0f) {
    config.halation_scale = halation / preset.stock.halation;
  } else {
    preset.stock.halation = 1.0f;
    config.halation_scale = halation;
  }

  // Clean optics means clean: no stock character and no artefacts, whatever
  // the sliders happen to be left at.
  if (params[SEED_PRESET]->u.pd.value == PRESET_CLEAN_OPTICS) {
    config.halation_scale = 0.0f;
  }

  config.glare_intensity = preset.look.glare_intensity * intensity;

  config.grain_scale = float(params[SEED_GRAIN_AMOUNT]->u.fs_d.value) * intensity;
  config.grain_size = float(params[SEED_GRAIN_SIZE]->u.fs_d.value);
  config.seed = int(params[SEED_GRAIN_SEED]->u.sd.value);

  return config;
}

// ------------------------------------------------------------------ render

PF_Err PreRender(PF_InData* in_data, PF_OutData* out_data,
                 PF_PreRenderExtra* extra) {
  /*
   * Logged because a failure here is silent and total: SmartFX will not call
   * SMART_RENDER if pre-render errors, and an effect that never renders leaves
   * the output world untouched — which looks exactly like the garbage this
   * whole investigation started with.
   */
  SeedLog("prerender: enter");
  PF_Err err = PF_Err_NONE;
  PF_RenderRequest req = extra->input->output_request;
  PF_CheckoutResult in_result;

  /*
   * The whole input, not the requested rectangle.
   *
   * Every gather in this chain is measured from the frame's own centre and
   * diagonal — the distortion, the vignette, every radius. Handed a tile, it
   * would compute a different centre and a different diagonal for each one and
   * the result would be a grid of slightly different looks. Asking for the
   * full extent is what keeps one frame one image.
   */
  req.preserve_rgb_of_zero_alpha = TRUE;

  ERR(extra->cb->checkout_layer(in_data->effect_ref, SEED_INPUT, SEED_INPUT,
                                &req, in_data->current_time,
                                in_data->time_step, in_data->time_scale,
                                &in_result));

  if (!err) {
    UnionLRect(&in_result.result_rect, &extra->output->result_rect);
    UnionLRect(&in_result.max_result_rect, &extra->output->max_result_rect);
  }
  SeedLog("prerender: exit err=%d", int(err));
  return err;
}

/**
 * The look itself, on a pair of worlds.
 *
 * Shared because there are two ways in. After Effects calls SmartFX; Premiere
 * calls the *legacy* PF_Cmd_RENDER, and there was no case for it — so the
 * effect returned success having never written the output world, and what
 * reached the screen was whatever happened to be in that buffer. That is the
 * flicker: teal on one frame, grey on the next, black on another, all of it
 * uninitialised memory rather than anything this code computed.
 */
PF_Err ApplyToWorlds(PF_InData* in_data, PF_OutData* out_data,
                     PF_ParamDef* paramPtrs[], PF_EffectWorld* input_worldP,
                     PF_EffectWorld* output_worldP, const char* via) {
  PF_Err err = PF_Err_NONE;
  if (!input_worldP || !output_worldP) return err;

  PF_PixelFormat format = PF_PixelFormat_ARGB32;
  AEFX_SuiteScoper<PF_WorldSuite2> worldSuite =
      AEFX_SuiteScoper<PF_WorldSuite2>(in_data, kPFWorldSuite,
                                       kPFWorldSuiteVersion2, out_data);
  worldSuite->PF_GetPixelFormat(input_worldP, &format);

  /*
   * Ask Premiere directly what this buffer is. PF_GetPixelFormat answers in
   * After Effects' vocabulary, which has no name for a Premiere format, so it
   * cannot tell BGRA from VUYA from ARGB on its own.
   */
  PrPixelFormat prFormat = PrPixelFormat_Invalid;
  bool prFormatKnown = false;
  if (HostIsPremiere(in_data)) {
    AEFX_SuiteScoper<PF_PixelFormatSuite1> pixelFormatSuite =
        AEFX_SuiteScoper<PF_PixelFormatSuite1>(in_data, kPFPixelFormatSuite,
                                               kPFPixelFormatSuiteVersion1,
                                               out_data);
    if (pixelFormatSuite.operator->() != nullptr &&
        pixelFormatSuite->GetPixelFormat(input_worldP, &prFormat) ==
            PF_Err_NONE) {
      prFormatKnown = true;
    }
  }

  const bool bgra = HostIsPremiere(in_data);

  int depth = 0;
  seed::Image image;
  if (prFormatKnown) {
    // Premiere's own answer wins where we have it.
    if (prFormat == PrPixelFormat_BGRA_4444_32f) {
      depth = 32;
      image = WorldToImage32(*input_worldP, true);
    } else if (prFormat == PrPixelFormat_BGRA_4444_8u) {
      depth = 8;
      image = WorldToImage8(*input_worldP, true);
    }
  } else {
    switch (format) {
      case PF_PixelFormat_ARGB128:
        depth = 32;
        image = WorldToImage32(*input_worldP, bgra);
        break;
      case PF_PixelFormat_ARGB64:
        depth = 16;
        image = WorldToImage16(*input_worldP, bgra);
        break;
      case PF_PixelFormat_ARGB32:
        depth = 8;
        image = WorldToImage8(*input_worldP, bgra);
        break;
      default:
        break;
    }
  }

  SeedLog("render(%s): ae=%d pr=%s known=%d depth=%d bgra=%d %dx%d rb=%d", via,
          int(format),
          prFormatKnown ? FourCC(static_cast<unsigned long>(prFormat)).c_str()
                        : "n/a",
          prFormatKnown ? 1 : 0, depth, bgra ? 1 : 0, int(input_worldP->width),
          int(input_worldP->height), int(input_worldP->rowbytes));

  if (depth == 0) {
    /*
     * A format we never agreed to read. Copy the frame through rather than
     * misinterpret it — and above all rather than leave the output world
     * untouched, which is what produced uninitialised garbage before.
     */
    ERR(PF_COPY(input_worldP, output_worldP, NULL, NULL));
    return err;
  }

  Preset preset;
  const seed::Config config = ConfigFromParams(paramPtrs, preset);

  /*
   * The frame number drives grain. Stable within a frame so it does not crawl
   * while an artist scrubs, and different between frames so it does not read
   * as dirt on the lens.
   */
  const int frame =
      int(in_data->current_time / (in_data->time_step ? in_data->time_step : 1));

  seed::ApplyFilmLook(image, config, preset.stock, frame);
  ImageToWorld(image, *output_worldP, depth, bgra);
  return err;
}

/**
 * The legacy render command, which is what Premiere actually calls.
 *
 * Parameters arrive already checked out in `params`, and the output world is
 * handed over directly — no checkout, no checkin, none of SmartFX's ceremony.
 */
PF_Err LegacyRender(PF_InData* in_data, PF_OutData* out_data,
                    PF_ParamDef* params[], PF_LayerDef* output) {
  return ApplyToWorlds(in_data, out_data, params, &params[SEED_INPUT]->u.ld,
                       output, "legacy");
}

PF_Err SmartRender(PF_InData* in_data, PF_OutData* out_data,
                   PF_SmartRenderExtra* extra) {
  PF_Err err = PF_Err_NONE;
  // ERR2 assigns into a variable of this name; it is how the SDK keeps a
  // cleanup failure from masking the error that actually mattered.
  PF_Err err2 = PF_Err_NONE;
  PF_EffectWorld* input_worldP = NULL;
  PF_EffectWorld* output_worldP = NULL;
  PF_ParamDef params[SEED_NUM_PARAMS];
  PF_ParamDef* paramPtrs[SEED_NUM_PARAMS];

  AEFX_CLR_STRUCT(params);
  for (int i = 0; i < SEED_NUM_PARAMS; ++i) paramPtrs[i] = &params[i];

  // Checked out the old-fashioned way: these are all static parameters, and
  // reading them here keeps the render honest about the time it is rendering.
  for (int i = SEED_PRESET; i < SEED_NUM_PARAMS && !err; ++i) {
    ERR(PF_CHECKOUT_PARAM(in_data, i, in_data->current_time, in_data->time_step,
                          in_data->time_scale, &params[i]));
  }

  ERR(extra->cb->checkout_layer_pixels(in_data->effect_ref, SEED_INPUT,
                                       &input_worldP));
  ERR(extra->cb->checkout_output(in_data->effect_ref, &output_worldP));

  if (!err) {
    ERR(ApplyToWorlds(in_data, out_data, paramPtrs, input_worldP, output_worldP,
                      "smart"));
  }

  // Always check in, whatever went wrong on the way here.
  for (int i = SEED_PRESET; i < SEED_NUM_PARAMS; ++i) {
    ERR2(PF_CHECKIN_PARAM(in_data, &params[i]));
  }
  if (input_worldP) {
    ERR2(extra->cb->checkin_layer_pixels(in_data->effect_ref, SEED_INPUT));
  }
  return err;
}

}  // namespace

extern "C" DllExport PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr, PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite* inSPBasicSuitePtr, const char* inHostName,
    const char* inHostVersion) {
  // The macro writes through a local of this name; the SDK's own examples
  // declare it exactly this way.
  PF_Err result = PF_Err_INVALID_CALLBACK;

  result = PF_REGISTER_EFFECT_EXT2(
      inPtr, inPluginDataCallBackPtr,
      "SEED Film Look",            // Name
      "ai.seedstudios.filmlook",   // Match Name — ours, permanently
      "SEED",                      // Category
      AE_RESERVED_INFO,            // Reserved Info
      "EffectMain",                // Entry point
      "https://github.com/seed-atara/seed-adobe");

  return result;
}

PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data,
                  PF_ParamDef* params[], PF_LayerDef* output, void* extra) {
  PF_Err err = PF_Err_NONE;
  try {
    /*
     * Every command, named. Two rounds of this bug were spent inferring which
     * entry points a host uses from what the picture looked like; the host will
     * simply say, if asked.
     */
    SeedLog("cmd=%d", int(cmd));

    switch (cmd) {
      case PF_Cmd_ABOUT:
        err = About(in_data, out_data, params, output);
        break;
      case PF_Cmd_GLOBAL_SETUP:
        err = GlobalSetup(in_data, out_data, params, output);
        break;
      case PF_Cmd_PARAMS_SETUP:
        err = ParamsSetup(in_data, out_data, params, output);
        break;
      case PF_Cmd_RENDER:
        // Premiere's path. Absent until now, which is the whole bug.
        err = LegacyRender(in_data, out_data, params, output);
        break;
      case PF_Cmd_SMART_PRE_RENDER:
        err = PreRender(in_data, out_data, (PF_PreRenderExtra*)extra);
        break;
      case PF_Cmd_SMART_RENDER:
        err = SmartRender(in_data, out_data, (PF_SmartRenderExtra*)extra);
        break;
      default:
        break;
    }
  } catch (PF_Err& thrown_err) {
    err = thrown_err;
  }
  return err;
}
