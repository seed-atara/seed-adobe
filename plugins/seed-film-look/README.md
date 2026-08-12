# SEED Film Look — After Effects plugin

The look as a real effect: dragged onto a layer, live in the viewer,
keyframeable, rendering with the comp, 32-bit float.

## Why this exists rather than a stack of stock effects

An earlier attempt applied After Effects' own Glow, CC Vignette and Add Grain
with numbers scaled off the config. That is not this chain. Those effects are
different mathematics wearing the same words, and shipping them as SEED's look
would have made the tool lie about what it does.

The tonal half is already exact through a generated `.cube`. This plugin is for
the half a lookup cannot carry: grain with a stock's per-channel asymmetry,
halation from thresholded highlights, cos⁴ vignette in linear, and one combined
distortion/aberration gather.

## Layout

```
src/core/      the chain, ported from packages/filmlook. No SDK, no Adobe
               headers, no platform. Compiles and is tested on its own.
src/ae/        the After Effects glue: entry point, parameters, SmartFX.
               This is the only part that needs the SDK.
test/          parity against the TypeScript engine, on shared vectors.
```

The split is the point. The maths is most of the work and none of it needs
Adobe's headers, so it is written and verified first — and `src/ae` stays thin
enough to read in one sitting.

## Building

The core and its tests need only MSVC:

```
npm run plugin:test
```

The plugin itself needs the After Effects SDK, which is a licensed download
from https://adobe.io/after-effects and cannot be vendored here. Once it is
unpacked, point at it and build:

```
set AE_SDK=C:\path\to\AfterEffectsSDK
npm run plugin:build
```

## Parity

`test/parity.cpp` runs the same vectors as `packages/filmlook/test`, generated
from the TypeScript engine into `test/vectors.json`. Two implementations of one
look is a promise to keep them identical, and the only way to keep it is to
check.
