/*
 * The plugin version, in one place, because it has to be stated twice.
 *
 * After Effects reads the version from the PiPL resource at scan time and from
 * GlobalSetup at load time, and refuses to load the effect if they disagree —
 * "has version mismatch. Code version is 0.1 and PiPL version is 1.0. (8001)".
 *
 * The resource cannot call PF_VERSION: including AE_Effect.h into a file run
 * through the preprocessor and fed to PiPLtool would dump the whole header
 * into the resource stream. So the packed value is written by hand, and
 * SeedFrequencyDetailer.cpp asserts at compile time that it equals PF_VERSION
 * of the same five numbers. The mismatch cannot come back without failing the
 * build.
 *
 * Packing, from AE_Effect.h:
 *   major   & 0x7   << 19
 *   minor   & 0xf   << 15
 *   bugfix  & 0xf   << 11
 *   stage   & 0x3   << 9       0 = develop, 1 = alpha, 2 = beta, 3 = release
 *   build   & 0x1ff << 0
 */
#pragma once

#define SEED_MAJOR_VERSION 0
#define SEED_MINOR_VERSION 1
#define SEED_BUG_VERSION 0
#define SEED_STAGE_VERSION 0 /* PF_Stage_DEVELOP */
#define SEED_BUILD_VERSION 1

/*
 * The packed value, as a plain integer — a literal rather than the arithmetic
 * above, because PiPLtool parses numbers, not expressions, and answers a shift
 * with "Matching parantheses expected!" against a line number in the
 * preprocessed file that corresponds to nothing you wrote.
 *
 *   0.1, develop, build 1  =  (1 << 15) | 1  =  32769
 */
#define SEED_VERSION_PACKED 32769
