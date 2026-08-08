const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password)/i;

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured line logger with a redaction pass. Credentials and prompts must
 * never reach a log file — see docs/architecture (Security/Observability).
 */
export function createLogger(
  level: LogLevel = "info",
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const threshold = LEVELS[level];

  const log = (
    entryLevel: LogLevel,
    message: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (LEVELS[entryLevel] < threshold) return;
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: entryLevel,
        message,
        ...reserveEnvelope(redact(fields)),
      }),
    );
  };

  return {
    log,
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function redact(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = redact(value as Record<string, unknown>);
    } else {
      output[key] = value;
    }
  }
  return output;
}

const ENVELOPE_KEYS = new Set(["ts", "level", "message"]);

/**
 * Keeps a caller-supplied field from overwriting the log envelope — an entry
 * whose `message` is the error text rather than the event name is unsearchable.
 */
export function reserveEnvelope(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    output[ENVELOPE_KEYS.has(key) ? `field_${key}` : key] = value;
  }
  return output;
}

export const silentLogger: Logger = createLogger("error", () => {});
