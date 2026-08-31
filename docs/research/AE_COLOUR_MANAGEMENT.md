# After Effects colour management, and why captures came out black

**Written 2026-08-31.** Researched after a capture from an ACES – ACEScg
project arrived near-black, and after two wrong fixes.

## What is actually true

**`CompItem.saveFrameToPng` is undocumented.** It is not in Adobe's scripting
guide; it is known from community use, described there as "faster and simpler
than regular rendering". SEED has used it for every still capture since the
beginning.

**It writes the frame in the project's WORKING space, with no view transform.**
In a display-referred project (sRGB, Rec.709) that is fine — working space and
display space agree. In a scene-referred one it is not: ACEScg is linear with
AP1 primaries, so the PNG holds scene values that everything downstream reads
as display values. Measured on a real 1920×1080 ACEScg capture: mean level
**9 of 255**, alpha 255 across the whole frame, 57% of pixels non-zero. The
picture was entirely there; only the encoding was wrong.

**Colour management cannot be changed from a script.** Adobe's own guidance is
that footage interpretation and colour management are not scriptable natively.
Two things follow, and the second one cost us a broken project:

- There is no `setDisplayTransform` to reach for.
- `app.project.workingSpace` accepts a write and does **not** round-trip. In an
  OCIO project the working space is an OCIO name, not an ICC profile
  description, so putting it back raises

  > Profile "ACES - ACEScg" is missing, invalid or has incorrect file
  > permissions. (83 :: 0)

  and leaves the project unmanaged. **Do not write to it.**

**The render queue does have the control.** Output Module Settings → **Color →
Output Color Space** sets the space a render is written in, with a *Show all*
checkbox that lists every space in the OCIO config plus the display view
transforms. That is the supported way to get a display-referred file out of a
colour-managed project.

**Whether that control is reachable from a script is not documented.**
`OutputModule.getSettings()` / `setSettings()` are documented and
`getSettings(GetSettingsFormat.STRING)` returns *all* settings — but Adobe
documents no key names for colour, and they are known to differ between
versions and between the ICC and OCIO engines. `scripts/probe-color-settings.jsx`
exists to answer this empirically on a given machine rather than guess.

## Ruled out

**The AE 24.6 bug.** There was a real defect where a 32-bit project with
*Linearize Working Space* enabled rendered darker, fixed in 25.0. This machine
runs **26.0**, so that is not what is happening here.

## Where SEED stands

The service converts the capture after the fact
(`apps/service/src/media/displayReferred.ts`): ACEScg → sRGB with the real
primaries matrix and the piecewise sRGB curve. Verified on the capture that
started this, through the production path: mean **9.4 → 48.4**, no clipped
channels.

It is honest and it is not the whole answer. It is **colorimetric** — no RRT,
no tone map — so it is not what the artist sees through an ACES output
transform, and highlights clip rather than rolling off. For a plate that is
defensible: a look belongs in the grade. For matching the viewer it is not
enough.

## What would finish it

Render stills through the render queue with **Output Color Space** set,
instead of `saveFrameToPng`. That hands the transform to Adobe's own pipeline
and gives exactly what the viewer shows. It needs, in order:

1. The real settings key on a real machine — the probe.
2. A still output module (PNG) driven per capture, which is slower than
   `saveFrameToPng` and needs the same settle-and-wait care the range export
   already has.
3. A fallback for when the key is absent: an output module **template** the
   artist saves once, applied by name — the pattern already used for the
   Premiere `.epr` presets.

## Sources

- [Managing color in After Effects](https://helpx.adobe.com/after-effects/using/color-management.html)
- [OpenColorIO and ACES color management](https://helpx.adobe.com/after-effects/using/opencolorio-aces-color-management.html)
- [After Effects 24.6 renders darker with linearize working space (fixed in 25.0)](https://community.adobe.com/bug-reports-528/after-effects-24-6-renders-darker-videos-when-linearize-working-color-space-is-on-1215480)
- [Chris Zwar, Colour Management Part 14: Combining OCIO and After Effects](https://www.provideocoalition.com/color-management-part-14-combining-ocio-and-after-effects/)
- [OutputModule — After Effects Scripting Guide](https://ae-scripting.docsforadobe.dev/renderqueue/outputmodule/)
- [Save Frame As via Scripting (saveFrameToPng is undocumented)](https://community.adobe.com/t5/after-effects/save-frame-as-via-scripting/m-p/4584729)
- [RxDocs — After Effects Color Management](https://rxlab.guide/colors/ae.html)
