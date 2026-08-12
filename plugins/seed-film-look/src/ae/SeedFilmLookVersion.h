/*
 * The plugin version, in one place, because it has to be stated twice.
 *
 * After Effects reads the version from the PiPL resource at scan time and from
 * GlobalSetup at load time, and refuses to load the effect if they disagree:
 *
 *   effect "SEED Film Look" has version mismatch.
 *   Code version is 0.1 and PiPL version is 1.0. (8001)
 *
 * The resource cannot call PF_VERSION — including AE_Effect.h into a file that
 * is run through the preprocessor and fed to PiPLtool would dump the entire
 * header into the resource stream — so the packed value has to be written out
 * by hand. Adobe's own samples hard-code a magic number here and leave the
 * reader to work out what it means. That is exactly how the mismatch above
 * happened: 524289 sets bit 19, which is the *major* version field, so a
 * plugin meant to be 0.1 announced itself as 1.0.
 *
 * So both sides derive from these five numbers, and SeedFilmLook.cpp asserts
 * at compile time that the packed value equals PF_VERSION of the same five.
 * The mismatch cannot come back without failing the build.
 *
 * Packing, from AE_Effect.h:
 *   major   & 0x7   << 19      (plus the high bits at 26 for major > 7)
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
 * The packed value, as a plain integer.
 *
 * It has to be a literal rather than the arithmetic above: PiPLtool parses
 * numbers, not expressions, and answers a shift with "Matching parantheses
 * expected!" against a line number in the preprocessed file that corresponds
 * to nothing you wrote.
 *
 *   0.1, develop, build 1  =  (1 << 15) | 1  =  32769
 *
 * None of which has to be trusted. SeedFilmLook.cpp asserts at compile time
 * that this equals PF_VERSION of the five numbers above, so bumping the
 * version without updating this literal fails the build rather than producing
 * an effect After Effects refuses to load.
 */
#define SEED_VERSION_PACKED 32769
