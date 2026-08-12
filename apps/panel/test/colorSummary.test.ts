import { describe, expect, it } from "vitest";
import type { AeContext } from "@seed-ae/domain";
import { colorWarning, describeColor } from "../src/colorSummary.ts";

describe("describeColor", () => {
  it("says nothing was recorded rather than inventing sRGB", () => {
    /*
     * The distinction this whole fix exists for. A frame captured before the
     * host reported colour management is not an sRGB frame — it is a frame
     * whose colour handling is unknown, and a look must be able to tell those
     * apart before it decides whether to linearise.
     */
    expect(describeColor({})).toBe("not recorded");
  });

  it("describes a colour-managed 32-bit project", () => {
    const context: AeContext = {
      colorSpace: "sRGB IEC61966-2.1",
      colorManagement: {
        bitsPerChannel: 32,
        workingSpace: "sRGB IEC61966-2.1",
        workingGamma: 2.2,
        linearizeWorkingSpace: true,
      },
    };
    expect(describeColor(context)).toBe(
      "sRGB IEC61966-2.1 · 32-bit · linearised · γ2.2",
    );
  });

  it("reports an untagged project as None rather than blank", () => {
    const context: AeContext = {
      colorManagement: { bitsPerChannel: 8, workingSpace: "" },
    };
    expect(describeColor(context)).toBe("None · 8-bit");
  });

  it("distinguishes linear blending from a linearised working space", () => {
    const blending: AeContext = {
      colorManagement: { bitsPerChannel: 16, linearBlending: true },
    };
    expect(describeColor(blending)).toBe("16-bit · linear blending");

    const linearised: AeContext = {
      colorManagement: {
        bitsPerChannel: 16,
        linearBlending: true,
        linearizeWorkingSpace: true,
      },
    };
    // Linearised is the stronger claim and the one that changes the pixels.
    expect(describeColor(linearised)).toBe("16-bit · linearised");
  });
});

describe("colorWarning", () => {
  it("stays quiet at 32-bit float", () => {
    expect(
      colorWarning({ colorManagement: { bitsPerChannel: 32 } }),
    ).toBeUndefined();
  });

  it("stays quiet when the depth is unknown", () => {
    // Nagging about a project we could not read is worse than saying nothing.
    expect(colorWarning({})).toBeUndefined();
  });

  it("warns at 8 and 16 bit, naming the consequence", () => {
    for (const depth of [8, 16] as const) {
      const warning = colorWarning({ colorManagement: { bitsPerChannel: depth } });
      expect(warning).toContain(`${depth}-bit`);
      expect(warning).toContain("band");
    }
  });
});
