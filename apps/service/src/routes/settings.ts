/**
 * Reading and setting credentials from the panel.
 *
 * Two rules shape every line here:
 *
 *   1. **A secret never travels back to the client.** `GET` returns whether a
 *      key is set, where it came from, and its last four characters. There is
 *      no route that returns a key, so a panel bug, a screen share or a saved
 *      HTTP log cannot leak one.
 *   2. **Saving takes effect without a restart.** A key that needs the artist
 *      to find and restart a terminal process is a key they will assume is
 *      broken. `POST` rebuilds the provider set in place and returns the new
 *      list, so the panel can show what just became available.
 */
import { z } from "zod";
import { SeedError } from "@seed-ae/domain";
import type { AppDeps } from "../app.js";
import { parseWith, readJsonBody } from "../http/body.js";
import { json } from "../http/respond.js";
import {
  SETTINGS,
  credentialsPath,
  describeSettings,
  effectiveEnv,
  writeCredentials,
} from "../settings.js";

const SETTABLE = SETTINGS.map((setting) => setting.key) as [string, ...string[]];

const SaveSettingsSchema = z.object({
  /**
   * Only advertised keys, and `null` to clear one. An open record would make
   * this route an arbitrary-environment-injection endpoint for anything that
   * gets hold of the session token.
   *
   * `partialRecord`, not `record`: in Zod 4 a record keyed by an enum is
   * *exhaustive*, so `record` here would demand all twelve keys on every save
   * and reject a one-field edit. This is a patch, not a replacement.
   */
  values: z.partialRecord(z.enum(SETTABLE), z.string().nullable()),
});

export function getSettingsRoute(deps: AppDeps) {
  return () =>
    json({
      settings: describeSettings(),
      /**
       * Named so the artist can find and back it up, and so "where did my key
       * go" has an answer. The path is not a secret; its contents are.
       */
      storedAt: credentialsPath(),
      /** Whether the panel can expect a save to change anything live. */
      reloadable: typeof deps.reloadProviders === "function",
    });
}

export function saveSettingsRoute(deps: AppDeps) {
  return async ({ req }: { req: Parameters<typeof readJsonBody>[0] }) => {
    const { values } = parseWith(SaveSettingsSchema, await readJsonBody(req));

    writeCredentials(values);

    // Rebuild against the merged environment so a key just typed in is the one
    // the new providers are constructed with.
    const applied = deps.reloadProviders?.(effectiveEnv());

    // Deliberately after the write: if reloading throws, the key is still
    // saved and a restart will pick it up. Losing a key the artist has already
    // typed is the worse outcome of the two.
    if (!applied) {
      throw new SeedError(
        "internal_error",
        "settings were saved but the running service could not reload them; restart it to apply",
      );
    }

    return json({
      settings: describeSettings(),
      providers: applied.providers,
      /** What the save actually unlocked, so the panel can say so plainly. */
      changed: Object.keys(values),
    });
  };
}
