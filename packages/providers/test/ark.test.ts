import { describe, expect, it, vi } from "vitest";
import {
  ArkAssetLibrary,
  ArkOpenApiClient,
  MODEL_MIN_PIXELS,
  assertModelAvailable,
  assertSizeAllowed,
  parseExplicitSize,
  signArkRequest,
  sizesFor,
} from "../src/index.js";

const CREDENTIALS = {
  accessKeyId: "AKTESTKEY",
  secretAccessKey: "test-secret",
};

describe("signArkRequest", () => {
  const signed = signArkRequest(CREDENTIALS, {
    method: "POST",
    host: "open.byteplusapi.com",
    query: "Action=ListAssets&Version=2024-01-01",
    body: Buffer.from('{"PageNumber":1}', "utf8"),
    region: "ap-southeast-1",
    service: "ark",
    date: new Date("2026-08-09T12:34:56.789Z"),
  });

  it("uses the X-Date form, not an ISO timestamp", () => {
    expect(signed["x-date"]).toBe("20260809T123456Z");
  });

  it("hashes the body into x-content-sha256", () => {
    // sha256 of the exact payload bytes.
    expect(signed["x-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scopes the credential with the literal 'request' terminator", () => {
    expect(signed.authorization).toContain(
      "Credential=AKTESTKEY/20260809/ap-southeast-1/ark/request",
    );
    expect(signed.authorization).not.toContain("aws4_request");
    expect(signed.authorization).toContain(
      "SignedHeaders=content-type;host;x-content-sha256;x-date",
    );
  });

  it("is deterministic for a fixed instant and changes with the body", () => {
    const again = signArkRequest(CREDENTIALS, {
      method: "POST",
      host: "open.byteplusapi.com",
      query: "Action=ListAssets&Version=2024-01-01",
      body: Buffer.from('{"PageNumber":1}', "utf8"),
      region: "ap-southeast-1",
      service: "ark",
      date: new Date("2026-08-09T12:34:56.789Z"),
    });
    expect(again.authorization).toBe(signed.authorization);

    const different = signArkRequest(CREDENTIALS, {
      method: "POST",
      host: "open.byteplusapi.com",
      query: "Action=ListAssets&Version=2024-01-01",
      body: Buffer.from('{"PageNumber":2}', "utf8"),
      region: "ap-southeast-1",
      service: "ark",
      date: new Date("2026-08-09T12:34:56.789Z"),
    });
    expect(different.authorization).not.toBe(signed.authorization);
  });
});

function stubFetch(handler: (body: unknown, url: string) => unknown) {
  return (async (url: string, init: RequestInit) => {
    const payload = handler(JSON.parse(String(init.body)), String(url));
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("ArkOpenApiClient", () => {
  it("always sends the required Filter on ListAssetGroups", async () => {
    let sent: Record<string, unknown> | undefined;
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: stubFetch((body) => {
        sent = body as Record<string, unknown>;
        return { Result: { Items: [] } };
      }),
    });

    await client.listAssetGroups();
    expect(sent?.Filter).toEqual({ GroupType: "AIGC" });
  });

  it("unwraps Result and raises documented errors with a fix", async () => {
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: stubFetch(() => ({
        ResponseMetadata: {
          Error: { Code: "InvalidParameter.DownloadFailed", Message: "nope" },
        },
      })),
    });

    await expect(
      client.createAsset({ groupId: "g", url: "https://x/y.png", name: "n" }),
    ).rejects.toThrow(/publicly reachable over https/);
  });

  it("explains a bare 404 as a wrong OpenAPI host", async () => {
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: (async () => new Response("", { status: 404 })) as
        unknown as typeof fetch,
    });
    await expect(client.getAsset("a")).rejects.toThrow(
      /open\.ap-southeast-1\.byteplusapi\.com/,
    );
  });

  it("names the resource-package cause for ModelNotOpen", async () => {
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: stubFetch(() => ({
        ResponseMetadata: { Error: { Code: "ModelNotOpen", Message: "off" } },
      })),
    });
    await expect(client.listAssets()).rejects.toThrow(/resource package/);
  });
});

describe("ArkAssetLibrary", () => {
  const bytes = Buffer.from("pretend png bytes");
  const sha16 = ArkAssetLibrary.contentHash(bytes);

  const publisher = {
    publish: vi.fn(async () => ({
      url: "https://signed.example/ref.png",
      dispose: vi.fn(async () => undefined),
    })),
  };

  function libraryWith(handler: (action: string, body: any) => unknown) {
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: (async (url: string, init: RequestInit) => {
        const action = /Action=([A-Za-z]+)/.exec(String(url))?.[1] ?? "";
        return new Response(
          JSON.stringify(handler(action, JSON.parse(String(init.body)))),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    return new ArkAssetLibrary({
      client,
      publisher,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
  }

  it("reuses an existing registration found by content hash", async () => {
    const library = libraryWith((action) => {
      if (action === "ListAssets") {
        return {
          Result: {
            Items: [{ Id: "asset-1", Name: `ref_${sha16}`, Status: "Active" }],
          },
        };
      }
      throw new Error(`unexpected action ${action}`);
    });

    const resolved = await library.ensureAsset({
      bytes,
      filename: "ref.png",
      mimeType: "image/png",
    });
    expect(resolved).toEqual({ assetId: "asset-1", cached: true });
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it("registers, polls until Active, and names the asset with the hash", async () => {
    let statusCalls = 0;
    let createdName: string | undefined;

    const library = libraryWith((action, body) => {
      if (action === "ListAssets") return { Result: { Items: [] } };
      if (action === "ListAssetGroups") {
        return { Result: { Items: [{ Id: "group-1", Name: "seed-ae" }] } };
      }
      if (action === "CreateAsset") {
        createdName = body.Name;
        return { Result: { Id: "asset-9" } };
      }
      if (action === "GetAsset") {
        statusCalls += 1;
        return {
          Result: { Id: "asset-9", Status: statusCalls < 2 ? "Processing" : "Active" },
        };
      }
      throw new Error(`unexpected action ${action}`);
    });

    const resolved = await library.ensureAsset({
      bytes,
      filename: "hero frame.png",
      mimeType: "image/png",
    });

    expect(resolved).toEqual({ assetId: "asset-9", cached: false });
    expect(createdName).toBe(`hero_frame_${sha16}`);
    expect(statusCalls).toBe(2);

    // Second call for the same pixels is a local cache hit.
    const again = await library.ensureAsset({
      bytes,
      filename: "hero frame.png",
      mimeType: "image/png",
    });
    expect(again.cached).toBe(true);
  });

  it("raises when preprocessing fails rather than returning a dead id", async () => {
    const library = libraryWith((action) => {
      if (action === "ListAssets") return { Result: { Items: [] } };
      if (action === "ListAssetGroups") {
        return { Result: { Items: [{ Id: "group-1", Name: "seed-ae" }] } };
      }
      if (action === "CreateAsset") return { Result: { Id: "asset-bad" } };
      return { Result: { Id: "asset-bad", Status: "Failed" } };
    });

    await expect(
      library.ensureAsset({ bytes, filename: "x.png", mimeType: "image/png" }),
    ).rejects.toThrow(/failed preprocessing/);
  });

  it("refuses to register without a publisher, naming why", async () => {
    const client = new ArkOpenApiClient({
      ...CREDENTIALS,
      fetchImpl: stubFetch(() => ({ Result: { Items: [] } })),
    });
    const library = new ArkAssetLibrary({ client });
    await expect(
      library.ensureAsset({ bytes, filename: "x.png", mimeType: "image/png" }),
    ).rejects.toThrow(/rejects data: URLs/);
  });
});

describe("model constraints", () => {
  it("rejects a size below the model minimum with the numbers", () => {
    expect(() => assertSizeAllowed("seedream-5-0-260128", "1024x1024")).toThrow(
      /requires at least 3,686,400 pixels/,
    );
    // Exactly at the minimum is allowed.
    expect(() =>
      assertSizeAllowed("seedream-5-0-260128", "2560x1440"),
    ).not.toThrow();
    expect(() =>
      assertSizeAllowed("seedream-4-0-250828", "1024x1024"),
    ).not.toThrow();
  });

  it("passes keyword sizes through to the API", () => {
    for (const size of ["2K", "4K"]) {
      expect(() => assertSizeAllowed("seedream-5-0-260128", size)).not.toThrow();
    }
  });

  it("enforces the aspect-ratio bounds", () => {
    expect(() => assertSizeAllowed("seedream-4-0-250828", "4000x100")).toThrow(
      /aspect ratio/,
    );
  });

  it("only offers sizes a model will accept", () => {
    const strict = sizesFor("seedream-5-0-260128");
    expect(strict).toContain("2K");
    expect(strict).not.toContain("1024x1024");
    for (const size of strict.filter((s) => s.includes("x"))) {
      const parsed = parseExplicitSize(size);
      expect((parsed?.width ?? 0) * (parsed?.height ?? 0)).toBeGreaterThanOrEqual(
        MODEL_MIN_PIXELS["seedream-5-0-260128"] as number,
      );
    }
    expect(sizesFor("seedream-4-0-250828")).toContain("1024x1024");
  });

  it("refuses the withdrawn seededit model", () => {
    expect(() => assertModelAvailable("seededit-3-0-i2i-250628")).toThrow(
      /withdrawn by the vendor/,
    );
  });
});
