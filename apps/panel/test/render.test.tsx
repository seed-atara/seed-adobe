import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Server-rendering smoke tests. They will not replace clicking through the
 * panel in After Effects, but they do catch the failures that are cheap to
 * catch: a broken import, a hook used illegally, a view that throws on its
 * first render before any data arrives.
 */

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    window: { location: { protocol: "http:" }, setTimeout, clearTimeout },
  });
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  delete (globalThis as Record<string, unknown>).window;
});

async function render() {
  const { App } = await import("../src/App.tsx");
  return renderToString(createElement(App));
}

describe("panel shell", () => {
  it("asks for a session token when none is stored", async () => {
    const html = await render();
    expect(html).toContain("session token");
    expect(html).toContain("Connect");
    // The token field must never render as a readable value.
    expect(html).toContain('type="password"');
  });

  it("renders the working shell once a token exists", async () => {
    store.set("seed-ae.session-token", "demo-token");
    const html = await render();

    expect(html).toContain("SEED");
    for (const tab of ["generate", "library", "lineage"]) {
      expect(html).toContain(tab);
    }
    expect(html).toContain("Capture current frame");
  });
});

describe("views render before any data arrives", () => {
  it("shows empty states rather than throwing", async () => {
    const { LibraryView } = await import("../src/components/LibraryView.tsx");
    const { LineageView } = await import("../src/components/LineageView.tsx");
    const { SeedClient } = await import("../src/api/client.ts");
    const client = new SeedClient("", "token");

    const library = renderToString(
      createElement(LibraryView, {
        client,
        assets: [],
        onSelect: () => undefined,
      }),
    );
    expect(library).toContain("Nothing captured yet");

    const lineage = renderToString(
      createElement(LineageView, { client, onSelect: () => undefined }),
    );
    expect(lineage).toContain("Select an asset");
  });
});

describe("SeedClient", () => {
  it("requests the thumbnail variant when one exists", async () => {
    const { SeedClient } = await import("../src/api/client.ts");
    const client = new SeedClient("http://svc", "token");
    const base = {
      id: "ast_1",
      kind: "image" as const,
      status: "ready" as const,
      filename: "a.png",
      mimeType: "image/png",
      storageUri: "assets/generated/a.png",
      createdAt: "2026-08-09T10:00:00.000Z",
      source: { type: "imported" as const },
    };

    expect(client.assetFileUrl(base)).toBe("http://svc/v1/assets/ast_1/file");
    expect(
      client.assetFileUrl({ ...base, thumbnailUri: "assets/thumbnails/ast_1.png" }),
    ).toBe("http://svc/v1/assets/ast_1/file?variant=thumbnail");
  });

  it("surfaces a service error code rather than a raw HTTP failure", async () => {
    const { SeedClient, ServiceError } = await import("../src/api/client.ts");
    const client = new SeedClient("http://svc", "token");
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: { code: "unauthorized", message: "nope" } }),
        { status: 401 },
      )) as typeof fetch;

    try {
      await expect(client.health()).rejects.toBeInstanceOf(ServiceError);
      await client.health().catch((error: InstanceType<typeof ServiceError>) => {
        expect(error.code).toBe("unauthorized");
        expect(error.status).toBe(401);
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
