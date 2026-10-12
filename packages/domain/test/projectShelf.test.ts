import { describe, expect, it } from "vitest";
import {
  elementFamily,
  elementKey,
  fileElementKey,
  parentFirst,
  planProjectShelf,
  SHELF,
  STAGE,
  type ProjectItem,
} from "../src/projectShelf.js";

/**
 * The fixture is the real project, not a toy.
 *
 * Twenty-eight comps read out of `ANUAL_SUMMIT_..._leftwind_v006.aep` with
 * `projectComps`, names and sizes unaltered — including the parts that make
 * the rules awkward. `Rooftop01 Comp 1` has no live comp called `Rooftop01`
 * because the animated version was rebuilt as `PartyCrew01`; `GYG_RIGHT_PSD`
 * is a plate that was imported as a composition; `Bunting01` is named like
 * an element and is nothing like one. A fixture that left those out would
 * pass and prove nothing.
 */
const COMPS: Array<[string, string, number]> = [
  ["993", "Bunting01", 1],
  ["1006", "Bunting02", 1],
  ["954", "Bunting03", 1],
  ["967", "Bunting04", 1],
  ["895", "Bunting05", 1],
  ["980", "Bunting06", 1],
  ["461", "Cafe01 Comp 1", 1],
  ["393", "Cafe02 Comp 1", 1],
  ["764", "CafeFriends01", 1],
  ["820", "Car01", 1],
  ["299", "Car01 Comp 1", 1],
  ["1019", "Clouds01", 1],
  ["1032", "Clouds02", 1],
  ["319", "Delivery01 Comp 1", 1],
  ["835", "DeliveryCyclist01", 1],
  ["157", "GYG_RIGHT_PSD", 0],
  ["503", "GYG_Sides-Left_v001", 0],
  ["1081", "GYG_Sides-Left_v002", 0],
  ["636", "GYG_Sides-Right_v001", 0],
  ["736", "Mariachi01", 1],
  ["420", "Mariachi01 Comp 1", 1],
  ["751", "PartyCrew01", 1],
  ["440", "Rooftop01 Comp 1", 1],
  ["777", "TacoDate01", 1],
  ["865", "Waiter01", 1],
  ["880", "WindowWorker01", 1],
  ["352", "Woman01 Comp 1", 1],
  ["850", "WomanWalking01", 1],
];

function projectComps(): ProjectItem[] {
  return COMPS.map(([id, name, usedInCount]) => ({
    id,
    name,
    kind: "comp" as const,
    folder: "",
    usedInCount,
  }));
}

/** Where the plan sends one item, by name. */
function destination(items: ProjectItem[], name: string): string | undefined {
  return planProjectShelf(items).moves.find((move) => move.expectName === name)?.folder;
}

describe("reading an element out of a name", () => {
  it("takes the element itself, the grouping it came from, and a generated file", () => {
    expect(elementKey("Car01")).toBe("Car01");
    expect(elementKey("Car01 Comp 1")).toBe("Car01");
    expect(elementKey("CafeFriends01")).toBe("CafeFriends01");
    expect(elementKey("WomanWalking01")).toBe("WomanWalking01");
  });

  it("refuses names that are not elements", () => {
    // The delivery comps and the plates. `v002` is not a two-digit suffix on
    // a family name, and the underscores are not word boundaries here.
    expect(elementKey("GYG_Sides-Left_v002")).toBeUndefined();
    expect(elementKey("GYG_RIGHT_PSD")).toBeUndefined();
    expect(elementKey("Coastal Countryside Panorama")).toBeUndefined();
  });

  it("anchors at the start, so a stage is never filed under a later mention", () => {
    // If this matched anywhere in the string, a comp named for one element
    // that mentions another would land in the wrong folder and look right.
    expect(elementKey("Rooftop01 Comp 1")).toBe("Rooftop01");
    expect(elementKey("comp for Car01")).toBeUndefined();
  });

  it("splits a key into its family", () => {
    expect(elementFamily("Bunting03")).toBe("Bunting");
    expect(elementFamily("CafeFriends01")).toBe("CafeFriends");
  });

  it("matches a loose filename against keys that exist, longest first", () => {
    const known = ["Cafe01", "CafeFriends01", "Car01"];
    // The trap: `Cafe01` is a substring of nothing here, but a shorter key
    // can still win a longer name if the list is walked in the wrong order.
    expect(fileElementKey("cafefriends01_table_v2.mp4", known)).toBe("CafeFriends01");
    expect(fileElementKey("CAR01_drive.mov", known)).toBe("Car01");
    expect(fileElementKey("a_plate.png", known)).toBeUndefined();
  });
});

describe("the shelf, on the real project", () => {
  const items = projectComps();
  const plan = planProjectShelf(items);

  it("places every comp in the project", () => {
    // Twenty-eight comps in, twenty-eight decisions out. The one number that
    // says a rule did not quietly skip a shape it had not met.
    expect(plan.moves.length + plan.alreadySorted + plan.unsorted.length).toBe(items.length);
    expect(plan.unsorted).toEqual([]);
  });

  it("sends the newest version of each surface to delivery", () => {
    expect(destination(items, "GYG_Sides-Left_v002")).toBe(SHELF.delivery);
    // Right side has only a v001, so its newest version is v001.
    expect(destination(items, "GYG_Sides-Right_v001")).toBe(SHELF.delivery);
  });

  it("archives the superseded version rather than deleting it", () => {
    expect(destination(items, "GYG_Sides-Left_v001")).toBe(SHELF.archive);
    const move = plan.moves.find((entry) => entry.expectName === "GYG_Sides-Left_v001");
    expect(move?.reason).toContain("superseded");
  });

  it("gives each element its own folder, with the live comp at the top of it", () => {
    expect(destination(items, "Car01")).toBe(`${SHELF.elements}/Car01`);
    expect(destination(items, "Waiter01")).toBe(`${SHELF.elements}/Waiter01`);
    expect(destination(items, "CafeFriends01")).toBe(`${SHELF.elements}/CafeFriends01`);
  });

  it("files a PSD grouping as the element's source stage", () => {
    expect(destination(items, "Car01 Comp 1")).toBe(`${SHELF.elements}/Car01/${STAGE.source}`);
  });

  it("still files a grouping whose animated version was rebuilt under a new name", () => {
    /*
     * `Rooftop01 Comp 1` is the rooftop crowd as it came out of the PSD; the
     * animated version is `PartyCrew01`. Nothing in the project records that
     * link, and inventing it would be guessing at the artwork — so the
     * grouping is filed under its own key and the reason says what it is.
     */
    expect(destination(items, "Rooftop01 Comp 1")).toBe(
      `${SHELF.elements}/Rooftop01/${STAGE.source}`,
    );
    const move = plan.moves.find((entry) => entry.expectName === "Rooftop01 Comp 1");
    expect(move?.reason).toContain("superseded under another name");

    // And the one that *does* have a live comp is described differently.
    const car = plan.moves.find((entry) => entry.expectName === "Car01 Comp 1");
    expect(car?.reason).toContain("precomposed from");
  });

  it("puts set dressing in a drawer instead of six folders of one item", () => {
    for (const name of ["Bunting01", "Bunting06"]) {
      expect(destination(items, name)).toBe(`${SHELF.generic}/bunting`);
    }
    expect(destination(items, "Clouds01")).toBe(`${SHELF.generic}/clouds`);
    // And no element folder was created for them.
    expect(plan.folders.filter((path) => /Bunting|Clouds/.test(path))).toEqual([]);
  });

  it("treats a PSD imported as a composition as a plate", () => {
    expect(destination(items, "GYG_RIGHT_PSD")).toBe(`${SHELF.generic}/plates`);
  });

  it("lists folders parents-first, so creating them in order always works", () => {
    const seen = new Set<string>();
    for (const path of plan.folders) {
      const parent = path.split("/").slice(0, -1).join("/");
      if (parent) expect(seen.has(parent)).toBe(true);
      seen.add(path);
    }
  });

  it("creates the four top-level drawers whatever is in the project", () => {
    for (const top of [SHELF.delivery, SHELF.elements, SHELF.generic, SHELF.archive]) {
      expect(plan.folders).toContain(top);
    }
    expect(planProjectShelf([]).folders).toHaveLength(4);
  });
});

describe("footage", () => {
  const base: ProjectItem[] = [
    { id: "820", name: "Car01", kind: "comp", folder: "", usedInCount: 1 },
    { id: "865", name: "Waiter01", kind: "comp", folder: "", usedInCount: 1 },
  ];

  it("sorts a generated clip and a still into the element's stages", () => {
    const items: ProjectItem[] = [
      ...base,
      {
        id: "900",
        name: "car01_drive_v3.mp4",
        kind: "footage",
        folder: "SEED",
        durationSeconds: 4,
        file: "D:\\SEEDD\\car01_drive_v3.mp4",
      },
      {
        id: "901",
        name: "waiter01_plate.png",
        kind: "footage",
        folder: "SEED",
        file: "D:\\SEEDD\\waiter01_plate.png",
      },
    ];
    expect(destination(items, "car01_drive_v3.mp4")).toBe(
      `${SHELF.elements}/Car01/${STAGE.clips}`,
    );
    expect(destination(items, "waiter01_plate.png")).toBe(
      `${SHELF.elements}/Waiter01/${STAGE.stills}`,
    );
  });

  it("calls a still a still even when it has a duration", () => {
    /*
     * After Effects gives an imported PNG a duration, so duration alone
     * cannot tell a clip from a plate — the extension has to win. Getting
     * this backwards files every captured frame as generated footage.
     */
    const items: ProjectItem[] = [
      ...base,
      {
        id: "902",
        name: "Car01_f00000_099.png",
        kind: "footage",
        folder: "",
        durationSeconds: 30,
        file: "D:\\SEEDD\\Car01_f00000_099.png",
      },
    ];
    expect(destination(items, "Car01_f00000_099.png")).toBe(
      `${SHELF.elements}/Car01/${STAGE.stills}`,
    );
  });

  it("drawers plates, solids and footage that belongs to no element", () => {
    const items: ProjectItem[] = [
      ...base,
      { id: "903", name: "gyg_as_SIDES_left_1 copy.psd", kind: "footage", folder: "" },
      { id: "904", name: "SEED backing", kind: "solid", folder: "Solids" },
      { id: "905", name: "Coastal Countryside Panorama", kind: "footage", folder: "" },
    ];
    expect(destination(items, "gyg_as_SIDES_left_1 copy.psd")).toBe(`${SHELF.generic}/plates`);
    expect(destination(items, "SEED backing")).toBe(`${SHELF.generic}/Solids`);
    expect(destination(items, "Coastal Countryside Panorama")).toBe(`${SHELF.generic}/footage`);
  });

  it("leaves a placeholder alone, because a render is still coming back for it", () => {
    const items: ProjectItem[] = [
      ...base,
      { id: "906", name: "Car01 pending", kind: "placeholder", folder: "SEED" },
    ];
    const plan = planProjectShelf(items);
    expect(plan.moves.find((move) => move.expectName === "Car01 pending")).toBeUndefined();
    expect(plan.unsorted.map((item) => item.name)).toEqual(["Car01 pending"]);
  });

  it("moves the Solids drawer itself rather than its contents", () => {
    const items: ProjectItem[] = [
      ...base,
      { id: "907", name: "Solids", kind: "folder", folder: "" },
    ];
    expect(destination(items, "Solids")).toBe(SHELF.generic);
  });

  it("leaves the import inbox at the root", () => {
    const items: ProjectItem[] = [...base, { id: "908", name: "SEED", kind: "folder", folder: "" }];
    const plan = planProjectShelf(items);
    expect(plan.moves.find((move) => move.expectName === "SEED")).toBeUndefined();
  });
});

describe("running it a second time", () => {
  it("asks for nothing once the project is already sorted", () => {
    /*
     * The property that makes this a convention rather than an afternoon.
     * Applying the plan, re-reading the project and planning again has to
     * produce no moves, or the shelf is something that gets re-shuffled every
     * time somebody runs it.
     */
    const items = projectComps();
    const plan = planProjectShelf(items);
    const sorted = items.map((item) => {
      const move = plan.moves.find((entry) => entry.itemId === item.id);
      return move ? { ...item, folder: move.folder } : item;
    });

    const again = planProjectShelf(sorted);
    expect(again.moves).toEqual([]);
    expect(again.alreadySorted).toBe(items.length);
    // And it still wants the same folders to exist.
    expect(again.folders).toEqual(plan.folders);
  });
});

describe("parentFirst", () => {
  it("dedupes and sorts shallowest first", () => {
    expect(parentFirst(["a/b/c", "a", "a/b", "a"])).toEqual(["a", "a/b", "a/b/c"]);
  });
});
