import { DatabaseSync } from "node:sqlite";
import { SeedError } from "@seed-ae/domain";
import { MIGRATIONS } from "./migrations.js";

export type Database = DatabaseSync;

export interface OpenDatabaseOptions {
  /** Absolute file path, or `:memory:` for tests. */
  path: string;
}

export function openDatabase({ path }: OpenDatabaseOptions): Database {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw new SeedError("storage_error", `could not open database at ${path}`, {
      cause,
    });
  }

  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") {
    // WAL keeps the panel's reads from blocking on a running generation write.
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return db;
}

export function getSchemaVersion(db: Database): number {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     );`,
  );
  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null } | undefined;
  return row?.version ?? 0;
}

export function migrate(db: Database): number {
  const current = getSchemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw new SeedError(
        "storage_error",
        `migration ${migration.version} (${migration.name}) failed`,
        { cause },
      );
    }
  }

  return getSchemaVersion(db);
}

/** Open + migrate in one step; the only entry point the service should need. */
export function openMigratedDatabase(options: OpenDatabaseOptions): Database {
  const db = openDatabase(options);
  migrate(db);
  return db;
}
