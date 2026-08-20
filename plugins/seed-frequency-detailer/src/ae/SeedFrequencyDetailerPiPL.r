/*
 * The PiPL — how After Effects discovers this plugin at all.
 *
 * Easy to think it is legacy. `PluginDataEntryFunction2` registers the effect
 * at runtime and reads like a replacement for the resource, so a build without
 * one compiles, links, exports both entry points and is still completely
 * invisible in the Effect menu. AE scans binaries for this resource to find
 * out what they are before it ever calls into them.
 *
 * The two OutFlags values must agree with what GlobalSetup sets, because AE
 * caches these at scan time and calls GlobalSetup later:
 *
 *   0x2000040  = PF_OutFlag_USE_OUTPUT_EXTENT   (1<<6)
 *              | PF_OutFlag_DEEP_COLOR_AWARE    (1<<25)
 *
 *   0x8001408  = PF_OutFlag2_PARAM_GROUP_START_COLLAPSED_FLAG (1<<3)
 *              | PF_OutFlag2_SUPPORTS_SMART_RENDER            (1<<10)
 *              | PF_OutFlag2_FLOAT_COLOR_AWARE                (1<<12)
 *              | PF_OutFlag2_SUPPORTS_THREADED_RENDERING      (1<<27)
 *
 * PF_OutFlag_PIX_INDEPENDENT is absent, deliberately: two blurs and a gradient
 * comparison all read neighbouring pixels, so claiming otherwise would let AE
 * render the frame in tiles that seam at every boundary.
 */
#include "AEConfig.h"
#include "AE_EffectVers.h"
#include "SeedFrequencyDetailerVersion.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif

resource 'PiPL' (16000) {
	{
		Kind {
			AEEffect
		},
		Name {
			"SEED Frequency Detailer"
		},
		Category {
			"SEED"
		},
#ifdef AE_OS_WIN
	#if defined(AE_PROC_INTELx64)
		CodeWin64X86 {"EffectMain"},
	#elif defined(AE_PROC_ARM64)
		CodeWinARM64 {"EffectMain"},
	#endif
#elif defined(AE_OS_MAC)
		CodeMacIntel64 {"EffectMain"},
		CodeMacARM64 {"EffectMain"},
#endif
		AE_PiPL_Version {
			2,
			0
		},
		AE_Effect_Spec_Version {
			PF_PLUG_IN_VERSION,
			PF_PLUG_IN_SUBVERS
		},
		AE_Effect_Version {
			SEED_VERSION_PACKED
		},
		AE_Effect_Info_Flags {
			0
		},
		AE_Effect_Global_OutFlags {
			0x2000040
		},
		AE_Effect_Global_OutFlags_2 {
			0x8001408
		},
		AE_Effect_Match_Name {
			"ai.seedstudios.frequencydetailer"
		},
		AE_Reserved_Info {
			0
		},
		AE_Effect_Support_URL {
			"https://github.com/seed-atara/seed-adobe"
		}
	}
};
