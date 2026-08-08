import { SeedError } from "@seed-ae/domain";

/**
 * Per-model minimum output area, in pixels.
 *
 * These are real constraints, not style guidance: asking a 3.7MP model for
 * 1024x1024 is rejected outright. Verified against the live API — keep this
 * table in step with docs/research/MODEL_API_NOTES.md.
 */
export const MODEL_MIN_PIXELS: Record<string, number> = {
  "dola-seedream-5-0-pro-260628": 921_600,
  "seedream-5-0-260128": 3_686_400,
  "seedream-4-5-251128": 3_686_400,
  "seedream-4-0-250828": 921_600,
};

/** Models the vendor has withdrawn. Requests to these 404. */
export const WITHDRAWN_MODELS: Record<string, string> = {
  "seededit-3-0-i2i-250628":
    "withdrawn by the vendor. Use a Seedream model with an `image` input for edits.",
};

/** Keyword sizes the API resolves itself; no local area check applies. */
export const KEYWORD_SIZES = ["2K", "4K"] as const;

/** Ark accepts up to 14 reference images. */
export const MAX_REFERENCES = 14;

/** With multi-image generation, references + generated must stay <= 15. */
export const MAX_REFERENCES_PLUS_OUTPUTS = 15;

export function minPixelsFor(model: string): number | undefined {
  return MODEL_MIN_PIXELS[model];
}

/**
 * Sizes that are safe for a model, given its minimum area. Offered to the panel
 * so the artist cannot pick a size the API will reject.
 */
export function sizesFor(model: string): string[] {
  const minimum = minPixelsFor(model);
  const candidates = [
    "1280x720",
    "1024x1024",
    "1920x1080",
    "2048x2048",
    "2560x1440",
    "3024x1296",
    "2160x3840",
  ];
  const allowed =
    minimum === undefined
      ? candidates
      : candidates.filter((size) => {
          const parsed = parseExplicitSize(size);
          return parsed !== undefined && parsed.width * parsed.height >= minimum;
        });
  return [...KEYWORD_SIZES, ...allowed];
}

export function parseExplicitSize(
  size: string,
): { width: number; height: number } | undefined {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size.trim());
  if (!match) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Validates a requested size against the model's constraints, so a bad size
 * fails locally with an explanation instead of costing a round trip.
 */
export function assertSizeAllowed(model: string, size: string): void {
  if ((KEYWORD_SIZES as readonly string[]).includes(size)) return;

  const parsed = parseExplicitSize(size);
  if (!parsed) {
    throw new SeedError(
      "bad_request",
      `size must be a keyword (${KEYWORD_SIZES.join(", ")}) or WIDTHxHEIGHT, received "${size}"`,
    );
  }

  const ratio = parsed.width / parsed.height;
  if (ratio < 1 / 16 || ratio > 16) {
    throw new SeedError(
      "bad_request",
      `aspect ratio must be within 1:16 and 16:1, received ${parsed.width}x${parsed.height}`,
    );
  }

  const minimum = minPixelsFor(model);
  if (minimum !== undefined && parsed.width * parsed.height < minimum) {
    throw new SeedError(
      "bad_request",
      `${model} requires at least ${minimum.toLocaleString("en-US")} pixels; ` +
        `${parsed.width}x${parsed.height} is ${(parsed.width * parsed.height).toLocaleString("en-US")}`,
      { details: { model, minimumPixels: minimum, suggested: sizesFor(model) } },
    );
  }
}

export function assertModelAvailable(model: string): void {
  const reason = WITHDRAWN_MODELS[model];
  if (reason) {
    throw new SeedError("unsupported_capability", `${model} is ${reason}`);
  }
}
