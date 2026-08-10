import { describe, expect, it } from "vitest";
import type { Asset } from "@seed-ae/domain";
import {
  assetToken,
  completeMention,
  findMentions,
  matchAssets,
  mentionQueryAt,
} from "../src/mentions.ts";

function asset(id: string, filename: string): Asset {
  return {
    id,
    kind: "image",
    status: "ready",
    filename,
    mimeType: "image/png",
    storageUri: `assets/originals/${filename}`,
    createdAt: "2026-08-10T00:00:00.000Z",
    source: { type: "after-effects" },
  } as Asset;
}

const ASSETS = [
  asset("ast_1", "Comp_1_f00074_001.png"),
  asset("ast_2", "seedream_76bbfe52_00.jpg"),
  asset("ast_3", "bar wide (final).png"),
];

describe("assetToken", () => {
  it("drops the extension and anything that would need quoting", () => {
    expect(assetToken(ASSETS[0] as Asset)).toBe("Comp_1_f00074_001");
    expect(assetToken(ASSETS[2] as Asset)).toBe("bar_wide_final_");
  });
});

describe("mentionQueryAt", () => {
  it("finds the mention being typed at the caret", () => {
    const text = "keep @Comp";
    expect(mentionQueryAt(text, text.length)).toEqual({
      query: "Comp",
      start: 5,
    });
  });

  it("treats a bare @ as an empty query, so the library opens", () => {
    expect(mentionQueryAt("use @", 5)).toEqual({ query: "", start: 4 });
  });

  it("is silent once the mention is finished", () => {
    expect(mentionQueryAt("use @Comp_1 and ", 16)).toBeUndefined();
  });

  it("only looks at the text before the caret", () => {
    expect(mentionQueryAt("use @Comp_1", 3)).toBeUndefined();
  });
});

describe("matchAssets", () => {
  it("matches on any part of the token, case-insensitively", () => {
    expect(matchAssets(ASSETS, "seedream").map((item) => item.id)).toEqual([
      "ast_2",
    ]);
    expect(matchAssets(ASSETS, "f00074").map((item) => item.id)).toEqual([
      "ast_1",
    ]);
  });

  it("offers everything for an empty query", () => {
    expect(matchAssets(ASSETS, "")).toHaveLength(3);
  });
});

describe("completeMention", () => {
  it("replaces the partial mention and leaves the caret after it", () => {
    const text = "keep @Comp";
    const result = completeMention(text, text.length, ASSETS[0] as Asset);
    expect(result.text).toBe("keep @Comp_1_f00074_001 ");
    expect(result.caret).toBe(result.text.length);
  });

  it("keeps whatever follows the caret intact", () => {
    const result = completeMention("keep @Comp but colder", 10, ASSETS[0] as Asset);
    expect(result.text).toBe("keep @Comp_1_f00074_001  but colder");
  });
});

describe("findMentions", () => {
  it("resolves mentions to assets", () => {
    expect(
      findMentions("@Comp_1_f00074_001 relit like @seedream_76bbfe52_00", ASSETS),
    ).toEqual([
      { token: "Comp_1_f00074_001", assetId: "ast_1" },
      { token: "seedream_76bbfe52_00", assetId: "ast_2" },
    ]);
  });

  it("ignores an @ that does not name anything, rather than complaining", () => {
    expect(findMentions("shot @golden hour, email @nobody", ASSETS)).toEqual([]);
  });

  it("reports a repeated mention once", () => {
    expect(
      findMentions("@Comp_1_f00074_001 and @Comp_1_f00074_001", ASSETS),
    ).toHaveLength(1);
  });
});
