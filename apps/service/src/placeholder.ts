import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { encodePng } from "@seed-ae/media";
import type { WorkspaceLayout } from "@seed-ae/storage";

/**
 * The card that holds a cut open while a video renders.
 *
 * A generation takes minutes, and the edit has a hole in it until it lands.
 * The duration is known when Generate is pressed, so the space can be reserved
 * immediately — but reserving it needs a piece of media to reserve it with, and
 * SEED cannot encode video without taking on a dependency. A still can be held
 * for any duration on a timeline, so a still is what this is.
 *
 * Deliberately ugly: dark, flat, with a hazard border. Nobody should mistake it
 * for a frame, and anyone scrubbing past it should see instantly that the shot
 * has not arrived yet.
 */

function paint(WIDTH: number, HEIGHT: number): Buffer {
  const rgba = new Uint8Array(WIDTH * HEIGHT * 4);

  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = (y * WIDTH + x) * 4;

      // Diagonal hazard stripes, dark on dark: visible, never mistaken for footage.
      const stripe = Math.floor((x + y) / 48) % 2 === 0;
      let value = stripe ? 26 : 38;

      // A border, so the card reads as deliberate at any zoom.
      const edge = 12;
      if (x < edge || y < edge || x >= WIDTH - edge || y >= HEIGHT - edge) {
        value = 120;
      }

      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value === 120 ? 96 : value;
      rgba[at + 3] = 255;
    }
  }

  return encodePng(WIDTH, HEIGHT, rgba);
}

/**
 * Writes the card for a given shape and returns its path.
 *
 * Sized to the render it is standing in for, because a placeholder of the wrong
 * shape is not holding the same space: a 16:9 card in the gap left by a square
 * render is pillarboxed in one host and stretched in the other, and the artist
 * frames against something that will not be there.
 *
 * One file per shape, cached by name. They are small, and a project reopened
 * tomorrow with a placeholder still in it should not find its media missing —
 * which is also why these live in the workspace rather than a temp directory.
 */
export async function ensurePlaceholder(
  workspace: WorkspaceLayout,
  width = 1920,
  height = 1080,
  tag?: string,
): Promise<string> {
  // Bounded: this is a card, not a deliverable, and an absurd request for one
  // should not become an absurd allocation.
  const w = Math.min(Math.max(Math.round(width) || 1920, 16), 4096);
  const h = Math.min(Math.max(Math.round(height) || 1080, 16), 4096);

  /*
   * A tag gives each reservation its own file, and that matters more than it
   * looks: importing one path twice can hand back the same project item, and
   * Premiere swaps media by pointing an item at a new file — so two
   * placeholders sharing an item would fill together, the second render
   * replacing the first.
   */
  const safe = (tag ?? "").replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 24);
  const name = safe
    ? `seed-pending-${w}x${h}-${safe}.png`
    : `seed-pending-${w}x${h}.png`;

  const target = path.join(workspace.root, name);
  if (!existsSync(target)) await writeFile(target, paint(w, h));
  return target;
}
