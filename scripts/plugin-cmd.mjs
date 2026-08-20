#!/usr/bin/env node
/**
 * Runs one of a plugin's .cmd scripts.
 *
 *   node scripts/plugin-cmd.mjs seed-frequency-detailer build-aex.cmd
 *
 * Through node rather than putting `cmd /c plugins\...\build-aex.cmd`
 * straight into package.json: a Windows path in a JSON string is a minefield
 * of accidental escapes, and `\b` in particular survives JSON only to be read
 * as a backspace by the time it reaches the shell — which fails as "The
 * filename, directory name, or volume label syntax is incorrect", naming
 * nothing that would tell you why.
 *
 * Building the path here from segments means no escaping is involved at all.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [plugin, script] = process.argv.slice(2);
if (!plugin || !script) {
  console.error("usage: plugin-cmd.mjs <plugin-dir> <script.cmd>");
  process.exit(2);
}

if (process.platform !== "win32") {
  console.error("These builds are MSVC only. macOS needs an Xcode build.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "plugins", plugin, script);
if (!existsSync(target)) {
  console.error(`No such script: ${target}`);
  process.exit(1);
}

try {
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", target], {
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}
