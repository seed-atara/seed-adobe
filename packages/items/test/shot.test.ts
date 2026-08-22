import { describe, expect, it } from "vitest";
import type { ItemPlate, PlateShot } from "@seed-ae/domain";
import {
  hasShotIntent,
  orderPlatesForShot,
  readShotIntent,
  scorePlate,
} from "../src/shot.js";

function plate(id: string, shot?: PlateShot, weight = 0): ItemPlate {
  return {
    assetId: id,
    role: "reference",
    weight,
    providerRefs: {},
    ...(shot ? { shot } : {}),
  };
}

describe("readShotIntent", () => {
  it("reads framing from the words people use", () => {
    expect(readShotIntent("a close-up of her face").framing).toBe("close");
    expect(readShotIntent("extreme closeup, eyes only").framing).toBe("close");
    expect(readShotIntent("wide establishing shot of the valley").framing).toBe("wide");
    expect(readShotIntent("medium shot, waist up").framing).toBe("mid");
  });

  it("reads the angle", () => {
    expect(readShotIntent("she turns in profile").angle).toBe("profile");
    expect(readShotIntent("shot from behind as he walks").angle).toBe("back");
    expect(readShotIntent("three-quarter view, soft light").angle).toBe("three-quarter");
    expect(readShotIntent("staring straight to camera").angle).toBe("front");
  });

  it("reads how lit it is", () => {
    expect(readShotIntent("a night interior on the train").light).toBe("dark");
    expect(readShotIntent("bright sunlit kitchen").light).toBe("bright");
  });

  it("finds nothing in a prompt that describes none of it", () => {
    const intent = readShotIntent("she thinks about the letter");
    expect(hasShotIntent(intent)).toBe(false);
  });
});

describe("scorePlate", () => {
  const intent = readShotIntent("a close-up in profile, at night");

  it("scores an untagged plate as neutral rather than bad", () => {
    /*
     * Most libraries are untagged. Punishing a plate for having no label would
     * make this actively harmful the day it shipped — an unlabelled library
     * would reorder itself for no reason.
     */
    expect(scorePlate(plate("a"), intent)).toBe(0);
  });

  it("prefers the plate that matches", () => {
    const matching = plate("m", { framing: "close", angle: "profile", light: "dark" });
    const wrong = plate("w", { framing: "wide", angle: "front", light: "bright" });
    expect(scorePlate(matching, intent)).toBeGreaterThan(scorePlate(wrong, intent));
  });

  it("treats a near miss as better than an opposite", () => {
    const near = plate("n", { angle: "three-quarter" });
    const opposite = plate("o", { angle: "back" });
    expect(scorePlate(near, intent)).toBeGreaterThan(scorePlate(opposite, intent));
  });

  it("weighs the angle above the framing", () => {
    // A face turned the wrong way is the failure people actually see; a mid
    // where a close-up was asked for merely crops differently.
    const rightAngle = plate("a", { framing: "wide", angle: "profile" });
    const rightFraming = plate("f", { framing: "close", angle: "back" });
    expect(scorePlate(rightAngle, intent)).toBeGreaterThan(scorePlate(rightFraming, intent));
  });
});

describe("orderPlatesForShot", () => {
  it("puts the fitting plates first", () => {
    const plates = [
      plate("mid-front", { framing: "mid", angle: "front" }),
      plate("wide", { framing: "wide", angle: "front" }),
      plate("close-profile", { framing: "close", angle: "profile" }),
    ];
    const order = orderPlatesForShot(plates, readShotIntent("close-up in profile"));
    expect(order[0]?.assetId).toBe("close-profile");
  });

  it("falls back to weight when the prompt says nothing", () => {
    const plates = [plate("b", undefined, 5), plate("a", undefined, 1)];
    const order = orderPlatesForShot(plates, readShotIntent("she waits"));
    expect(order.map((entry) => entry.assetId)).toEqual(["a", "b"]);
  });

  it("keeps the artist's order among equally good plates", () => {
    // Two plates that fit identically must not swap around run to run.
    const shot: PlateShot = { framing: "close", angle: "profile" };
    const plates = [plate("first", shot), plate("second", shot)];
    const order = orderPlatesForShot(plates, readShotIntent("close-up in profile"));
    expect(order.map((entry) => entry.assetId)).toEqual(["first", "second"]);
  });

  it("still respects weight when scores tie", () => {
    const shot: PlateShot = { framing: "close" };
    const plates = [plate("heavy", shot, 9), plate("light", shot, 0)];
    const order = orderPlatesForShot(plates, readShotIntent("a close-up"));
    expect(order[0]?.assetId).toBe("light");
  });
});
