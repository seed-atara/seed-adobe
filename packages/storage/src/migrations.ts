export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Migrations are append-only and run inside a transaction. Never edit an
 * applied migration — add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init-assets-and-generations",
    sql: `
      CREATE TABLE generations (
        id                    TEXT PRIMARY KEY,
        provider              TEXT NOT NULL,
        model                 TEXT NOT NULL,
        operation             TEXT NOT NULL,
        prompt                TEXT NOT NULL,
        seed                  TEXT,
        parameters_json       TEXT NOT NULL DEFAULT '{}',
        input_asset_ids_json  TEXT NOT NULL DEFAULT '[]',
        output_asset_ids_json TEXT NOT NULL DEFAULT '[]',
        parent_asset_id       TEXT,
        parent_generation_id  TEXT REFERENCES generations(id),
        job_id                TEXT NOT NULL,
        status                TEXT NOT NULL,
        created_at            TEXT NOT NULL,
        completed_at          TEXT,
        error_class           TEXT,
        error_message         TEXT,
        raw_request_json      TEXT,
        raw_response_json     TEXT
      );

      CREATE TABLE assets (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        status           TEXT NOT NULL,
        filename         TEXT NOT NULL,
        mime_type        TEXT NOT NULL,
        storage_uri      TEXT NOT NULL,
        thumbnail_uri    TEXT,
        width            INTEGER,
        height           INTEGER,
        duration_seconds REAL,
        fps              REAL,
        byte_size        INTEGER,
        created_at       TEXT NOT NULL,
        generation_id    TEXT REFERENCES generations(id),
        source_type      TEXT NOT NULL,
        source_json      TEXT NOT NULL
      );

      CREATE INDEX assets_created_at_idx  ON assets (created_at DESC);
      CREATE INDEX assets_kind_idx        ON assets (kind);
      CREATE INDEX assets_generation_idx  ON assets (generation_id);
      CREATE INDEX generations_created_idx ON generations (created_at DESC);
      CREATE INDEX generations_parent_idx  ON generations (parent_generation_id);

      -- Assets are immutable media. Mutable bookkeeping (status, thumbnail,
      -- probed dimensions) is allowed; identity and provenance are not.
      CREATE TRIGGER assets_core_immutable
      BEFORE UPDATE OF id, kind, filename, mime_type, storage_uri, created_at,
                       generation_id, source_type, source_json ON assets
      BEGIN
        SELECT RAISE(ABORT, 'asset identity is immutable: create a descendant instead');
      END;

      -- Assets are never deleted either: a missing file becomes status
      -- 'missing', it does not become a missing row. This also keeps rowid
      -- monotonic, which the library ordering relies on to break same-
      -- millisecond ties in insertion order.
      CREATE TRIGGER assets_no_delete
      BEFORE DELETE ON assets
      BEGIN
        SELECT RAISE(ABORT, 'assets are append-only: mark the asset missing instead');
      END;

      -- Generation history is append-only; a failed or superseded generation
      -- stays in the lineage.
      CREATE TRIGGER generations_no_delete
      BEFORE DELETE ON generations
      BEGIN
        SELECT RAISE(ABORT, 'generation history is append-only');
      END;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
