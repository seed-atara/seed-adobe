import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AssetResponseSchema,
  HealthResponseSchema,
  ListAssetsResponseSchema,
} from "@seed-ae/domain";
import { LATEST_SCHEMA_VERSION } from "@seed-ae/storage";
import { readJson, startTestService, type TestService } from "./helpers.js";

let service: TestService;

beforeAll(async () => {
  service = await startTestService();
});

afterAll(async () => {
  await service.close();
});

describe("GET /health", () => {
  it("answers without a session token and reports the schema version", async () => {
    const response = await fetch(`${service.baseUrl}/health`);
    expect(response.status).toBe(200);
    const health = HealthResponseSchema.parse(await response.json());
    expect(health.status).toBe("ok");
    expect(health.database.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
  });
});

describe("authentication", () => {
  it("rejects requests with no token", async () => {
    const response = await fetch(`${service.baseUrl}/v1/assets`);
    expect(response.status).toBe(401);
    expect((await readJson(response)).error.code).toBe("unauthorized");
  });

  it("rejects a wrong token, including one of a different length", async () => {
    for (const token of ["nope", "test-token-abd", ""]) {
      const response = await fetch(`${service.baseUrl}/v1/assets`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(401);
    }
  });
});

describe("routing", () => {
  it("returns not_found for an unknown path and 405 for a wrong method", async () => {
    const missing = await service.call("/v1/nope");
    expect(missing.status).toBe(404);

    const wrongMethod = await service.call("/v1/assets/anything", {
      method: "POST",
      body: "{}",
    });
    expect(wrongMethod.status).toBe(405);
  });
});

describe("capture → register → library loop", () => {
  it("captures the current AE frame and registers it with its provenance", async () => {
    const contextResponse = await service.call("/v1/ae/context");
    expect(contextResponse.status).toBe(200);
    const { context, host } = await readJson(contextResponse);
    expect(host).toBe("mock");
    expect(context.compName).toBe("HERO_SHOT_v003");

    const captureResponse = await service.call("/v1/ae/capture-frame", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(captureResponse.status).toBe(201);
    const { asset } = AssetResponseSchema.parse(await captureResponse.json());

    expect(asset.kind).toBe("image");
    expect(asset.mimeType).toBe("image/png");
    expect(asset.width).toBe(context.width);
    expect(asset.storageUri.startsWith("assets/originals/")).toBe(true);
    expect(asset.byteSize).toBeGreaterThan(0);
    if (asset.source.type !== "after-effects") throw new Error("wrong source");
    expect(asset.source.context.compName).toBe("HERO_SHOT_v003");
    expect(asset.source.context.frameNumber).toBe(context.frameNumber);

    const fetched = await service.call(`/v1/assets/${asset.id}`);
    expect(AssetResponseSchema.parse(await fetched.json()).asset).toEqual(asset);

    const listed = await service.call("/v1/assets?kind=image&limit=10");
    const list = ListAssetsResponseSchema.parse(await listed.json());
    expect(list.assets.some((a) => a.id === asset.id)).toBe(true);

    const file = await service.call(`/v1/assets/${asset.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.length).toBe(asset.byteSize);
    expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("keeps each capture as its own asset instead of overwriting", async () => {
    const first = await readJson(
      await service.call("/v1/ae/capture-frame", { method: "POST", body: "{}" }),
    );
    const second = await readJson(
      await service.call("/v1/ae/capture-frame", { method: "POST", body: "{}" }),
    );
    expect(first.asset.id).not.toBe(second.asset.id);
    expect(first.asset.storageUri).not.toBe(second.asset.storageUri);
  });
});

describe("POST /v1/assets", () => {
  it("registers an imported asset", async () => {
    const response = await service.call("/v1/assets", {
      method: "POST",
      body: JSON.stringify({
        kind: "image",
        filename: "plate.png",
        mimeType: "image/png",
        storageUri: "assets/originals/plate.png",
        source: { type: "imported", originalPath: "C:/Client Work/plate.png" },
      }),
    });
    expect(response.status).toBe(201);
    expect(AssetResponseSchema.parse(await response.json()).asset.status).toBe(
      "ready",
    );
  });

  it("rejects a storage URI that escapes the workspace", async () => {
    const response = await service.call("/v1/assets", {
      method: "POST",
      body: JSON.stringify({
        kind: "image",
        filename: "evil.png",
        mimeType: "image/png",
        storageUri: "../../../.env",
        source: { type: "imported" },
      }),
    });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("bad_request");
  });

  it("reports validation failures field by field", async () => {
    const response = await service.call("/v1/assets", {
      method: "POST",
      body: JSON.stringify({ kind: "hologram", filename: "x.png" }),
    });
    expect(response.status).toBe(400);
    const body = await readJson(response);
    expect(body.error.code).toBe("bad_request");
    expect(Array.isArray(body.error.details)).toBe(true);
    expect(body.error.details.map((d: { path: string }) => d.path)).toContain(
      "kind",
    );
  });

  it("rejects a non-JSON content type", async () => {
    const response = await service.call("/v1/assets", {
      method: "POST",
      body: "kind=image",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(response.status).toBe(400);
  });
});

describe("GET /v1/assets/:id/file", () => {
  it("marks an asset missing when its media disappeared", async () => {
    const { asset } = await readJson(
      await service.call("/v1/assets", {
        method: "POST",
        body: JSON.stringify({
          kind: "image",
          filename: "ghost.png",
          mimeType: "image/png",
          storageUri: "assets/originals/ghost.png",
          source: { type: "imported" },
        }),
      }),
    );

    const response = await service.call(`/v1/assets/${asset.id}/file`);
    expect(response.status).toBe(404);
    // The row survives: provenance is never dropped because bytes went away.
    const reloaded = await readJson(await service.call(`/v1/assets/${asset.id}`));
    expect(reloaded.asset.status).toBe("missing");
  });
});
