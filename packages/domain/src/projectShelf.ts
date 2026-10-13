/**
 * Where things live in the Project panel, as a rule rather than an afternoon.
 *
 * A projection assembled over weeks arrives flat. Twenty-eight compositions,
 * every PSD and every generated clip loose in the root, in whatever order
 * After Effects happened to add them. Nothing is wrong with the project and
 * nothing can be found in it.
 *
 * Tidying it once is worth little. The next batch of imports lands in the
 * root again, the next entity is precomposed to `Something01 Comp 1` again,
 * and a month later it looks exactly as it did. So this is a *function* from
 * an inventory to a set of moves: run it today, run it after the next import,
 * get the same shelf either time. That is the only version of "and stick to
 * that way of working" a project can actually hold.
 *
 * The host end of this (`createFolders`, `moveItems` in `seed-host.jsx`)
 * deliberately decides nothing. It makes folders by path and moves items into
 * them. Every judgement about what belongs where is here, where it can be
 * tested without opening After Effects.
 *
 * ## The shelf
 *
 * ```
 * 00_DELIVERY/      the comps that get rendered, newest version of each
 * 10_ELEMENTS/
 *     Car01/
 *         Car01             the live comp
 *         01_source/        the PSD grouping it was precomposed from
 *         02_stills/        captured plates
 *         03_clips/         generated footage
 * 20_GENERIC/       plates, solids, bunting, clouds, loose footage
 * 90_ARCHIVE/       superseded versions, kept rather than deleted
 * SEED/             the import inbox the host already writes into
 * ```
 *
 * Numbered because the Project panel sorts alphabetically and there is no
 * other way to make delivery sit above elements.
 */

/** One item as `projectItems` reports it. */
export interface ProjectItem {
  id: string;
  name: string;
  kind: "comp" | "footage" | "folder" | "solid" | "placeholder" | "other";
  /** Slash-separated, `""` for the project root. */
  folder: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  layerCount?: number;
  /** How many comps use it. Zero means nothing references it. */
  usedInCount?: number;
  /** Absolute path, for footage that came from a file. */
  file?: string;
}

export interface ShelfMove {
  itemId: string;
  folder: string;
  /**
   * The name the plan was built from.
   *
   * An item id is a project-session number, so the host refuses a move whose
   * id now points at something else rather than guessing. Carrying the name
   * is what makes a plan safe to apply a minute after it was computed.
   */
  expectName: string;
  /** Which rule placed it, so a plan can be read before it is applied. */
  reason: string;
}

export interface ShelfPlan {
  /** Parent-first, so creating them in order never needs a missing parent. */
  folders: string[];
  moves: ShelfMove[];
  /** Already where the rule wants them. */
  alreadySorted: number;
  /**
   * Left inside a folder somebody else already made.
   *
   * After Effects groups a layered PSD's layers into `<name> Layers` itself,
   * and the host puts generated media in `SEED`. Both are better than any
   * drawer this could invent, so items in them are only moved when they
   * positively belong to an element. 297 of this project's 333 items are in
   * that position, and the first version of these rules wanted to move all
   * of them.
   */
  leftInPlace: number;
  /** No rule claimed these. Left exactly where they are. */
  unsorted: ProjectItem[];
}

export const SHELF = {
  delivery: "00_DELIVERY",
  elements: "10_ELEMENTS",
  generic: "20_GENERIC",
  archive: "90_ARCHIVE",
  /** The host's own import folder. Left at the root on purpose: it is an inbox. */
  inbox: "SEED",
} as const;

/** The stages an element passes through, in the order it passes through them. */
export const STAGE = {
  source: "01_source",
  stills: "02_stills",
  clips: "03_clips",
} as const;

/**
 * The show's states, each a complete shelf of its own.
 *
 * The projection plays several looks of the same room -- the annual summit,
 * golden hour, the night transition, party city -- and they are not versions
 * of each other. Each has its own artwork, its own delivery comps and its own
 * elements, and the only thing they share is the room.
 *
 * So the state is the top of the tree rather than a tag inside it. A flat
 * shelf holding five states' worth of `Car01` is a shelf where nobody can
 * tell which Car01 is which.
 */
export const STATES = ["STATE1", "STATE2", "STATE3", "STATE4", "STATE5"] as const;

/**
 * Where to drop new artwork for a state.
 *
 * The state of an item is read from the folder it is already in, which leaves
 * one question: how does anything get into a state in the first place? It is
 * imported here, and the next run files it. Underscored so it sorts above the
 * numbered drawers -- it is the one folder a human puts things into.
 */
export const STATE_INBOX = "_INBOX";

export interface ShelfOptions {
  /**
   * Which state loose items belong to.
   *
   * Only consulted for items that are not already inside a state. Anything
   * under `STATE2/` is STATE2's whatever this says, because the project is a
   * better record of what an item is for than a flag typed at the shell.
   */
  state?: string;
  /** Every state to build an empty shelf for. */
  states?: readonly string[];
}

/** The state an item already sits in, if any. */
export function stateOf(folder: string, states: readonly string[] = STATES): string | undefined {
  const head = folder.split("/")[0];
  return head && states.includes(head) ? head : undefined;
}

/** The folders every state has, whether or not anything is in them yet. */
export function stateSkeleton(state: string): string[] {
  return [
    state,
    `${state}/${SHELF.delivery}`,
    `${state}/${SHELF.elements}`,
    `${state}/${SHELF.generic}`,
    `${state}/${SHELF.archive}`,
    `${state}/${STATE_INBOX}`,
  ];
}

/**
 * Element families that are set dressing rather than entities.
 *
 * `Bunting03` is named like an element and is nothing like one: there are six
 * of them, they hold one layer each, and nobody will ever open a folder to
 * find out about one. Six folders holding one item each is worse than a
 * drawer called bunting.
 */
const GENERIC_FAMILIES: Record<string, string> = {
  Bunting: "bunting",
  Clouds: "clouds",
};

const VIDEO = /\.(mp4|mov|mxf|webm|avi|m4v|prores)$/i;
const STILL = /\.(png|jpe?g|tiff?|exr|tga|psb)$/i;

/**
 * The element an item belongs to, from its name.
 *
 * Every entity in this project is `Family` plus a two-digit number, and After
 * Effects appends ` Comp 1` when a group of PSD layers is precomposed. So
 * `Car01`, `Car01 Comp 1` and a clip called `car01_drive_v3.mp4` are all the
 * same element, and the name is the only thing that says so.
 *
 * Deliberately anchored at the start of the name for comps, because a comp
 * called `Waiter01` is the element and a comp called `Rooftop01 Comp 1` is a
 * stage of `Rooftop01` — never a stage of something else that happens to be
 * mentioned later in the string.
 */
export function elementKey(name: string): string | undefined {
  const match = /^([A-Z][A-Za-z]*?\d{2})(?=$|[\s_-])/.exec(name.trim());
  return match ? match[1] : undefined;
}

/** The family part, so `CafeFriends01` is a `CafeFriends`. */
export function elementFamily(key: string): string {
  return key.replace(/\d{2}$/, "");
}

/**
 * The element a *file* belongs to, which is a looser question.
 *
 * A generated clip is named by whoever or whatever generated it, so the key
 * can sit anywhere in the string and the case cannot be trusted. Matching
 * against keys that are known to exist, rather than against a pattern, is
 * what keeps `tacodate01` out of a folder called `Tacodate01`.
 */
export function fileElementKey(name: string, known: readonly string[]): string | undefined {
  const haystack = name.toLowerCase();
  // Longest first, so `Cafe01` cannot win a name that says `CafeFriends01`.
  const byLength = [...known].sort((a, b) => b.length - a.length);
  return byLength.find((key) => haystack.includes(key.toLowerCase()));
}

/** `GYG_Sides-Left_v002` -> base `GYG_Sides-Left`, version 2. */
function versioned(name: string): { base: string; version: number } | undefined {
  const match = /^(.*)_v(\d+)$/i.exec(name);
  return match ? { base: match[1]!, version: Number(match[2]) } : undefined;
}

/**
 * Builds the shelf for an inventory.
 *
 * Returns moves rather than performing them, and returns the ones it could
 * not place separately rather than sweeping them into a folder called
 * `misc` — a plan that can be read before it is applied is the whole point of
 * computing it here instead of in ExtendScript.
 */
export function planProjectShelf(items: ProjectItem[], options: ShelfOptions = {}): ShelfPlan {
  const states = options.states ?? STATES;
  const fallback = options.state ?? states[0]!;
  if (!states.includes(fallback)) {
    throw new Error(`${fallback} is not one of ${states.join(", ")}`);
  }

  /**
   * Loose means "nothing has said which state this belongs to yet".
   *
   * The project root is loose, and so is a state's own inbox -- that is what
   * an inbox is for. Everywhere else, being in a folder is itself the answer,
   * and the rules leave the item where somebody put it.
   */
  const isLoose = (item: ProjectItem): boolean =>
    item.folder === "" || /^[^/]+\/_INBOX$/.test(item.folder);

  const folders = new Set<string>();
  const moves: ShelfMove[] = [];
  const unsorted: ProjectItem[] = [];
  let alreadySorted = 0;
  let leftInPlace = 0;

  /** Element keys that have a live comp of their own, named exactly. */
  const liveComps = new Set(
    items
      .filter((item) => item.kind === "comp" && elementKey(item.name) === item.name.trim())
      .map((item) => item.name.trim()),
  );

  /** Every element key the project mentions, for matching loose files against. */
  const knownKeys = new Set<string>();
  for (const item of items) {
    const key = elementKey(item.name);
    if (key && !(elementFamily(key) in GENERIC_FAMILIES)) knownKeys.add(key);
  }

  /**
   * The newest version of each delivery comp.
   *
   * `GYG_Sides-Left_v001` and `_v002` are the same surface twice, and only
   * one of them is the one being rendered. Which is which is not a judgement
   * about the artwork, it is the larger number.
   */
  const newest = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "comp") continue;
    const version = versioned(item.name);
    if (!version) continue;
    const seen = newest.get(version.base);
    if (seen === undefined || version.version > seen) newest.set(version.base, version.version);
  }

  const place = (item: ProjectItem, within: string, reason: string): void => {
    // Every path the rules below produce is relative to a state. They do not
    // know which one, and should not: it is a property of where the item is.
    const folder = `${stateOf(item.folder, states) ?? fallback}/${within}`;
    folders.add(folder);
    if (item.folder === folder) {
      alreadySorted++;
      return;
    }
    moves.push({ itemId: item.id, folder, expectName: item.name, reason });
  };

  for (const item of items) {
    /*
     * Folders are mostly the shelf rather than things on it -- but the ones
     * After Effects and the host made at the root are drawers, and a drawer
     * is moved by its handle. Emptying `GYG_Sides-Left_v002 Layers` into a
     * generic folder would turn sixty well-grouped layers into sixty loose
     * ones, which is the problem rather than the fix.
     */
    if (item.kind === "folder") {
      if (item.name === SHELF.inbox) continue; // the import inbox stays put
      if (Object.values(SHELF).includes(item.name as never)) continue; // our own
      if (states.includes(item.name) || item.name === STATE_INBOX) continue; // the shelf
      /*
       * A drawer is identified by its name, not by where it currently sits.
       * The first version of this only placed drawers at the project root,
       * which was fine until the shelf itself moved under a state -- then
       * every `<PSD> Layers` folder already inside the old `20_GENERIC` was
       * skipped as "not loose" and left behind in a husk.
       */
      const drawer = item.name === "Solids" || /^(.*) Layers$/.test(item.name);
      if (!drawer) {
        if (isLoose(item)) unsorted.push(item);
        else leftInPlace++;
        continue;
      }
      if (item.name === "Solids") {
        place(item, SHELF.generic, "After Effects' own solids drawer");
        continue;
      }
      const layers = /^(.*) Layers$/.exec(item.name);
      if (layers) {
        // A layer set belongs with the comp it came from, so when that comp
        // has been superseded the layers go to the same place it did.
        const base = layers[1]!;
        const version = versioned(base);
        const superseded =
          version !== undefined &&
          (newest.get(version.base) ?? version.version) > version.version;
        place(
          item,
          superseded ? SHELF.archive : `${SHELF.generic}/plates`,
          superseded
            ? `the layers of a superseded ${base}`
            : "a layered PSD's own layer set",
        );
        continue;
      }
      if (isLoose(item)) unsorted.push(item);
      else leftInPlace++;
      continue;
    }

    const key = elementKey(item.name);
    const family = key ? elementFamily(key) : undefined;

    // --- set dressing, by family ---------------------------------------
    if (family && family in GENERIC_FAMILIES) {
      place(item, `${SHELF.generic}/${GENERIC_FAMILIES[family]}`, `${family} is set dressing`);
      continue;
    }

    if (item.kind === "comp") {
      // --- a PSD imported as a composition ----------------------------
      if (/_psd$/i.test(item.name)) {
        place(item, `${SHELF.generic}/plates`, "a PSD imported as a composition");
        continue;
      }

      // --- an element, or a stage of one ------------------------------
      if (key) {
        const bare = item.name.trim() === key;
        if (bare) {
          place(item, `${SHELF.elements}/${key}`, "the element's live comp");
        } else if (/\bComp \d+$/.test(item.name)) {
          // After Effects' own name for "these PSD layers, grouped". That is
          // the stage an element starts at, whether or not it was later
          // rebuilt under a different name.
          place(
            item,
            `${SHELF.elements}/${key}/${STAGE.source}`,
            liveComps.has(key)
              ? "the grouping its live comp was precomposed from"
              : "a PSD grouping, superseded under another name",
          );
        } else {
          place(item, `${SHELF.elements}/${key}`, "belongs to the element by name");
        }
        continue;
      }

      // --- a delivery comp -------------------------------------------
      const version = versioned(item.name);
      if (version && (item.usedInCount ?? 0) === 0) {
        const top = newest.get(version.base);
        if (top !== undefined && version.version < top) {
          place(item, SHELF.archive, `superseded by v${String(top).padStart(3, "0")}`);
        } else {
          place(item, SHELF.delivery, "the newest version of a delivery comp");
        }
        continue;
      }

      unsorted.push(item);
      continue;
    }

    // --- footage ------------------------------------------------------
    if (item.kind === "solid") {
      // The drawer itself is moved above; a solid already in it travels with
      // it, and only a loose one needs placing.
      if (/(^|\/)Solids$/.test(item.folder)) {
        leftInPlace++;
        continue;
      }
      place(item, `${SHELF.generic}/Solids`, "a solid");
      continue;
    }

    // Before anything that reads the name: a placeholder called
    // "Car01 pending" is a promise that a render is coming back, not a still
    // of Car01, and filing it as one hides the fact that it is still owed.
    if (item.kind === "placeholder") {
      // A placeholder is a promise that a render is coming back. It belongs
      // with the inbox, not filed as though it were finished media.
      unsorted.push(item);
      continue;
    }

    const source = item.file ?? item.name;

    if (/\.psd$/i.test(source)) {
      if (!isLoose(item)) {
        leftInPlace++;
        continue;
      }
      place(item, `${SHELF.generic}/plates`, "a PSD plate");
      continue;
    }

    const owner = fileElementKey(item.name, [...knownKeys]);
    if (owner) {
      const clip = VIDEO.test(source) || (!STILL.test(source) && (item.durationSeconds ?? 0) > 0.5);
      place(
        item,
        `${SHELF.elements}/${owner}/${clip ? STAGE.clips : STAGE.stills}`,
        clip ? `a generated clip for ${owner}` : `a still for ${owner}`,
      );
      continue;
    }

    if (!isLoose(item)) {
      // Inside `SEED` or a `<PSD> Layers` folder and claimed by no element.
      // Its name is a job hash or a layer name, so there is nothing to file
      // it by -- and where it is is already better than `20_GENERIC/footage`.
      leftInPlace++;
      continue;
    }

    place(item, `${SHELF.generic}/footage`, "footage belonging to no one element");
  }

  /*
   * Every ancestor of every folder.
   *
   * An element whose only item is the PSD grouping it came from asks for
   * `10_ELEMENTS/Rooftop01/01_source` and never for the folder above it --
   * `createFolders` would make the parent anyway, but a plan that does not
   * mention it cannot be checked, and the folder list is what gets read
   * before any of this is applied.
   */
  for (const folder of [...folders]) {
    const parts = folder.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }

  return {
    folders: parentFirst([...states.flatMap(stateSkeleton), ...folders]),
    moves,
    alreadySorted,
    leftInPlace,
    unsorted,
  };
}

/**
 * Deduped, shallowest first.
 *
 * `createFolders` makes missing parents on its own, so this is not strictly
 * required — but a plan printed for a human to approve reads as a tree only
 * if it arrives in tree order.
 */
export function parentFirst(paths: Iterable<string>): string[] {
  // Plain string order, not `localeCompare`, and not by depth. A parent is
  // always a proper prefix of its children, so lexicographic order puts it
  // first *and* keeps each subtree together -- which a depth-first sort does
  // not, and the difference is the whole readability of a printed plan.
  return [...new Set(paths)].sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}
