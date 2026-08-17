import { describe, expect, it } from "vitest";
import type { Asset } from "@seed-ae/domain";
import {
  assetToken,
  completeItemMention,
  completeMention,
  findItemMentions,
  findMentions,
  matchAssets,
  matchItems,
  mentionQueryAt,
} from "../src/mentions.ts";
import { splitRuns } from "../src/components/PromptField.tsx";

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

describe("splitting a prompt for highlighting", () => {
  // The mirror renders these runs; a wrong split shows the mark on the wrong
  // words, which is worse than no highlight at all.
  it("marks a known mention and leaves the prose alone", () => {
    const runs = splitRuns("keep @Comp_1_f00074_001 but colder", ASSETS);
    expect(runs.map((run) => [run.text, run.asset?.id])).toEqual([
      ["keep ", undefined],
      ["@Comp_1_f00074_001", "ast_1"],
      [" but colder", undefined],
    ]);
  });

  it("leaves an @ that names nothing as ordinary prose", () => {
    const runs = splitRuns("shot at @golden hour", ASSETS);
    expect(runs).toEqual([{ text: "shot at @golden hour" }]);
  });

  it("marks every occurrence, including adjacent ones", () => {
    const runs = splitRuns(
      "@Comp_1_f00074_001 @seedream_76bbfe52_00",
      ASSETS,
    );
    expect(runs.filter((run) => run.asset).map((run) => run.asset?.id)).toEqual([
      "ast_1",
      "ast_2",
    ]);
  });

  it("reassembles into exactly the original text", () => {
    const text = "@Comp_1_f00074_001 relit, @nobody, @seedream_76bbfe52_00 end";
    expect(splitRuns(text, ASSETS).map((run) => run.text).join("")).toBe(text);
  });
});

describe("item mentions", () => {
  const items = [
    { id: "itm_1", handle: "sara", kind: "character", name: "Sara Kim" },
    { id: "itm_2", handle: "bar", kind: "location", name: "The Bar" },
    { id: "itm_3", handle: "kodak_night", kind: "style", name: "Kodak Night" },
  ];

  it("finds handles and keeps a variant token distinct", () => {
    const found = findItemMentions("wide of @sara/night in @bar", items);
    expect(found.map((entry) => entry.token)).toEqual(["sara/night", "bar"]);
    expect(found[0]?.item.id).toBe("itm_1");
  });

  it("ignores an @ that names nothing", () => {
    // Prose containing an @ for some other reason is ordinary writing.
    expect(findItemMentions("shot at 5pm @ the bar", items)).toEqual([]);
  });

  it("does not repeat an item mentioned twice", () => {
    expect(findItemMentions("@sara turns, then @sara walks", items)).toHaveLength(1);
  });

  it("ranks a prefix match above a substring, and matches on name", () => {
    expect(matchItems(items, "ba")[0]?.handle).toBe("bar");
    expect(matchItems(items, "kim")[0]?.handle).toBe("sara");
  });

  it("completes the handle being typed at the caret", () => {
    const text = "wide of @sa";
    const result = completeItemMention(text, text.length, items[1]!);
    expect(result.text).toBe("wide of @bar ");
    expect(result.caret).toBe(result.text.length);
  });
});
