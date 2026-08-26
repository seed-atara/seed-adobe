import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  credentialsPath,
  describeSettings,
  effectiveEnv,
  readCredentials,
  writeCredentials,
} from "../src/settings.js";
import { readJson, startTestService, type TestService } from "./helpers.js";

let dir: string;
let file: string;

beforeAll(async () => {
  // A space in the path, like every real "Client Work" folder.
  dir = await mkdtemp(path.join(tmpdir(), "seed ae creds "));
  file = path.join(dir, "credentials.json");
  process.env.SEED_AE_CREDENTIALS = file;
});

afterAll(async () => {
  delete process.env.SEED_AE_CREDENTIALS;
  await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await rm(file, { force: true });
});

describe("the credential file", () => {
  it("round-trips a value and clears it with an empty string", () => {
    writeCredentials({ ARK_API_KEY: "ark-live-1234" }, file);
    expect(readCredentials(file).ARK_API_KEY).toBe("ark-live-1234");

    // Not mentioned means left alone; explicitly emptied means removed. The
    // panel needs both, and conflating them makes "clear this key" impossible.
    writeCredentials({ SEEDREAM_MODEL_ID: "seedream-4-0-250828" }, file);
    expect(readCredentials(file).ARK_API_KEY).toBe("ark-live-1234");

    writeCredentials({ ARK_API_KEY: "" }, file);
    expect(readCredentials(file).ARK_API_KEY).toBeUndefined();
    expect(readCredentials(file).SEEDREAM_MODEL_ID).toBe("seedream-4-0-250828");
  });

  it("refuses to load a key it does not advertise", () => {
    // Whatever else ends up in the file, it cannot inject environment into the
    // service — the settable set is the allowlist, on write and on read alike.
    writeCredentials(
      { ARK_API_KEY: "ark-1", PATH: "/evil", NODE_OPTIONS: "--inspect" } as Record<
        string,
        string
      >,
      file,
    );
    const loaded = readCredentials(file);
    expect(loaded.ARK_API_KEY).toBe("ark-1");
    expect(loaded.PATH).toBeUndefined();
    expect(loaded.NODE_OPTIONS).toBeUndefined();
  });

  it("treats a missing or corrupt file as simply unconfigured", async () => {
    expect(readCredentials(path.join(dir, "nope.json"))).toEqual({});
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{ this is not json", "utf8");
    expect(readCredentials(file)).toEqual({});
  });

  it("keeps the file readable only by its owner", async function () {
    writeCredentials({ ARK_API_KEY: "ark-live-1234" }, file);
    const stats = await stat(file);
    // POSIX only: on Windows the mode bits are not the access control, which
    // is why the file lives in the user profile rather than relying on them.
    if (process.platform !== "win32") {
      expect(stats.mode & 0o077).toBe(0);
    }
  });

  it("puts the file outside the workspace by default", () => {
    // A workspace gets zipped and handed to other people. Keys must not ride
    // along, so the default path is anchored to the home directory.
    const fallback = credentialsPath({} as NodeJS.ProcessEnv);
    expect(fallback).toMatch(/\.seed-ae/);
    expect(path.isAbsolute(fallback)).toBe(true);
  });
});

describe("what the panel is told", () => {
  it("layers a panel value over .env and names which one won", () => {
    const env = { ARK_API_KEY: "from-env-9999" } as NodeJS.ProcessEnv;

    const beforeSave = describeSettings(env, {});
    const arkBefore = beforeSave.find((s) => s.key === "ARK_API_KEY");
    expect(arkBefore?.source).toBe("env");

    const afterSave = describeSettings(env, { ARK_API_KEY: "from-panel-1234" });
    const arkAfter = afterSave.find((s) => s.key === "ARK_API_KEY");
    expect(arkAfter?.source).toBe("panel");
    expect(effectiveEnv(env, { ARK_API_KEY: "from-panel-1234" }).ARK_API_KEY).toBe(
      "from-panel-1234",
    );
  });

  it("hints at a secret without revealing it, and shows a model id in full", () => {
    const described = describeSettings({} as NodeJS.ProcessEnv, {
      ARK_API_KEY: "super-secret-value-abcd",
      SEEDREAM_MODEL_ID: "seedream-4-0-250828",
    });

    const ark = described.find((s) => s.key === "ARK_API_KEY");
    expect(ark?.hint).toBe("…abcd");
    expect(ark?.hint).not.toContain("super-secret");

    // A model id is not a secret, and is far easier to correct when visible.
    const model = described.find((s) => s.key === "SEEDREAM_MODEL_ID");
    expect(model?.hint).toBe("seedream-4-0-250828");
  });

  it("lists a key that has never been set, so it can be discovered", () => {
    const described = describeSettings({} as NodeJS.ProcessEnv, {});
    const fal = described.find((s) => s.key === "FAL_KEY");
    expect(fal?.source).toBe("unset");
    expect(fal?.hint).toBeUndefined();
    expect(fal?.help).toBeTruthy();
  });
});

describe("the settings route", () => {
  let service: TestService;

  beforeAll(async () => {
    service = await startTestService({ ownRegistry: true });
  });

  afterAll(async () => {
    await service.close();
  });

  it("needs the session token", async () => {
    const response = await fetch(`${service.baseUrl}/v1/settings`);
    expect(response.status).toBe(401);
  });

  it("never returns a stored secret, by any route", async () => {
    writeCredentials({ ARK_API_KEY: "super-secret-value-abcd" }, file);

    const response = await service.call("/v1/settings");
    expect(response.status).toBe(200);
    const body = await readJson(response);

    // The whole payload, not just the field we expect it in.
    expect(JSON.stringify(body)).not.toContain("super-secret-value-abcd");
    const ark = body.settings.find(
      (s: { key: string }) => s.key === "ARK_API_KEY",
    );
    expect(ark.source).toBe("panel");
    expect(ark.hint).toBe("…abcd");
    expect(body.storedAt).toBe(file);
  });

  it("saves a key and brings the provider it unlocks online without a restart", async () => {
    const before = await readJson(await service.call("/v1/providers"));
    const beforeIds = before.providers.map((p: { id: string }) => p.id);
    expect(beforeIds).not.toContain("seedream");

    const response = await service.call("/v1/settings", {
      method: "POST",
      body: JSON.stringify({
        values: {
          ARK_API_KEY: "ark-test-key",
          SEEDREAM_MODEL_ID: "seedream-4-0-250828",
        },
      }),
    });
    expect(response.status).toBe(200);
    const saved = await readJson(response);
    expect(saved.providers).toContain("seedream");

    // And the running service agrees — the registry was refilled in place,
    // not swapped, so every holder of it sees the new set.
    const after = await readJson(await service.call("/v1/providers"));
    expect(after.providers.map((p: { id: string }) => p.id)).toContain("seedream");
  });

  it("rejects a key it does not advertise instead of writing it", async () => {
    const response = await service.call("/v1/settings", {
      method: "POST",
      body: JSON.stringify({ values: { NODE_OPTIONS: "--inspect" } }),
    });
    expect(response.status).toBe(400);
    expect(readCredentials(file).NODE_OPTIONS).toBeUndefined();
  });
});
