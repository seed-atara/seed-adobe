import type { ItemPlate } from "@seed-ae/domain";

/**
 * Which plates fit, when there are more plates than the provider will take.
 *
 * The rule that matters is **round-robin across Items, never depth-first**.
 * Three characters and a budget of three gets one plate each. Depth-first would
 * give all three to the first Item and leave two characters described in the
 * prompt with no reference at all — the worst failure available, because the
 * prompt still confidently names them.
 */

export interface PlateCandidate {
  /** Index into the caller's Item list, so the result maps straight back. */
  itemIndex: number;
  plate: ItemPlate;
}

export interface AllocationInput {
  itemIndex: number;
  /** Sorted lowest-weight-first by the caller. */
  plates: ItemPlate[];
  /** 0–100. Scales how many of this Item's plates it may take. */
  influence: number;
  /**
   * Style plates leak subject content — Ark has one reference channel, so a
   * style plate competes with a face. They sort last so that when the budget
   * runs out it is the look that loses a plate, not the character.
   */
  deferred: boolean;
}

export interface Allocation {
  taken: PlateCandidate[];
  droppedByItem: Map<number, ItemPlate[]>;
}

/**
 * How many of an Item's plates its influence entitles it to.
 *
 * Influence exists because identity strength and text control pull against each
 * other: a character at maximum cannot be given a new coat by the prompt. Where
 * a provider has no dial of its own — Ark has none — plate count *is* the dial.
 */
export function plateCapFor(influence: number, declared: number): number {
  if (declared === 0) return 0;
  if (influence <= 0) return 0;
  return Math.max(1, Math.round((influence / 100) * declared));
}

export function allocatePlates(
  inputs: AllocationInput[],
  available: number,
): Allocation {
  const droppedByItem = new Map<number, ItemPlate[]>();
  const taken: PlateCandidate[] = [];
  if (available <= 0) {
    for (const input of inputs) droppedByItem.set(input.itemIndex, [...input.plates]);
    return { taken, droppedByItem };
  }

  const queues = inputs.map((input) => ({
    input,
    remaining: [...input.plates],
    cap: plateCapFor(input.influence, input.plates.length),
  }));

  // Two passes so a style Item never takes a slot a character still wants.
  const order = [
    queues.filter((queue) => !queue.input.deferred),
    queues.filter((queue) => queue.input.deferred),
  ];

  let budget = available;
  for (const group of order) {
    let progressed = true;
    while (budget > 0 && progressed) {
      progressed = false;
      for (const queue of group) {
        if (budget <= 0) break;
        if (queue.cap <= 0 || queue.remaining.length === 0) continue;
        const plate = queue.remaining.shift() as ItemPlate;
        taken.push({ itemIndex: queue.input.itemIndex, plate });
        queue.cap -= 1;
        budget -= 1;
        progressed = true;
      }
    }
  }

  for (const queue of queues) {
    if (queue.remaining.length > 0) {
      droppedByItem.set(queue.input.itemIndex, queue.remaining);
    }
  }
  return { taken, droppedByItem };
}
