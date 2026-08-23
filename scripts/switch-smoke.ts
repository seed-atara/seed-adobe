/**
 * End-to-end check for `/v1/switch`, against a *running* service.
 *
 *   npx tsx --env-file=.env scripts/switch-smoke.ts [baseUrl] [token]
 *
 * Synthesises its own frames rather than needing footage, so it can be run on
 * any machine — the point is that the route works end to end and registers
 * real media, not that the picture is pretty.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodePng, type RasterImage } from "@seed-ae/media";

const baseUrl = process.argv[2] ?? `http://127.0.0.1:${process.env.SEED_AE_PORT ?? 47831}`;
const token = process.argv[3] ?? process.env.SEED_AE_SESSION_TOKEN ?? "";

async function call(route: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `${route} -> HTTP ${response.status} ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }
  return payload as any;
}

function hash(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number, y: number, cell: number, seed: number): number {
  const gx = Math.floor(x / cell);
  const gy = Math.floor(y / cell);
  const fx = x / cell - gx;
  const fy = y / cell - gy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(gx, gy, seed);
  const b = hash(gx + 1, gy, seed);
  const c = hash(gx, gy + 1, seed);
  const d = hash(gx + 1, gy + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

function scene(width: number, height: number): RasterImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const v =
          noise(x, y, 40, c + 1) * 0.6 + noise(x, y, 13, c + 5) * 0.3 + noise(x, y, 4, c + 9) * 0.1;
        rgba[at + c] = Math.round(v * 255);
      }
      rgba[at + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function crop(s: RasterImage, x0: number, y0: number, w: number, h: number): RasterImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(s.width - 1, Math.max(0, x0 + x));
      const sy = Math.min(s.height - 1, Math.max(0, y0 + y));
      const f = (sy * s.width + sx) * 4;
      const t = (y * w + x) * 4;
      rgba[t] = s.rgba[f] as number;
      rgba[t + 1] = s.rgba[f + 1] as number;
      rgba[t + 2] = s.rgba[f + 2] as number;
      rgba[t + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

const W = 192;
const H = 144;

const dir = await mkdtemp(path.join(tmpdir(), "seed switch "));
const world = scene(W + 60, H + 60);

async function adopt(image: RasterImage, name: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, encodePng(image.width, image.height, image.rgba));
  const { asset } = await call("/v1/assets/adopt", { path: file });
  return asset.id as string;
}

console.log(`service ${baseUrl}`);
console.log((await call("/health")).status === "ok" ? "health ok" : "health FAILED");

console.log("\n--- /v1/switch (custom matte, no model) ---");
const subject = crop(world, 30, 30, W, H);
const backdrop = scene(W, H);
const matte: RasterImage = {
  width: W,
  height: H,
  rgba: new Uint8Array(W * H * 4),
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const at = (y * W + x) * 4;
    const inside = x > W * 0.3 && x < W * 0.7 && y > H * 0.2;
    const v = inside ? 255 : 0;
    matte.rgba[at] = v;
    matte.rgba[at + 1] = v;
    matte.rgba[at + 2] = v;
    matte.rgba[at + 3] = 255;
  }
}

const subjectId = await adopt(subject, "subject.png");
const backdropId = await adopt(backdrop, "backdrop.png");
const matteId = await adopt(matte, "matte.png");

const switched = await call("/v1/switch", {
  sourceAssetId: subjectId,
  referenceAssetId: backdropId,
  alphaMode: "custom",
  alphaAssetId: matteId,
});
console.log(
  `render=${switched.render.id}  matte=${switched.matte.id}  ` +
    `kept=${(switched.matteCoverage * 100).toFixed(1)}%  ` +
    `lightingResidual=${switched.lighting.residual.toFixed(4)} expressible=${switched.lighting.expressible}`,
);

console.log("\n--- /v1/providers: is SwitchX offered for comparison? ---");
const providers = await call("/v1/providers");
const ids = providers.providers.map((p: { id: string }) => p.id);
console.log(ids.join(", "));

console.log("\nOK");
