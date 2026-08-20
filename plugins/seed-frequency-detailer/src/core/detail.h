// SEED Frequency Detailer — the maths, in C++.
//
// Transfers high-frequency detail from a sharp plate onto a soft render, by
// the ratio form of frequency separation:
//
//     D   = plate / blur(plate)          a ratio, ~1.0 where the plate is flat
//     out = render * D
//
// This is not the additive ("Linear Light", high-pass plus offset 128) form
// that retouching tutorials teach. The difference decides whether it works at
// all here: additive detail carries an absolute amplitude and so drags the
// plate's exposure with it, arriving too strong in the shadows and too weak in
// the highlights once the render is graded differently. A ratio carries only
// relative contrast — a pore 3% darker than its surroundings stays 3% darker
// whatever the render's brightness is. For same-image retouching either works.
// For transfer between two images, only this one does.
//
// Free of Adobe headers so it can be compiled and tested without the SDK, in
// the same way and for the same reason as the film look's core: nothing in the
// test suite can run an .aex, so anything living only in the plugin glue is
// unverified until a human opens After Effects.
#pragma once

// The film look's core, for Image, GaussianBlur, the sRGB conversions and
// RadiusPixels. Deliberately shared rather than copied: two blurs that are
// meant to be identical, in one repository, is a promise nobody keeps.
#include "../../../seed-film-look/src/core/look.h"

namespace seed {

struct DetailConfig {
  // --------------------------------------------------------- separation
  // The frequency the image is split at, as a fraction of the frame diagonal
  // rather than pixels — so a setting found at 1440x1440 still means the same
  // thing on a 5750x2818 plate.
  float radiusFraction = 0.004f;
  // A ratio in linear light is a shading separation, which is physically what
  // surface texture is. In display space the same ratio means different things
  // at different brightnesses.
  bool linearSpace = true;

  // ------------------------------------------------------------- detail
  // Applied as D^gain rather than 1 + (D-1)*gain. A ratio scales naturally by
  // exponentiation — linear in log space — so the operation stays
  // multiplicative and symmetric: doubling detail then halving it returns
  // exactly where it started, which the linear form does not.
  float gain = 1.0f;
  // How much of the render's *own* high frequency to drop before the plate's
  // is multiplied in. At 0 the plate's detail is added on top of whatever the
  // render already had, which is the manual workflow and doubles edges. At 1
  // the render's high frequency is replaced outright, which is usually what a
  // soft generative render wants.
  float replace = 0.7f;
  // Transferring chroma detail between two differently graded images is the
  // usual source of colour fringing, so luma is the default.
  bool lumaOnly = true;

  // --------------------------------------------------------- protection
  // The divide explodes as the blurred plate approaches black. This is both
  // the floor of that divide and the scale over which detail fades out in deep
  // shadow, where there is nothing but noise to transfer anyway.
  float shadowFloor = 0.02f;
  // Detail fades out approaching white, where it would only clip.
  float highlightRolloff = 0.3f;
  // Bounds the ratio either way, which bounds haloing at hard edges and stops
  // grain being multiplied into noise.
  float detailLimit = 4.0f;

  // -------------------------------------------------------------- drift
  // Attenuates detail where the plate and the render describe different
  // shapes. This is a mitigation, not alignment: it makes drift fail as
  // missing detail rather than as doubled edges, which is the better failure.
  float structureGuard = 0.5f;
  // How much disagreement is tolerated before detail starts fading.
  float guardTolerance = 0.3f;
  // Renders the agreement map instead of the picture, so drift can be seen
  // rather than guessed at.
  bool showGuard = false;

  float mix = 1.0f;
};

// Transfers detail from `source` onto `target`, in place.
//
// Both are RGBA float, straight (not premultiplied) — the caller unpremultiplies
// if its host hands over premultiplied pixels. Encoded 0..1 sRGB unless
// `linearSpace` is false, in which case whatever they are is what is operated
// on. `source` may be a different size; it is sampled bilinearly to match.
void ApplyFrequencyDetail(Image& target, const Image& source,
                          const DetailConfig& config);

// The structure-agreement field on its own, exposed for testing and for the
// Show guard control. 1 where the two images describe the same shapes, 0 where
// they have drifted apart.
Image StructureAgreement(const Image& blurredSource, const Image& blurredTarget,
                         float tolerance);

}  // namespace seed
