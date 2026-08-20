/*
 * SEED Frequency Detailer — the After Effects glue.
 *
 * The maths is in ../core/detail.cpp, free of Adobe headers so it can be
 * compiled and tested without the SDK. Everything here is plumbing: reading
 * parameters, converting worlds to float and back, and checking out the second
 * layer.
 *
 * After Effects only, for now. Premiere's support for layer parameters through
 * this API has not been measured, and declaring a detail source it cannot
 * supply would be worse than not offering the effect there at all.
 */
#include "AEConfig.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_EffectCBSuites.h"
#include "AE_EffectSuites.h"
#include "AE_EffectUI.h"
#include "AE_GeneralPlug.h"
#include "AE_Macros.h"
#include "AEFX_SuiteHelper.h"
#include "Param_Utils.h"
#include "Smart_Utils.h"
#include "String_Utils.h"
#include "entry.h"

#ifdef AE_OS_WIN
// Before Windows.h, always. It defines min and max as macros, which turns
// every std::max in the core into a syntax error several files away — and the
// error names the core, not the include that caused it.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

#include <algorithm>

#include "../core/detail.h"
#include "SeedFrequencyDetailerVersion.h"

#define MAJOR_VERSION SEED_MAJOR_VERSION
#define MINOR_VERSION SEED_MINOR_VERSION
#define BUG_VERSION SEED_BUG_VERSION
#define STAGE_VERSION SEED_STAGE_VERSION
#define BUILD_VERSION SEED_BUILD_VERSION

static_assert(SEED_VERSION_PACKED == PF_VERSION(MAJOR_VERSION, MINOR_VERSION,
                                                BUG_VERSION, STAGE_VERSION,
                                                BUILD_VERSION),
              "SEED_VERSION_PACKED disagrees with PF_VERSION of the same five "
              "numbers; After Effects would refuse the effect with error 8001");

// Parameter ids. The order here is the order in the Effect Controls panel.
// Topics occupy an index of their own at each end, which is why they are named
// rather than counted.
enum {
  SEED_INPUT = 0,
  SEED_SOURCE,

  SEED_SEPARATION_START,
  SEED_RADIUS,
  SEED_SPACE,
  SEED_SEPARATION_END,

  SEED_DETAIL_START,
  SEED_GAIN,
  SEED_REPLACE,
  SEED_CHANNELS,
  SEED_DETAIL_END,

  SEED_PROTECT_START,
  SEED_SHADOW,
  SEED_HIGHLIGHT,
  SEED_LIMIT,
  SEED_PROTECT_END,

  SEED_DRIFT_START,
  SEED_GUARD,
  SEED_TOLERANCE,
  SEED_SHOW_GUARD,
  SEED_DRIFT_END,

  SEED_MIX,
  SEED_NUM_PARAMS
};

// Disk ids are permanent: they are how a saved project finds its values again,
// so they may be added to but never reordered or reused.
enum {
  SOURCE_DISK_ID = 1,
  SEPARATION_START_DISK_ID,
  RADIUS_DISK_ID,
  SPACE_DISK_ID,
  SEPARATION_END_DISK_ID,
  DETAIL_START_DISK_ID,
  GAIN_DISK_ID,
  REPLACE_DISK_ID,
  CHANNELS_DISK_ID,
  DETAIL_END_DISK_ID,
  PROTECT_START_DISK_ID,
  SHADOW_DISK_ID,
  HIGHLIGHT_DISK_ID,
  LIMIT_DISK_ID,
  PROTECT_END_DISK_ID,
  DRIFT_START_DISK_ID,
  GUARD_DISK_ID,
  TOLERANCE_DISK_ID,
  SHOW_GUARD_DISK_ID,
  DRIFT_END_DISK_ID,
  MIX_DISK_ID
};

#define SPACE_CHOICES "Scene-linear|Display"
#define CHANNEL_CHOICES "Luma only|RGB"

namespace {

PF_Err About(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* [],
             PF_LayerDef*) {
  PF_SPRINTF(out_data->return_msg,
             "SEED Frequency Detailer v%d.%d\r\r"
             "Transfers high-frequency detail from a sharp plate onto a soft "
             "render, as a ratio rather than a difference — so it carries "
             "texture without carrying the plate's exposure.\r\r"
             "Set Detail source to the plate. Replace decides how much of the "
             "render's own detail is dropped first.",
             MAJOR_VERSION, MINOR_VERSION);
  return PF_Err_NONE;
}

PF_Err GlobalSetup(PF_InData*, PF_OutData* out_data, PF_ParamDef* [],
                   PF_LayerDef*) {
  out_data->my_version = PF_VERSION(MAJOR_VERSION, MINOR_VERSION, BUG_VERSION,
                                    STAGE_VERSION, BUILD_VERSION);

  out_data->out_flags = PF_OutFlag_DEEP_COLOR_AWARE | PF_OutFlag_USE_OUTPUT_EXTENT;

  /*
   * Deliberately NOT PF_OutFlag_PIX_INDEPENDENT. Two blurs and a gradient
   * comparison all read neighbouring pixels, so a pixel's result is not
   * independent of the ones around it — claiming otherwise would let After
   * Effects split the frame into tiles and the seams would show at every
   * boundary.
   */
  out_data->out_flags2 = PF_OutFlag2_SUPPORTS_SMART_RENDER |
                         PF_OutFlag2_FLOAT_COLOR_AWARE |
                         PF_OutFlag2_SUPPORTS_THREADED_RENDERING |
                         PF_OutFlag2_PARAM_GROUP_START_COLLAPSED_FLAG;

  return PF_Err_NONE;
}

PF_Err ParamsSetup(PF_InData* in_data, PF_OutData* out_data, PF_ParamDef* [],
                   PF_LayerDef*) {
  PF_Err err = PF_Err_NONE;
  PF_ParamDef def;

  AEFX_CLR_STRUCT(def);
  PF_ADD_LAYER("Detail source", PF_LayerDefault_NONE, SOURCE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Separation", SEPARATION_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  // A fraction of the frame diagonal, shown as a percentage, so a setting
  // found at 1440x1440 still means the same thing on a 5750x2818 plate.
  PF_ADD_FLOAT_SLIDERX("Radius", 0.05f, 5, 0.05f, 2, 0.4f,
                       PF_Precision_HUNDREDTHS, 0, 0, RADIUS_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_POPUP("Working space", 2, 1, SPACE_CHOICES, SPACE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(SEPARATION_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Detail", DETAIL_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Gain", 0, 4, 0, 2, 1, PF_Precision_HUNDREDTHS, 0, 0,
                       GAIN_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Replace render detail", 0, 1, 0, 1, 0.7f,
                       PF_Precision_HUNDREDTHS, 0, 0, REPLACE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_POPUP("Channels", 2, 1, CHANNEL_CHOICES, CHANNELS_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(DETAIL_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Protection", PROTECT_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Shadow floor", 0.001f, 0.2f, 0.001f, 0.1f, 0.02f,
                       PF_Precision_THOUSANDTHS, 0, 0, SHADOW_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Highlight rolloff", 0, 1, 0, 1, 0.3f,
                       PF_Precision_HUNDREDTHS, 0, 0, HIGHLIGHT_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Detail limit", 1, 8, 1, 8, 4, PF_Precision_HUNDREDTHS, 0,
                       0, LIMIT_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(PROTECT_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_TOPIC("Drift", DRIFT_START_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Structure guard", 0, 1, 0, 1, 0.5f,
                       PF_Precision_HUNDREDTHS, 0, 0, GUARD_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Tolerance", 0, 1, 0, 1, 0.3f, PF_Precision_HUNDREDTHS, 0,
                       0, TOLERANCE_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_CHECKBOXX("Show guard", FALSE, 0, SHOW_GUARD_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_END_TOPIC(DRIFT_END_DISK_ID);

  AEFX_CLR_STRUCT(def);
  PF_ADD_FLOAT_SLIDERX("Mix", 0, 1, 0, 1, 1, PF_Precision_HUNDREDTHS, 0, 0,
                       MIX_DISK_ID);

  out_data->num_params = SEED_NUM_PARAMS;
  return err;
}

// ------------------------------------------------------------------ worlds

/** Channel order within a pixel. After Effects hands over ARGB. */
struct ChannelOrder {
  int r, g, b, a;
};
constexpr ChannelOrder kArgb{1, 2, 3, 0};

int DepthOf(PF_InData* in_data, PF_OutData* out_data, PF_EffectWorld* world) {
  PF_PixelFormat format = PF_PixelFormat_ARGB32;
  AEFX_SuiteScoper<PF_WorldSuite2> worldSuite =
      AEFX_SuiteScoper<PF_WorldSuite2>(in_data, kPFWorldSuite,
                                       kPFWorldSuiteVersion2, out_data);
  worldSuite->PF_GetPixelFormat(world, &format);
  switch (format) {
    case PF_PixelFormat_ARGB128:
      return 32;
    case PF_PixelFormat_ARGB64:
      return 16;
    case PF_PixelFormat_ARGB32:
      return 8;
    default:
      return 0;
  }
}

seed::Image WorldToImage(const PF_EffectWorld& world, int depth) {
  const ChannelOrder order = kArgb;
  seed::Image image(world.width, world.height);
  for (int y = 0; y < world.height; ++y) {
    // rowbytes is signed; the arithmetic walks the right way on its own.
    const char* rowStart =
        reinterpret_cast<const char*>(world.data) + y * world.rowbytes;
    for (int x = 0; x < world.width; ++x) {
      float* out = image.At(x, y);
      if (depth == 32) {
        const float* px = reinterpret_cast<const float*>(rowStart) + x * 4;
        out[0] = px[order.r];
        out[1] = px[order.g];
        out[2] = px[order.b];
        out[3] = px[order.a];
      } else if (depth == 16) {
        const A_u_short* px =
            reinterpret_cast<const A_u_short*>(rowStart) + x * 4;
        // 16-bit in After Effects is 0..32768, not 0..65535.
        out[0] = px[order.r] / float(PF_MAX_CHAN16);
        out[1] = px[order.g] / float(PF_MAX_CHAN16);
        out[2] = px[order.b] / float(PF_MAX_CHAN16);
        out[3] = px[order.a] / float(PF_MAX_CHAN16);
      } else {
        const A_u_char* px = reinterpret_cast<const A_u_char*>(rowStart) + x * 4;
        out[0] = px[order.r] / 255.0f;
        out[1] = px[order.g] / 255.0f;
        out[2] = px[order.b] / 255.0f;
        out[3] = px[order.a] / 255.0f;
      }
    }
  }
  return image;
}

inline A_u_char To8(float v) {
  return A_u_char(seed::Clamp01(v) * 255.0f + 0.5f);
}
inline A_u_short To16(float v) {
  return A_u_short(seed::Clamp01(v) * float(PF_MAX_CHAN16) + 0.5f);
}

void ImageToWorld(const seed::Image& image, PF_EffectWorld& world, int depth) {
  const ChannelOrder order = kArgb;
  for (int y = 0; y < world.height && y < image.height; ++y) {
    char* rowStart = reinterpret_cast<char*>(world.data) + y * world.rowbytes;
    for (int x = 0; x < world.width && x < image.width; ++x) {
      const float* in = image.At(x, y);
      if (depth == 32) {
        // No clamp: values above nominal white are real and survive here.
        float* px = reinterpret_cast<float*>(rowStart) + x * 4;
        px[order.r] = in[0];
        px[order.g] = in[1];
        px[order.b] = in[2];
        px[order.a] = in[3];
      } else if (depth == 16) {
        A_u_short* px = reinterpret_cast<A_u_short*>(rowStart) + x * 4;
        px[order.r] = To16(in[0]);
        px[order.g] = To16(in[1]);
        px[order.b] = To16(in[2]);
        px[order.a] = To16(in[3]);
      } else {
        A_u_char* px = reinterpret_cast<A_u_char*>(rowStart) + x * 4;
        px[order.r] = To8(in[0]);
        px[order.g] = To8(in[1]);
        px[order.b] = To8(in[2]);
        px[order.a] = To8(in[3]);
      }
    }
  }
}

/*
 * Straight alpha, in and out.
 *
 * After Effects hands over premultiplied pixels. Blurring and dividing those
 * mixes the matte into the colour at every soft edge, so a detail transfer
 * would darken exactly where the layer fades out. Unpremultiplying first keeps
 * the colour meaning what it says it means.
 */
void Unpremultiply(seed::Image& image) {
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    const float a = image.data[i + 3];
    if (a <= 0.0f || a >= 1.0f) continue;
    image.data[i] /= a;
    image.data[i + 1] /= a;
    image.data[i + 2] /= a;
  }
}

void Premultiply(seed::Image& image) {
  for (std::size_t i = 0; i < image.data.size(); i += 4) {
    const float a = image.data[i + 3];
    if (a <= 0.0f || a >= 1.0f) continue;
    image.data[i] *= a;
    image.data[i + 1] *= a;
    image.data[i + 2] *= a;
  }
}

seed::DetailConfig ConfigFrom(PF_ParamDef* params[]) {
  seed::DetailConfig config;
  // The slider is a percentage of the diagonal; the core wants a fraction.
  config.radiusFraction = float(params[SEED_RADIUS]->u.fs_d.value) / 100.0f;
  config.linearSpace = params[SEED_SPACE]->u.pd.value == 1;
  config.gain = float(params[SEED_GAIN]->u.fs_d.value);
  config.replace = float(params[SEED_REPLACE]->u.fs_d.value);
  config.lumaOnly = params[SEED_CHANNELS]->u.pd.value == 1;
  config.shadowFloor = float(params[SEED_SHADOW]->u.fs_d.value);
  config.highlightRolloff = float(params[SEED_HIGHLIGHT]->u.fs_d.value);
  config.detailLimit = float(params[SEED_LIMIT]->u.fs_d.value);
  config.structureGuard = float(params[SEED_GUARD]->u.fs_d.value);
  config.guardTolerance = float(params[SEED_TOLERANCE]->u.fs_d.value);
  config.showGuard = params[SEED_SHOW_GUARD]->u.bd.value != 0;
  config.mix = float(params[SEED_MIX]->u.fs_d.value);
  return config;
}

PF_Err PreRender(PF_InData* in_data, PF_OutData* out_data,
                 PF_PreRenderExtra* extra) {
  PF_Err err = PF_Err_NONE;
  PF_Err err2 = PF_Err_NONE;
  PF_RenderRequest req = extra->input->output_request;
  PF_CheckoutResult in_result;
  PF_CheckoutResult source_result;

  /*
   * The whole input, not the requested rectangle. The separation radius is
   * measured from the frame's own diagonal, so a tile would compute a
   * different radius from its neighbour and the result would be a grid of
   * slightly different separations.
   */
  req.preserve_rgb_of_zero_alpha = TRUE;

  ERR(extra->cb->checkout_layer(in_data->effect_ref, SEED_INPUT, SEED_INPUT,
                                &req, in_data->current_time, in_data->time_step,
                                in_data->time_scale, &in_result));

  // The detail source, at the same time. A failure here is not fatal: with no
  // source layer the effect is a no-op, which is what an unset parameter
  // should look like.
  ERR2(extra->cb->checkout_layer(in_data->effect_ref, SEED_SOURCE, SEED_SOURCE,
                                 &req, in_data->current_time, in_data->time_step,
                                 in_data->time_scale, &source_result));

  if (!err) {
    UnionLRect(&in_result.result_rect, &extra->output->result_rect);
    UnionLRect(&in_result.max_result_rect, &extra->output->max_result_rect);
  }
  return err;
}

PF_Err SmartRender(PF_InData* in_data, PF_OutData* out_data,
                   PF_SmartRenderExtra* extra) {
  PF_Err err = PF_Err_NONE;
  PF_Err err2 = PF_Err_NONE;
  PF_EffectWorld* input_worldP = nullptr;
  PF_EffectWorld* source_worldP = nullptr;
  PF_EffectWorld* output_worldP = nullptr;

  PF_ParamDef params[SEED_NUM_PARAMS];
  PF_ParamDef* paramPtrs[SEED_NUM_PARAMS];
  AEFX_CLR_STRUCT(params);
  for (int i = 0; i < SEED_NUM_PARAMS; ++i) paramPtrs[i] = &params[i];

  for (int i = SEED_SOURCE; i < SEED_NUM_PARAMS && !err; ++i) {
    ERR(PF_CHECKOUT_PARAM(in_data, i, in_data->current_time, in_data->time_step,
                          in_data->time_scale, &params[i]));
  }

  ERR(extra->cb->checkout_layer_pixels(in_data->effect_ref, SEED_INPUT,
                                       &input_worldP));
  // No detail source is an ordinary state, not an error — the effect has just
  // been applied and nothing is chosen yet.
  ERR2(extra->cb->checkout_layer_pixels(in_data->effect_ref, SEED_SOURCE,
                                        &source_worldP));
  ERR(extra->cb->checkout_output(in_data->effect_ref, &output_worldP));

  if (!err && input_worldP && output_worldP) {
    const int depth = DepthOf(in_data, out_data, input_worldP);
    if (depth != 0) {
      seed::Image image = WorldToImage(*input_worldP, depth);

      if (source_worldP) {
        const int sourceDepth = DepthOf(in_data, out_data, source_worldP);
        if (sourceDepth != 0) {
          seed::Image source = WorldToImage(*source_worldP, sourceDepth);
          Unpremultiply(image);
          Unpremultiply(source);
          seed::ApplyFrequencyDetail(image, source, ConfigFrom(paramPtrs));
          Premultiply(image);
        }
      }

      ImageToWorld(image, *output_worldP, depth);
    }
  }

  for (int i = SEED_SOURCE; i < SEED_NUM_PARAMS; ++i) {
    ERR2(PF_CHECKIN_PARAM(in_data, &params[i]));
  }
  if (input_worldP) {
    ERR2(extra->cb->checkin_layer_pixels(in_data->effect_ref, SEED_INPUT));
  }
  if (source_worldP) {
    ERR2(extra->cb->checkin_layer_pixels(in_data->effect_ref, SEED_SOURCE));
  }
  return err;
}

}  // namespace

extern "C" DllExport PF_Err PluginDataEntryFunction2(
    PF_PluginDataPtr inPtr, PF_PluginDataCB2 inPluginDataCallBackPtr,
    SPBasicSuite* inSPBasicSuitePtr, const char* inHostName,
    const char* inHostVersion) {
  PF_Err result = PF_Err_INVALID_CALLBACK;

  result = PF_REGISTER_EFFECT_EXT2(
      inPtr, inPluginDataCallBackPtr,
      "SEED Frequency Detailer",              // Name
      "ai.seedstudios.frequencydetailer",     // Match Name — ours, permanently
      "SEED",                                 // Category
      AE_RESERVED_INFO,                       // Reserved Info
      "EffectMain",                           // Entry point
      "https://github.com/seed-atara/seed-adobe");

  return result;
}

extern "C" DllExport PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data,
                                       PF_OutData* out_data,
                                       PF_ParamDef* params[],
                                       PF_LayerDef* output, void* extra) {
  PF_Err err = PF_Err_NONE;
  try {
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
