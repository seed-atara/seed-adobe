import type { ItemPlate, PlateShot } from "@seed-ae/domain";

/**
 * Choosing which plates fit *this* shot.
 *
 * The budget decides how many plates an Item may send. Until now nothing
 * decided *which*: plates went in weight order, so an Item holding eight
 * three-quarter mids and one profile close-up sent the mids to a profile
 * close-up and the likeness suffered for a reason nobody could see.
 *
 * Ark has one reference channel and a stable range of one to eight images. In
 * that budget, sending the two plates that match the framing beats sending
 * eight that do not — so this is the cheapest quality win available, and it
 * needs no new infrastructure beyond knowing what each plate shows.
 *
 * Weight still breaks ties. An artist who has ordered their plates deliberately
 * keeps that order among equally-good matches.
 */

/** What the shot being generated appears to ask for. */
export interface ShotIntent {
  framing?: PlateShot["framing"];
  angle?: PlateShot["angle"];
  light?: PlateShot["light"];
}

/** Whether anything was actually derived — an empty intent scores nothing. */
export function hasShotIntent(intent: ShotIntent): boolean {
  return (
    intent.framing !== undefined ||
    intent.angle !== undefined ||
    intent.light !== undefined
  );
}

const FRAMING: Array<[RegExp, NonNullable<PlateShot["framing"]>]> = [
  [/\b(?:extreme\s+)?close[\s-]?ups?\b|\bcu\b|\bmacro\b/, "close"],
  [/\b(?:wide|establishing|long)\s+(?:shot|angle)\b|\bwide\b|\bws\b|\bvista\b/, "wide"],
  [/\bmedium\s+(?:shot|close)\b|\bmid\s+shot\b|\bwaist[\s-]?up\b|\bms\b/, "mid"],
];

const ANGLE: Array<[RegExp, NonNullable<PlateShot["angle"]>]> = [
  [/\bfrom\s+behind\b|\bback\s+of\s+(?:her|his|their)\s+head\b|\brear\s+view\b/, "back"],
  [/\bprofile\b|\bside[\s-]?on\b|\bfrom\s+the\s+side\b/, "profile"],
  [/\bthree[\s-]?quarter\b|\b3\/4\b/, "three-quarter"],
  [/\bstraight\s+to\s+camera\b|\bhead[\s-]?on\b|\bfacing\s+(?:the\s+)?camera\b|\bfront[\s-]?on\b/, "front"],
];

const LIGHT: Array<[RegExp, NonNullable<PlateShot["light"]>]> = [
  [/\bnight\b|\bdark(?:ness)?\b|\bdim(?:ly)?\b|\bmoonlit\b|\blow[\s-]?key\b|\bsilhouette\b/, "dark"],
  [/\bdaylight\b|\bbright\b|\bsunlit\b|\bhigh[\s-]?key\b|\boverexposed\b|\bnoon\b/, "bright"],
];

/**
 * What the prompt says about the shot.
 *
 * Read from the artist's own words rather than inferred from the plate,
 * because the prompt is the only thing that describes the shot that does not
 * exist yet. Nothing here rewrites the prompt or requires the artist to use a
 * vocabulary — an unrecognised prompt simply yields no intent, and plate order
 * falls back to weight exactly as before.
 */
export function readShotIntent(prompt: string): ShotIntent {
  const text = prompt.toLowerCase();
  const intent: ShotIntent = {};

  for (const [pattern, value] of FRAMING) {
    if (pattern.test(text)) {
      intent.framing = value;
      break;
    }
  }
  for (const [pattern, value] of ANGLE) {
    if (pattern.test(text)) {
      intent.angle = value;
      break;
    }
  }
  for (const [pattern, value] of LIGHT) {
    if (pattern.test(text)) {
      intent.light = value;
      break;
    }
  }
  return intent;
}

/** How near two framings are. Adjacent framings are usable; opposites are not. */
function framingDistance(
  a: NonNullable<PlateShot["framing"]>,
  b: NonNullable<PlateShot["framing"]>,
): number {
  const order = { close: 0, mid: 1, wide: 2 } as const;
  return Math.abs(order[a] - order[b]);
}

/** Likewise for angle, around the subject rather than along a line. */
function angleDistance(
  a: NonNullable<PlateShot["angle"]>,
  b: NonNullable<PlateShot["angle"]>,
): number {
  const order = { front: 0, "three-quarter": 1, profile: 2, back: 3 } as const;
  return Math.abs(order[a] - order[b]);
}

/**
 * How well a plate suits the shot. Higher is better; 0 is "nothing known".
 *
 * A plate that says nothing about itself scores 0 rather than badly. Most
 * libraries are untagged, and punishing a plate for lacking a label would make
 * this feature actively harmful the day it shipped.
 */
export function scorePlate(plate: ItemPlate, intent: ShotIntent): number {
  const shot = plate.shot;
  if (!shot) return 0;

  let score = 0;

  if (intent.angle && shot.angle) {
    /*
     * Angle dominates. A face turned the wrong way is the failure people
     * actually see; a mid where a close-up was asked for merely crops
     * differently, and the model can crop.
     */
    score += 8 - angleDistance(intent.angle, shot.angle) * 4;

    /*
     * And a back is worse than its rotation suggests. In pure rotation
     * `profile` sits exactly between `three-quarter` and `back`, so they score
     * the same — but one shows a face and the other shows the back of a head,
     * and only one of them carries identity. The penalty is dropped when the
     * shot genuinely asks for a back view.
     */
    if (shot.angle === "back" && intent.angle !== "back") score -= 3;
  }
  if (intent.framing && shot.framing) {
    score += 4 - framingDistance(intent.framing, shot.framing) * 2;
  }
  if (intent.light && shot.light) {
    score += shot.light === intent.light ? 2 : shot.light === "neutral" ? 1 : 0;
  }

  return score;
}

/**
 * The Item's plates, best-fitting first, weight breaking ties.
 *
 * Stable: plates that score the same keep the order the artist gave them.
 */
export function orderPlatesForShot(
  plates: ItemPlate[],
  intent: ShotIntent,
): ItemPlate[] {
  if (!hasShotIntent(intent)) return [...plates].sort((a, b) => a.weight - b.weight);

  return plates
    .map((plate, index) => ({ plate, index, score: scorePlate(plate, intent) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.plate.weight !== b.plate.weight) return a.plate.weight - b.plate.weight;
      return a.index - b.index;
    })
    .map((entry) => entry.plate);
}
