// SEED Film Look — After Effects effect plugin.
//
// The host layer, and deliberately nothing else. Every pixel decision lives in
// ../core, which has no Adobe headers in it and is verified against the
// TypeScript engine on shared vectors. This file's whole job is to get pixels
// out of After Effects, hand them to that core, and put them back.
//
// SmartFX with 32-bit float support, because the optical half of the chain is
// physically meaningless in 8- or 16-bit integer and the tonemap bands visibly
// in skies without it.
#pragma once

#include "AEConfig.h"
#include "entry.h"
#include "AE_Effect.h"
#include "AE_EffectCB.h"
#include "AE_Macros.h"
#include "Param_Utils.h"
#include "AE_EffectCBSuites.h"
#include "AE_GeneralPlug.h"
#include "AEFX_SuiteHelper.h"
#include "String_Utils.h"
#include "Smart_Utils.h"

#ifdef AE_OS_WIN
// Before Windows.h, always. It defines min and max as macros, which turns
// every std::max in the core into a syntax error several files away — and the
// error names the core, not the include that caused it.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#endif

#include "SeedFilmLookVersion.h"

#define MAJOR_VERSION SEED_MAJOR_VERSION
#define MINOR_VERSION SEED_MINOR_VERSION
#define BUG_VERSION SEED_BUG_VERSION
#define STAGE_VERSION SEED_STAGE_VERSION
#define BUILD_VERSION SEED_BUILD_VERSION

// Parameter ids. The order here is the order in the Effect Controls panel, and
// it follows the order an artist reaches for them rather than the order the
// chain applies them — which is why Intensity sits second, immediately under
// the look it scales.
enum {
  SEED_INPUT = 0,
  SEED_PRESET,
  SEED_INTENSITY,

  SEED_OPTICS_START,
  SEED_DISTORTION,
  SEED_CA,
  SEED_VIGNETTE,
  SEED_OPTICS_END,

  SEED_FILM_START,
  SEED_EXPOSURE,
  SEED_WP_TONEMAP,
  SEED_HALATION,
  SEED_FILM_END,

  SEED_GRAIN_START,
  SEED_GRAIN_AMOUNT,
  SEED_GRAIN_SIZE,
  SEED_GRAIN_SEED,
  SEED_GRAIN_END,

  SEED_NUM_PARAMS
};

enum {
  PRESET_DISK_ID = 1,
  INTENSITY_DISK_ID,
  OPTICS_START_DISK_ID,
  DISTORTION_DISK_ID,
  CA_DISK_ID,
  VIGNETTE_DISK_ID,
  OPTICS_END_DISK_ID,
  FILM_START_DISK_ID,
  EXPOSURE_DISK_ID,
  WP_TONEMAP_DISK_ID,
  HALATION_DISK_ID,
  FILM_END_DISK_ID,
  GRAIN_START_DISK_ID,
  GRAIN_AMOUNT_DISK_ID,
  GRAIN_SIZE_DISK_ID,
  GRAIN_SEED_DISK_ID,
  GRAIN_END_DISK_ID,
};

// Presets, in the panel's order. The strings are the popup's; the ids match
// packages/filmlook so a look chosen here is the same look chosen there.
#define SEED_PRESET_CHOICES "Show match|Clean optics|500T tungsten|2383 print"

enum {
  PRESET_SHOW_MATCH = 1,
  PRESET_CLEAN_OPTICS,
  PRESET_TUNGSTEN_500T,
  PRESET_PRINT_2383,
};

extern "C" {

DllExport PF_Err EffectMain(PF_Cmd cmd, PF_InData* in_data, PF_OutData* out_data,
                            PF_ParamDef* params[], PF_LayerDef* output,
                            void* extra);
}
