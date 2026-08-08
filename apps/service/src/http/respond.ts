import type { ServerResponse } from "node:http";
import { SeedError, toSeedError } from "@seed-ae/domain";

export interface JsonResult {
  readonly __json: true;
  status: number;
  body: unknown;
}

export function json(body: unknown, status = 200): JsonResult {
  return { __json: true, status, body };
}

export function isJsonResult(value: unknown): value is JsonResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __json?: unknown }).__json === true
  );
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  correlationId: string,
): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "x-seed-correlation-id": correlationId,
    // The panel is a local page; nothing else should be able to read this.
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function sendError(
  res: ServerResponse,
  error: unknown,
  correlationId: string,
): SeedError {
  const seedError = toSeedError(error);
  sendJson(
    res,
    seedError.httpStatus,
    {
      error: {
        code: seedError.code,
        message: seedError.message,
        ...(seedError.details === undefined
          ? {}
          : { details: seedError.details }),
      },
    },
    correlationId,
  );
  return seedError;
}
