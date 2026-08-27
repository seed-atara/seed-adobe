/**
 * Builds everything the companion has to carry.
 *
 * Five outputs, in order, because each one feeds the next:
 *
 *   0. the icon         drawn -> build/icon.png, build/trayTemplate.png
 *   1. the panel        vite -> apps/extension/panel
 *   2. the extension    apps/extension -> resources/extension  (panel + jsx + manifest)
 *   3. the service      esbuild, one file -> resources/service/index.js
 *   3b. ffmpeg          this platform's binary -> resources/ffmpeg
 *   3c. the effects     the built .aex plugins -> resources/effects
 *   4. the shell        esbuild -> dist/main, dist/preload, dist/window
 *
 * The service is bundled rather than shipped as sources with a TypeScript
 * loader: `tsx` in a packaged app means shipping a compiler and resolving
 * workspace paths at runtime, and every one of those is a way for the shipped
 * thing to differ from the tested one.
 *
 *   node scripts/build.mjs
 */
import { build } from "esbuild";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "../..");
const resources = path.join(appDir, "resources");
const dist = path.join(appDir, "dist");

const step = (message) => console.log(`\n▸ ${message}`);

rmSync(resources, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });

/* 0 — the icon ------------------------------------------------------------ */
// Drawn rather than checked in, so it must exist before electron-builder looks
// for it. Cheap enough to redo every build, and that keeps it impossible to
// package with a stale or missing mark.
step("Drawing the icon");
execFileSync(process.execPath, [path.join(here, "make-icon.mjs")], { stdio: "inherit" });

/* 1 — the panel ---------------------------------------------------------- */
step("Building the panel");
const vite = path.join(repoRoot, "node_modules/vite/bin/vite.js");
if (!existsSync(vite)) {
  console.error("Vite is not installed. Run `npm install` at the repo root first.");
  process.exit(1);
}
// Invoked through Node directly rather than npm: on Windows npm is a .cmd,
// which current Node refuses to spawn without a shell, and shell:true
// concatenates arguments unescaped.
execFileSync(process.execPath, [vite, "build", "--outDir", "../extension/panel", "--emptyOutDir"], {
  cwd: path.join(repoRoot, "apps/panel"),
  stdio: "inherit",
});

/* 2 — the extension folder ----------------------------------------------- */
step("Collecting the extension");
mkdirSync(resources, { recursive: true });
cpSync(path.join(repoRoot, "apps/extension"), path.join(resources, "extension"), {
  recursive: true,
  dereference: true,
});

/* 3 — the service -------------------------------------------------------- */
step("Bundling the service");
await build({
  entryPoints: [path.join(repoRoot, "apps/service/src/index.ts")],
  outfile: path.join(resources, "service", "index.js"),
  bundle: true,
  platform: "node",
  // Electron 42 carries Node 24.18.1. Targeting it rather than something older
  // keeps the output readable and lets `node:sqlite` through untouched.
  target: "node24",
  format: "esm",
  sourcemap: true,
  // ESM output that calls require() (some dependencies still do) needs one.
  banner: {
    js: [
      "import { createRequire as __seedCreateRequire } from 'node:module';",
      "const require = __seedCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  external: [
    // A lazy `await import()` behind a graceful failure message, and ~100MB of
    // ONNX runtime. Only depth estimation uses it, and that is not reachable
    // from the panel today. Bundling it would multiply the download for a
    // feature nobody can press.
    "@huggingface/transformers",
  ],
  logLevel: "info",
});

/* 3b — ffmpeg ------------------------------------------------------------- */
// npm installs only this platform's binary, which is exactly what this build
// should carry. Staged into resources/ so electron-builder ships it outside the
// asar — an executable cannot be spawned from inside one.
step("Staging ffmpeg");
const ffmpegSource = (await import("ffmpeg-static")).default;
if (!ffmpegSource || !existsSync(ffmpegSource)) {
  console.error("ffmpeg-static did not provide a binary; run `npm install`.");
  process.exit(1);
}
const ffmpegDir = path.join(resources, "ffmpeg");
mkdirSync(ffmpegDir, { recursive: true });
const ffmpegTarget = path.join(ffmpegDir, path.basename(ffmpegSource));
cpSync(ffmpegSource, ffmpegTarget);
// cpSync does not carry the executable bit on every platform.
chmodSync(ffmpegTarget, 0o755);
console.log(`  ${ffmpegTarget}`);

/* 3c — the native effects -------------------------------------------------- */
// Windows-only: these are built by .cmd scripts against the Windows SDK and
// there is no Xcode project. Staged on every platform anyway so the packaged
// file list is identical; electron-builder ships them under `win:` only.
step("Staging the effects");
const effectsDir = path.join(resources, "effects");
mkdirSync(effectsDir, { recursive: true });
const aex = [
  "seed-film-look/build/SEED Film Look.aex",
  "seed-frequency-detailer/build/SEED Frequency Detailer.aex",
];
for (const relative of aex) {
  const from = path.join(repoRoot, "plugins", relative);
  if (!existsSync(from)) {
    // Not fatal: a checkout that has never built the plugins should still
    // produce an installer, and the window says the effects are unavailable.
    console.log(`  (missing, skipped) ${relative}`);
    continue;
  }
  cpSync(from, path.join(effectsDir, path.basename(from)));
  console.log(`  ${path.basename(from)}`);
}

/* 4 — the shell ---------------------------------------------------------- */
step("Building the companion");
await build({
  entryPoints: [path.join(appDir, "src/main/index.ts")],
  outfile: path.join(dist, "main", "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});

await build({
  entryPoints: [path.join(appDir, "src/preload/index.ts")],
  outfile: path.join(dist, "preload", "index.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  // A sandboxed preload cannot be an ES module.
  format: "cjs",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
});

mkdirSync(path.join(dist, "window"), { recursive: true });
cpSync(path.join(appDir, "src/window/index.html"), path.join(dist, "window", "index.html"));

step("Done");
console.log(`  resources  ${resources}`);
console.log(`  dist       ${dist}`);
