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

const WIDTH = 1920;
const HEIGHT = 1080;
const FILE_NAME = "seed-pending.png";

function paint(): Buffer {
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
 * Writes the card once and returns its path.
 *
 * Kept in the workspace rather than a temp directory: a project that is reopened
 * tomorrow with a placeholder still in it should not find its media missing.
 */
export async function ensurePlaceholder(
  workspace: WorkspaceLayout,
): Promise<string> {
  const target = path.join(workspace.root, FILE_NAME);
  if (!existsSync(target)) await writeFile(target, paint());
  return target;
}
