import type { ItemPlate, ItemTrait } from "@seed-ae/domain";

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

  /*
   * One round-robin, with style Items last *within* each round rather than in
   * a second pass of their own.
   *
   * Deferring them wholesale starves them: seven items and seven slots gave a
   * character its second plate before the look got its first, which is
   * depth-first behaviour wearing a different hat. Every item gets one plate
   * before any item gets two; only from the second round does being a style
   * Item cost it its place. That keeps the original intent — when the budget
   * runs out it is the look that loses a plate, not the character — without
   * ever leaving an item that was named in the prompt with nothing at all.
   */
  const order = [
    ...queues.filter((queue) => !queue.input.deferred),
    ...queues.filter((queue) => queue.input.deferred),
  ];

  let budget = available;
  let progressed = true;
  while (budget > 0 && progressed) {
    progressed = false;
    for (const queue of order) {
      if (budget <= 0) break;
      if (queue.cap <= 0 || queue.remaining.length === 0) continue;
      const plate = queue.remaining.shift() as ItemPlate;
      taken.push({ itemIndex: queue.input.itemIndex, plate });
      queue.cap -= 1;
      budget -= 1;
      progressed = true;
    }
  }

  for (const queue of queues) {
    if (queue.remaining.length > 0) {
      droppedByItem.set(queue.input.itemIndex, queue.remaining);
    }
  }
  return { taken, droppedByItem };
}

/* ------------------------------------------------------------------ *
 * Words are scarce too
 * ------------------------------------------------------------------ */

/**
 * How many words the whole item block may spend.
 *
 * A location, four props, a character and a look is seven items. On a stable
 * budget of eight references, with the artist's own frame taking one, that is
 * a single plate each — so the text has to carry far more than usual, and
 * seven items each writing four fragments is its own kind of bloat. The point
 * of a shared budget is that the *number of items* stops multiplying the
 * prompt.
 *
 * The number is a judgement, not a measurement: long enough to say something
 * useful about seven things, short enough that the artist's direction still
 * leads. It is overridable per request so it can be measured rather than
 * argued about.
 */
export const DEFAULT_TRAIT_WORD_BUDGET = 70;

export interface TraitAllocationInput {
  itemIndex: number;
  /** Ordered best-first by the caller: drift-prone, then by priority. */
  candidates: ItemTrait[];
  /** The most this item may take, from its text tier. */
  cap: number;
}

/**
 * Which traits actually get written, across every item at once.
 *
 * Round-robin, for the same reason plates are: depth-first would let a
 * talkative character spend the whole budget and leave four props with nothing
 * said about them at all. Every item gets its first trait before any item gets
 * its second, so what survives a tight budget is the single most important
 * thing about each of them.
 */
export function allocateTraits(
  inputs: TraitAllocationInput[],
  wordBudget: number,
): Map<number, ItemTrait[]> {
  const chosen = new Map<number, ItemTrait[]>();
  const queues = inputs.map((input) => ({
    input,
    remaining: [...input.candidates],
    taken: 0,
  }));

  let spent = 0;
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const queue of queues) {
      if (queue.taken >= queue.input.cap || queue.remaining.length === 0) continue;
      const trait = queue.remaining[0] as ItemTrait;
      const cost = wordsIn(trait.text);
      /*
       * A first trait is always affordable. An item that was mentioned and then
       * said nothing at all is worse than a prompt a few words over — the
       * prompt still names it, so the model will invent whatever was not said.
       */
      const mustHaveOne = queue.taken === 0;
      if (!mustHaveOne && spent + cost > wordBudget) continue;
      queue.remaining.shift();
      queue.taken += 1;
      spent += cost;
      chosen.set(queue.input.itemIndex, [
        ...(chosen.get(queue.input.itemIndex) ?? []),
        trait,
      ]);
      progressed = true;
    }
  }
  return chosen;
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}
