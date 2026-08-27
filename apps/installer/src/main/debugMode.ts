/**
 * CEP's PlayerDebugMode — the flag that lets After Effects load an unsigned
 * extension.
 *
 * The developer script deliberately *reports* this and refuses to set it: a
 * machine-wide "allow unsigned code" switch should not be a side effect of
 * running an install command. That reasoning does not survive contact with the
 * shipped product — an artist has no way to act on a printed registry command,
 * and telling them to paste one into a terminal is the exact thing this
 * application exists to remove.
 *
 * So it is set here, but only after the person has been asked in a dialog that
 * says plainly what it does. Consent, not silence, is what made the developer
 * script's rule right; the terminal was never the point.
 *
 * The flag goes away entirely once the panel is signed with an Adobe extension
 * certificate.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * CSXS generations After Effects has shipped under.
 *
 * We write all of them rather than detecting the installed version: the value
 * is inert for a CSXS generation that is not present, the cost is four tiny
 * writes, and version detection across AE releases is its own bug surface.
 */
export const CSXS_VERSIONS = [9, 10, 11, 12] as const;

export type DebugModeState = "on" | "off" | "unsupported";

export async function readDebugMode(
  platform: NodeJS.Platform = process.platform,
): Promise<DebugModeState> {
  if (platform === "win32") {
    for (const version of CSXS_VERSIONS) {
      try {
        const { stdout } = await run("reg", [
          "query",
          `HKCU\\Software\\Adobe\\CSXS.${version}`,
          "/v",
          "PlayerDebugMode",
        ]);
        if (/PlayerDebugMode\s+REG_SZ\s+1/i.test(stdout)) return "on";
      } catch {
        // Key absent for this generation; keep looking.
      }
    }
    return "off";
  }

  if (platform === "darwin") {
    for (const version of CSXS_VERSIONS) {
      try {
        const { stdout } = await run("defaults", [
          "read",
          `com.adobe.CSXS.${version}`,
          "PlayerDebugMode",
        ]);
        // `defaults` prints 1 for the string "1" and for boolean true alike.
        if (stdout.trim() === "1") return "on";
      } catch {
        // Domain or key absent; keep looking.
      }
    }
    return "off";
  }

  return "unsupported";
}

/**
 * Turns it on for every CSXS generation.
 *
 * Returns the generations that were written rather than a bare boolean, so the
 * status window can say what actually happened instead of asserting success.
 */
export async function enableDebugMode(
  platform: NodeJS.Platform = process.platform,
): Promise<{ written: number[]; failed: number[] }> {
  const written: number[] = [];
  const failed: number[] = [];

  for (const version of CSXS_VERSIONS) {
    try {
      if (platform === "win32") {
        await run("reg", [
          "add",
          `HKCU\\Software\\Adobe\\CSXS.${version}`,
          "/v",
          "PlayerDebugMode",
          "/t",
          "REG_SZ",
          "/d",
          "1",
          "/f",
        ]);
      } else if (platform === "darwin") {
        await run("defaults", [
          "write",
          `com.adobe.CSXS.${version}`,
          "PlayerDebugMode",
          "1",
        ]);
      } else {
        failed.push(version);
        continue;
      }
      written.push(version);
    } catch {
      failed.push(version);
    }
  }

  if (platform === "darwin" && written.length > 0) {
    // Not optional decoration. cfprefsd caches preference domains and will
    // keep serving After Effects the old value for minutes, which presents
    // exactly as the flag not having worked.
    try {
      await run("killall", ["cfprefsd"]);
    } catch {
      // No cfprefsd running is fine; nothing to flush.
    }
  }

  return { written, failed };
}
