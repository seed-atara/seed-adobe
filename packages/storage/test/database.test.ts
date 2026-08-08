import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  getSchemaVersion,
  migrate,
  openDatabase,
  openMigratedDatabase,
} from "../src/index.js";

describe("migrations", () => {
  it("brings an empty database to the latest schema version", () => {
    const db = openMigratedDatabase({ path: ":memory:" });
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("is idempotent", () => {
    const db = openDatabase({ path: ":memory:" });
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    const applied = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    expect(applied.n).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("refuses to delete generation history", () => {
    const db = openMigratedDatabase({ path: ":memory:" });
    db.prepare(
      `INSERT INTO generations (id, provider, model, operation, prompt, job_id, status, created_at)
       VALUES ('gen_1', 'mock', 'm', 'image.generate', 'p', 'job_1', 'succeeded', '2026-08-08T10:00:00.000Z')`,
    ).run();
    expect(() => db.prepare("DELETE FROM generations WHERE id = 'gen_1'").run())
      .toThrow(/append-only/);
    db.close();
  });
});
