import { describe, expect, it } from "vitest";
import { HOST_COMMANDS } from "../../service/src/host/commands.js";
import type { CepAeBridge } from "../src/api/cep.ts";
import { dispatch } from "../src/api/hostAgent.ts";

/**
 * The two allowlists have to agree, and nothing else makes them.
 *
 * A command is checked against the service's list before it is queued and
 * against the panel's `switch` when it runs. Those are two files in two
 * packages, deliberately — the service refuses early so a caller learns
 * immediately, and the panel refuses again so a service that was talked into
 * queueing something cannot get it executed.
 *
 * The failure mode of two lists is drift, and it is quiet: a name added to the
 * service alone is accepted, queued, dispatched to nothing, and comes back
 * "the panel has no handler for compTree" — which reads like a panel that is
 * out of date rather than a list that was only half edited.
 */

/** A bridge where every method exists and records how it was called. */
function recordingBridge(): { bridge: CepAeBridge; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const bridge = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        return (...args: unknown[]) => {
          calls.push([name, args]);
          return Promise.resolve({ called: name });
        };
      },
    },
  ) as unknown as CepAeBridge;
  return { bridge, calls };
}

describe("the panel's half of the allowlist", () => {
  it("has a handler for every command the service will accept", () => {
    const { bridge } = recordingBridge();

    const missing = HOST_COMMANDS.filter((name) => {
      try {
        // A handler that rejects empty arguments has still been reached, and
        // reaching it is what this is checking. The loop turns the throw into
        // a reported failure; only `undefined` means nothing matched at all.
        return dispatch(bridge, { id: "c", name, args: {} }) === undefined;
      } catch {
        return false;
      }
    });

    expect(missing).toEqual([]);
  });

  it("tells a caller that sent layer names to send indexes", () => {
    const { bridge } = recordingBridge();

    /*
     * `Number("Houses01")` is NaN, and After Effects asked to pre-compose
     * layer NaN complains about a layer that does not exist — a message that
     * sends whoever reads it looking in the wrong place. The mistake is
     * worth naming where it was made.
     */
    expect(() =>
      dispatch(bridge, { id: "c", name: "precompose", args: { layerIndexes: ["Houses01"] } }),
    ).toThrow(/not a layer index/);
    expect(() => dispatch(bridge, { id: "c", name: "precompose", args: {} })).toThrow(
      /needs layerIndexes/,
    );
  });

  it("refuses a name that is not one of them", () => {
    const { bridge } = recordingBridge();

    // Not an error here — the loop turns `undefined` into a reported failure.
    // What matters is that no bridge method is reached by a name nobody chose,
    // which a reflective lookup would have allowed.
    expect(dispatch(bridge, { id: "c", name: "app.project.close()", args: {} })).toBeUndefined();
    expect(dispatch(bridge, { id: "c", name: "captureRange", args: {} })).toBeUndefined();
  });

  it("reads a sub-comp tree at the depth it was asked for", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, { id: "c", name: "compTree", args: { compId: "157", maxDepth: 3 } });
    expect(calls[0]).toEqual(["compTree", ["157", 3]]);
  });

  it("defaults the tree to one level of parts rather than the whole project", async () => {
    const { bridge, calls } = recordingBridge();

    /*
     * Two levels is the master plus its parts. Deeper is occasionally what you
     * want and always much larger, and a default that returns everything makes
     * the cheap question — what is this built from — cost the same as the
     * expensive one.
     */
    await dispatch(bridge, { id: "c", name: "compTree", args: {} });
    expect(calls[0]).toEqual(["compTree", [undefined, 2]]);
  });

  it("passes a comp-name filter through, and omits it when absent", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, { id: "c", name: "projectComps", args: { match: "GYG" } });
    await dispatch(bridge, { id: "c", name: "projectComps", args: {} });

    expect(calls[0]).toEqual(["projectComps", ["GYG"]]);
    expect(calls[1]).toEqual(["projectComps", [undefined]]);
  });
});

/**
 * The shelf commands, where the arguments are lists rather than numbers.
 *
 * Every other command takes a handful of scalars and the coercion is
 * uninteresting. These two take a plan computed somewhere else, which makes
 * the panel the last place that can object to it -- so the checking happens
 * here rather than in ExtendScript, where a bad path becomes a folder called
 * `..` that nobody can explain a month later.
 */
describe("putting the project on a shelf", () => {
  it("passes folder paths through, trimmed", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "createFolders",
      args: { paths: ["00_DELIVERY", " 10_ELEMENTS / Car01 "] },
    });
    expect(calls[0]).toEqual(["createFolders", [["00_DELIVERY", "10_ELEMENTS/Car01"]]]);
  });

  it("refuses a path that would walk out of the shelf", () => {
    const { bridge } = recordingBridge();

    for (const path of ["..", "10_ELEMENTS/../..", "10_ELEMENTS//Car01", "", "   "]) {
      expect(() =>
        dispatch(bridge, { id: "c", name: "createFolders", args: { paths: [path] } }),
      ).toThrow();
    }
  });

  it("refuses paths that are not a list at all", () => {
    const { bridge } = recordingBridge();

    expect(() =>
      dispatch(bridge, { id: "c", name: "createFolders", args: { paths: "00_DELIVERY" } }),
    ).toThrow(/array/);
  });

  it("carries the name guard through when the plan supplied one", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "moveItems",
      args: {
        moves: [
          { itemId: "820", folder: "10_ELEMENTS/Car01", expectName: "Car01" },
          { itemId: "993", folder: "20_GENERIC/bunting" },
        ],
      },
    });
    expect(calls[0]).toEqual([
      "moveItems",
      [
        [
          { itemId: "820", folder: "10_ELEMENTS/Car01", expectName: "Car01" },
          { itemId: "993", folder: "20_GENERIC/bunting" },
        ],
      ],
    ]);
  });

  it("treats an empty folder as the project root, which is a real destination", async () => {
    const { bridge, calls } = recordingBridge();

    // How something gets taken back *out* of a folder. Rejecting it would
    // make the shelf one-way.
    await dispatch(bridge, {
      id: "c",
      name: "moveItems",
      args: { moves: [{ itemId: "820", folder: "" }] },
    });
    expect(calls[0]).toEqual(["moveItems", [[{ itemId: "820", folder: "" }]]]);
  });

  it("refuses a move with no item", () => {
    const { bridge } = recordingBridge();

    expect(() =>
      dispatch(bridge, { id: "c", name: "moveItems", args: { moves: [{ folder: "00_DELIVERY" }] } }),
    ).toThrow(/itemId/);
  });
});

/**
 * The travel half of an element.
 *
 * Every generated element here is a cycle on the spot, so the clip never
 * moves and a Position keyframe does. That makes this the command that
 * finishes an element, and the one that can quietly ruin one: the wall's
 * truck and aeroplane are hand-keyframed, and overwriting those would be
 * indistinguishable from a bug until somebody scrubbed the timeline.
 */
describe("moving a layer", () => {
  it("passes a static value through", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "setTransform",
      args: { layerIndex: 22, property: "Scale", value: [110, 110] },
    });
    expect(calls[0]).toEqual([
      "setTransform",
      [22, "Scale", { value: [110, 110], interpolation: "linear", replace: false }],
    ]);
  });

  it("accepts the property however it is capitalised, and refuses the rest", () => {
    const { bridge, calls } = recordingBridge();

    dispatch(bridge, { id: "c", name: "setTransform", args: { layerIndex: 1, property: "position", value: [0, 0] } });
    expect((calls[0]![1] as unknown[])[1]).toBe("Position");

    for (const property of ["Positon", "", "Time Remap", "Effects"]) {
      expect(() =>
        dispatch(bridge, { id: "c", name: "setTransform", args: { layerIndex: 1, property, value: 0 } }),
      ).toThrow(/property must be one of/);
    }
  });

  it("sorts keyframes into time order", async () => {
    const { bridge, calls } = recordingBridge();

    /*
     * `setValueAtTime` does not care what order it is called in, but
     * `setInterpolationTypeAtKey` indexes by time — so an out-of-order list
     * eases the wrong keyframes and nothing says so.
     */
    await dispatch(bridge, {
      id: "c",
      name: "setTransform",
      args: {
        layerIndex: 22,
        property: "Position",
        keyframes: [
          { atSeconds: 25, value: [7000, 1639] },
          { atSeconds: 1, value: [-50, 1639] },
          { atSeconds: 0, value: [-50, 1639] },
        ],
      },
    });
    const spec = (calls[0]![1] as unknown[])[2] as {
      keyframes: Array<{ atSeconds: number }>;
    };
    expect(spec.keyframes.map((k) => k.atSeconds)).toEqual([0, 1, 25]);
  });

  it("refuses a value After Effects would accept and never recover from", () => {
    const { bridge } = recordingBridge();

    // NaN assigns without complaint and the layer disappears to nowhere.
    for (const value of ["banana", [0, "x"], Number.POSITIVE_INFINITY, [NaN, 0]]) {
      expect(() =>
        dispatch(bridge, {
          id: "c",
          name: "setTransform",
          args: { layerIndex: 1, property: "Position", value },
        }),
      ).toThrow(/is not a number/);
    }
  });

  it("refuses an empty or absurd value, and a negative keyframe time", () => {
    const { bridge } = recordingBridge();

    expect(() =>
      dispatch(bridge, { id: "c", name: "setTransform", args: { layerIndex: 1, property: "Scale", value: [] } }),
    ).toThrow(/1 to 3 numbers/);
    expect(() =>
      dispatch(bridge, { id: "c", name: "setTransform", args: { layerIndex: 1, property: "Position", keyframes: [] } }),
    ).toThrow(/non-empty/);
    expect(() =>
      dispatch(bridge, {
        id: "c",
        name: "setTransform",
        args: { layerIndex: 1, property: "Position", keyframes: [{ atSeconds: -1, value: [0, 0] }] },
      }),
    ).toThrow(/zero or more/);
  });

  it("defaults to linear and to leaving an existing animation alone", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "setTransform",
      args: { layerIndex: 1, property: "Opacity", value: 100, interpolation: "nonsense" },
    });
    const spec = (calls[0]![1] as unknown[])[2] as { interpolation: string; replace: boolean };
    expect(spec.interpolation).toBe("linear");
    expect(spec.replace).toBe(false);
  });

  it("carries hold through, which is how a cut is made rather than a fade", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "setTransform",
      args: {
        layerIndex: 1,
        property: "Opacity",
        keyframes: [{ atSeconds: 0, value: 0 }, { atSeconds: 2, value: 100 }],
        interpolation: "hold",
        replace: true,
      },
    });
    const spec = (calls[0]![1] as unknown[])[2] as { interpolation: string; replace: boolean };
    expect(spec.interpolation).toBe("hold");
    expect(spec.replace).toBe(true);
  });
});

/**
 * Cleaning up after a restructure.
 *
 * Moving the shelf under a state left thirty empty folders behind, and a wall
 * built from a PSD arrives with layers called `Layer 12` through `Layer 17`.
 * Neither is a bug, both make a project unreadable, and the two commands that
 * fix them are the ones that can do the most damage if their arguments are
 * wrong — one deletes, the other rewrites what everything is called.
 */
describe("cleaning up after a restructure", () => {
  it("checks folder paths to delete exactly as it checks ones to create", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "deleteFolders",
      args: { paths: ["20_GENERIC/plates", " 10_ELEMENTS "] },
    });
    expect(calls[0]).toEqual(["deleteFolders", [["20_GENERIC/plates", "10_ELEMENTS"]]]);

    for (const path of ["..", "10_ELEMENTS/../..", "", "a//b"]) {
      expect(() =>
        dispatch(bridge, { id: "c", name: "deleteFolders", args: { paths: [path] } }),
      ).toThrow();
    }
  });

  it("carries the name guard through on a rename", async () => {
    const { bridge, calls } = recordingBridge();

    await dispatch(bridge, {
      id: "c",
      name: "renameLayers",
      args: {
        renames: [
          { layerIndex: 9, name: "cloud bank upper", expectName: "Layer 17" },
          { layerIndex: 38, name: "cloud bank lower" },
        ],
      },
    });
    expect(calls[0]).toEqual([
      "renameLayers",
      [
        [
          { layerIndex: 9, name: "cloud bank upper", expectName: "Layer 17" },
          { layerIndex: 38, name: "cloud bank lower" },
        ],
      ],
    ]);
  });

  it("refuses an empty name, a line break, and a nonsense index", () => {
    const { bridge } = recordingBridge();

    /*
     * A newline is accepted by After Effects and then the timeline shows only
     * the first line, which reads as the rename having silently failed rather
     * than as a bad name.
     */
    const bad = [
      [{ layerIndex: 1, name: "   " }],
      [{ layerIndex: 1, name: "two\nlines" }],
      [{ layerIndex: 1, name: "tab\there" }],
      [{ layerIndex: 0, name: "fine" }],
      [{ layerIndex: 1.5, name: "fine" }],
    ];
    for (const renames of bad) {
      expect(() =>
        dispatch(bridge, { id: "c", name: "renameLayers", args: { renames } }),
      ).toThrow();
    }
    expect(() =>
      dispatch(bridge, { id: "c", name: "renameLayers", args: { renames: [] } }),
    ).toThrow(/non-empty/);
  });
});
