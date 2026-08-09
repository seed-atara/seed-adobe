/**
 * Installs the SEED / AE panel as an After Effects CEP extension.
 *
 * Node rather than PowerShell on purpose: `pwsh -File ...` proved unreliable to
 * invoke from cmder/clink (it silently dropped into an interactive shell), and
 * `npm run install:extension` works the same from every shell.
 *
 * This does NOT touch the registry. Unsigned extensions need CEP's
 * PlayerDebugMode, so the script reports whether it is set and prints the exact
 * command if it is not — changing a machine-wide "allow unsigned code" flag
 * should be a deliberate act, not a side effect of an install script.
 *
 *   node scripts/install-extension.mjs [--skip-build] [--uninstall]
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = "ai.seedstudios.seedae";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "apps/extension");

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const uninstall = args.has("--uninstall");

function cepExtensionsDir() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) throw new Error("APPDATA is not set");
    return path.join(appData, "Adobe", "CEP", "extensions");
  }
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set");
  return path.join(home, "Library", "Application Support", "Adobe", "CEP", "extensions");
}

const target = path.join(cepExtensionsDir(), BUNDLE_ID);

if (uninstall) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${target}`);
  } else {
    console.log(`Nothing installed at ${target}`);
  }
  process.exit(0);
}

if (!skipBuild) {
  console.log("Building the panel...");
  // Invoke Vite's JS entry point directly rather than going through npm: on
  // Windows npm is a .cmd, which current Node refuses to spawn without a
  // shell, and shell:true concatenates arguments unescaped.
  const vite = path.join(repoRoot, "node_modules/vite/bin/vite.js");
  if (!existsSync(vite)) {
    console.error("Vite is not installed. Run `npm install` first.");
    process.exit(1);
  }
  execFileSync(
    process.execPath,
    [vite, "build", "--outDir", "../extension/panel", "--emptyOutDir"],
    { cwd: path.join(repoRoot, "apps/panel"), stdio: "inherit" },
  );
}

const builtIndex = path.join(source, "panel/index.html");
if (!existsSync(builtIndex)) {
  console.error(`No built panel at ${builtIndex}. Run without --skip-build.`);
  process.exit(1);
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
// dereference so a symlinked build cannot leave AE reading outside the folder.
cpSync(source, target, { recursive: true, dereference: true });

console.log(`\nInstalled to ${target}`);

/** Read-only check; we report rather than change it. */
function playerDebugModeEnabled() {
  if (process.platform !== "win32") return undefined;
  for (const version of [9, 10, 11, 12]) {
    try {
      const out = execFileSync(
        "reg",
        ["query", `HKCU\\Software\\Adobe\\CSXS.${version}`, "/v", "PlayerDebugMode"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (/PlayerDebugMode\s+REG_SZ\s+1/i.test(out)) return true;
    } catch {
      // key or value absent for this version; keep looking
    }
  }
  return false;
}

const debugMode = playerDebugModeEnabled();
if (debugMode === false) {
  console.log(
    "\nThis bundle is unsigned, so After Effects will not load it until CEP's\n" +
      "PlayerDebugMode is enabled. Run this yourself if you are happy to allow\n" +
      "unsigned extensions:\n\n" +
      '  reg add "HKCU\\Software\\Adobe\\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f\n' +
      '  reg add "HKCU\\Software\\Adobe\\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f\n',
  );
} else if (debugMode === true) {
  console.log("PlayerDebugMode is already enabled - nothing to change.");
}

console.log("Next:");
console.log("  1. npm run dev            (starts the service, uses .env)");
console.log("  2. Restart After Effects");
console.log("  3. Window > Extensions > SEED / AE");
console.log("  4. Paste the session token from .env");
