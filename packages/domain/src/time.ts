/**
 * All persisted timestamps are ISO-8601 UTC strings with millisecond precision.
 * Keeping one representation avoids timezone drift between SQLite, the service
 * and the panel.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isIsoTimestamp(value: string): boolean {
  return ISO_UTC_MS.test(value) && !Number.isNaN(Date.parse(value));
}
