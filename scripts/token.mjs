/**
 * Prints the local session token and copies it to the clipboard.
 *
 * The token has to get from .env into a password field in the panel, and
 * retyping 29 random characters is its own small misery.
 *
 *   npm run token
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env");

if (!existsSync(envPath)) {
  console.error(`No .env at ${envPath}. Copy .env.example and fill it in.`);
  process.exit(1);
}

const match = /^SEED_AE_SESSION_TOKEN=(.+)$/m.exec(readFileSync(envPath, "utf8"));
const token = match?.[1]?.trim();

if (!token) {
  console.error(
    "SEED_AE_SESSION_TOKEN is not set in .env.\n" +
      "Leave it empty and the service mints one per process, printing it at startup.",
  );
  process.exit(1);
}

try {
  if (process.platform === "win32") {
    execFileSync("clip", { input: token });
  } else if (process.platform === "darwin") {
    execFileSync("pbcopy", { input: token });
  } else {
    execFileSync("xclip", ["-selection", "clipboard"], { input: token });
  }
  console.log("Session token copied to the clipboard.\n");
} catch {
  console.log("(could not reach the clipboard; the token is below)\n");
}

console.log(token);
console.log("\nPaste it into the panel: Window > Extensions > SEED / AE");
