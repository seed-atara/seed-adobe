/**
 * Normalized error classes. Providers, storage and the HTTP layer all map onto
 * these so the panel never has to interpret a provider-specific error shape.
 */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "not_found",
  "conflict",
  "unsupported_capability",
  "provider_error",
  "storage_error",
  "host_error",
  "internal_error",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class SeedError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { httpStatus?: number; details?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SeedError";
    this.code = code;
    this.httpStatus = options?.httpStatus ?? defaultHttpStatus(code);
    this.details = options?.details;
  }
}

function defaultHttpStatus(code: ErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unsupported_capability":
      return 422;
    case "provider_error":
      return 502;
    default:
      return 500;
  }
}

export function toSeedError(error: unknown): SeedError {
  if (error instanceof SeedError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SeedError("internal_error", message, { cause: error });
}
