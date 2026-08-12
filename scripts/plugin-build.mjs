#!/usr/bin/env node
/** Builds the .aex. See plugins/seed-film-look/README.md for the SDK path. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "plugins", "seed-film-look", "build-aex.cmd");

if (process.platform !== "win32") {
  console.error("The .aex build is MSVC only. macOS needs an Xcode build.");
  process.exit(1);
}
try {
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", script], { stdio: "inherit" });
} catch {
  process.exit(1);
}
