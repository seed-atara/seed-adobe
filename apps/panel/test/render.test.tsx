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

describe("windows 95 chrome", () => {
  it("renders a title bar and status cells, not a bare page", async () => {
    store.set("seed-ae.session-token", "demo-token");
    const html = await render();
    expect(html).toContain('class="titlebar"');
    expect(html).toContain('class="statusbar"');
    expect(html).toContain('class="led');
    // Tabs are the 95 tab control, and views sit inside group boxes.
    expect(html).toContain('role="tablist"');
    expect(html).toContain('class="section"');
    expect(html).toContain('class="section-label"');
  });

  it("frames the connect prompt as a dialog with a title bar", async () => {
    const html = await render();
    expect(html).toContain('class="titlebar"');
    expect(html).toContain("Connect to SEED service");
    expect(html).toContain('class="notice"');
    expect(html).toContain(">OK<");
  });
});

describe("media loading", () => {
  it("never puts the session token in an image URL", async () => {
    const { SeedClient } = await import("../src/api/client.ts");
    const client = new SeedClient("http://svc", "secret-token");

    let requested: { url: string; init: RequestInit } | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requested = { url: String(url), init };
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      await client.assetBlob(
        {
          id: "ast_1",
          kind: "image",
          status: "ready",
          filename: "a.png",
          mimeType: "image/png",
          storageUri: "assets/generated/a.png",
          thumbnailUri: "assets/thumbnails/ast_1.png",
          createdAt: "2026-08-09T10:00:00.000Z",
          source: { type: "imported" },
        },
        "thumbnail",
      );
    } finally {
      globalThis.fetch = original;
    }

    expect(requested?.url).toBe(
      "http://svc/v1/assets/ast_1/file?variant=thumbnail",
    );
    expect(requested?.url).not.toContain("secret-token");
    // The token travels in the header, where it belongs.
    expect(
      (requested?.init.headers as Record<string, string>).authorization,
    ).toBe("Bearer secret-token");
  });
});

describe("host scripts", () => {
  it("expose the same functions in After Effects and Premiere", async () => {
    // The panel calls the same names in both applications; if these drift,
    // one host silently loses a feature.
    const { readFile } = await import("node:fs/promises");
    const required = [
      "seedPing",
      "seedGetContext",
      "seedCaptureFrame",
      "seedImport",
      "seedInsertAtPlayhead",
    ];

    for (const file of [
      "apps/extension/jsx/seed-host.jsx",
      "apps/extension/jsx/seed-host-ppro.jsx",
    ]) {
      const source = await readFile(file, "utf8");
      for (const name of required) {
        expect(source, `${file} is missing ${name}`).toContain(`function ${name}(`);
      }

      /*
       * Both scripts share one ExtendScript engine and CEP re-evaluates its own
       * ScriptPath whenever it likes, so the generic names cannot be trusted to
       * belong to the script the panel loaded. Each host must also export
       * uniquely prefixed aliases, which is what the panel actually calls.
       */
      const prefix = file.includes("ppro") ? "seedPpro_" : "seedAeft_";
      for (const alias of [
        "ping",
        "getContext",
        "captureFrame",
        "import",
        "insertAtPlayhead",
      ]) {
        expect(source, `${file} is missing ${prefix}${alias}`).toContain(
          `var ${prefix}${alias} =`,
        );
      }
      // Every host function must answer in the {ok,...} envelope.
      expect(source).toContain("function seedOk(");
      expect(source).toContain("function seedFail(");
    }
  });
});

describe("ExtendScript reserved words", () => {
  it("never declares a name that ExtendScript reserves", async () => {
    /*
     * ExtendScript is ES3 and keeps the ES3 future-reserved list, so `final`,
     * `int`, `class` and friends are illegal as identifiers. Node accepts them
     * happily, which is how `var final` shipped and broke the Premiere host at
     * load time with "Illegal use of reserved word".
     */
    const { readFile } = await import("node:fs/promises");
    const reserved = [
      "abstract", "boolean", "byte", "char", "class", "const", "debugger",
      "double", "enum", "export", "extends", "final", "float", "goto",
      "implements", "import", "int", "interface", "long", "native", "package",
      "private", "protected", "public", "short", "static", "super",
      "synchronized", "throws", "transient", "volatile",
    ];

    for (const file of [
      "apps/extension/jsx/seed-host.jsx",
      "apps/extension/jsx/seed-host-ppro.jsx",
    ]) {
      const source = await readFile(file, "utf8");
      for (const word of reserved) {
        const declaration = new RegExp(`\b(?:var|function)\s+${word}\b`);
        expect(
          declaration.test(source),
          `${file} declares the reserved word "${word}"`,
        ).toBe(false);
      }
    }
  });
});

describe("items", () => {
  /** A client stub: these tests are about rendering, not about the network. */
  function stubClient(overrides: Record<string, unknown> = {}) {
    return {
      listItems: async () => ({ items: [], total: 0 }),
      getItem: async () => ({ item: undefined }),
      adoptItem: async () => ({ item: undefined }),
      resolvePrompt: async () => ({ bundle: undefined }),
      ...overrides,
    } as never;
  }

  it("renders the empty state without a host, a token or a network", async () => {
    // The standalone tool is this component with no Adobe anywhere near it.
    const { ItemsView } = await import("../src/components/ItemsView.tsx");
    const html = renderToString(
      createElement(ItemsView, {
        client: stubClient(),
        assets: [],
        onError: () => {},
      }),
    );
    expect(html).toContain("No items yet");
    expect(html).toContain("@handle");
  });

  it("offers every kind, including style", async () => {
    const { ItemsView } = await import("../src/components/ItemsView.tsx");
    const html = renderToString(
      createElement(ItemsView, {
        client: stubClient(),
        assets: [],
        onError: () => {},
      }),
    );
    for (const kind of ["character", "location", "prop", "style"]) {
      expect(html).toContain(`>${kind}<`);
    }
  });

  it("draws nothing when the prompt mentions no item", async () => {
    const { PromptPreview } = await import("../src/components/PromptPreview.tsx");
    const html = renderToString(
      createElement(PromptPreview, {
        client: stubClient(),
        prompt: "a lighthouse at dusk",
        providerId: "mock-image",
        mentions: [],
        items: [],
        attachedAssetIds: [],
        allowBeyondStable: false,
        onMentionsChange: () => {},
        onAllowBeyondStable: () => {},
      }),
    );
    expect(html).toBe("");
  });

  it("says it is working before the resolved bundle arrives", async () => {
    const { PromptPreview } = await import("../src/components/PromptPreview.tsx");
    const html = renderToString(
      createElement(PromptPreview, {
        client: stubClient(),
        prompt: "@sara at the bar",
        providerId: "mock-image",
        mentions: [
          { token: "sara", itemId: "itm_1", influence: 70, muteText: false },
        ],
        items: [],
        attachedAssetIds: [],
        allowBeyondStable: false,
        onMentionsChange: () => {},
        onAllowBeyondStable: () => {},
      }),
    );
    expect(html).toContain("What will be sent");
  });
});
