#!/usr/bin/env node
/**
 * Builds and runs the film-look plugin's C++ core test.
 *
 * A tiny runner rather than an inline npm command: the path has backslashes,
 * npm scripts go through a shell, and the two disagree about what a backslash
 * means often enough that it is not worth the argument.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "plugins", "seed-film-look", "build-core-test.cmd");

if (process.platform !== "win32") {
  console.error(
    "The core test builds with MSVC. On macOS the same sources compile with\n" +
      "clang; that build script is not written yet.",
  );
  process.exit(1);
}

try {
  execFileSync(process.env.ComSpec ?? "cmd.exe", ["/c", script], {
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}
