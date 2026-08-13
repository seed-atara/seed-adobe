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

MIGRATIONS.push({
  version: 2,
  name: "jobs-and-generation-inputs",
  sql: `
    -- Jobs are mutable by nature (they transition), unlike assets and the
    -- generation recipe itself.
    CREATE TABLE jobs (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      provider         TEXT NOT NULL,
      model            TEXT NOT NULL,
      operation        TEXT NOT NULL,
      provider_job_id  TEXT,
      status           TEXT NOT NULL,
      progress         REAL,
      generation_id    TEXT REFERENCES generations(id),
      correlation_id   TEXT NOT NULL,
      attempts         INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL,
      updated_at       TEXT NOT NULL,
      completed_at     TEXT,
      error_class      TEXT,
      error_message    TEXT
    );

    CREATE INDEX jobs_status_idx     ON jobs (status);
    CREATE INDEX jobs_created_idx    ON jobs (created_at DESC);
    CREATE INDEX jobs_generation_idx ON jobs (generation_id);

    -- Explicit join table rather than JSON containment queries: lineage walks
    -- are the core of the product and need to be indexed, not scanned.
    CREATE TABLE generation_inputs (
      generation_id TEXT NOT NULL REFERENCES generations(id),
      asset_id      TEXT NOT NULL REFERENCES assets(id),
      role          TEXT NOT NULL DEFAULT 'reference',
      position      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (generation_id, asset_id, position)
    );

    CREATE INDEX generation_inputs_asset_idx ON generation_inputs (asset_id);
  `,
});

MIGRATIONS.push({
  version: 3,
  name: "hidden-assets",
  sql: `
    -- Removing an asset hides it and reclaims its bytes; the row stays.
    --
    -- Deleting the row would take the provenance with it: the recipes that
    -- used this frame as an input still name it, and a dangling id explains
    -- nothing. It would also break library ordering, which uses rowid to break
    -- same-millisecond ties and needs it to stay monotonic.
    --
    -- So a removed asset becomes what a missing file already meant — status
    -- 'missing' — plus a timestamp recording that it was deliberate.
    ALTER TABLE assets ADD COLUMN hidden_at TEXT;
  `,
});

MIGRATIONS.push({
  version: 4,
  name: "asset-project",
  sql: `
    -- Which host project an asset belongs to.
    --
    -- One service serves every open application, so one library holds every
    -- project — which is right (a reference made in one shot is worth reusing
    -- in another) and unusable without a way to say "just this one".
    --
    -- Denormalised onto the asset rather than derived at query time because a
    -- generated result has no project of its own: it inherits from whatever it
    -- was made from, and walking lineage per row to draw a grid is the kind of
    -- query that is fine until the library is large.
    ALTER TABLE assets ADD COLUMN project TEXT;

    CREATE INDEX assets_project_idx ON assets (project);

    -- Backfill what can be known. A captured frame records its project in its
    -- own provenance; anything generated takes the project of its first input,
    -- which is where it came from.
    UPDATE assets
       SET project = json_extract(source_json, '$.context.projectName')
     WHERE source_type = 'after-effects'
       AND json_extract(source_json, '$.context.projectName') IS NOT NULL;

    UPDATE assets
       SET project = (
         SELECT source.project
           FROM generation_inputs gi
           JOIN assets source ON source.id = gi.asset_id
          WHERE gi.generation_id = assets.generation_id
            AND source.project IS NOT NULL
          ORDER BY gi.position
          LIMIT 1
       )
     WHERE project IS NULL
       AND generation_id IS NOT NULL;
  `,
});

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
