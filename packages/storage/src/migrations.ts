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

MIGRATIONS.push({
  version: 5,
  name: "items",
  sql: `
    -- Items are the consistency layer: a named identity (a person, a place, a
    -- prop, a look) that must appear the same way across many generations.
    --
    -- Unlike assets, an item is MUTABLE by nature — it gains plates, loses
    -- them, gets rewritten mid-show. Reproducibility survives that because the
    -- definition is split off into immutable revisions, and a generation
    -- records the revision it resolved rather than the item. See ADR 0011.
    CREATE TABLE items (
      id                  TEXT PRIMARY KEY,
      handle              TEXT NOT NULL,
      kind                TEXT NOT NULL,
      name                TEXT NOT NULL,
      tags_json           TEXT NOT NULL DEFAULT '[]',
      -- NULL means studio-wide, which is the default and the inverse of an
      -- asset's rule. Items exist to travel between shows.
      project             TEXT,
      -- A real likeness needs the subject's own liveness authorisation before
      -- the provider will accept it; a generated character needs none.
      real_person         INTEGER NOT NULL DEFAULT 0,
      authorisation       TEXT NOT NULL DEFAULT 'not-required',
      -- providerId -> native grouping id. An Ark Asset Group is documented as
      -- the several references of ONE character, which is exactly an item.
      provider_groups_json TEXT NOT NULL DEFAULT '{}',
      default_variant_id  TEXT,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL
    );

    CREATE TABLE item_variants (
      id                TEXT PRIMARY KEY,
      item_id           TEXT NOT NULL REFERENCES items(id),
      slug              TEXT NOT NULL,
      name              TEXT NOT NULL,
      parent_variant_id TEXT REFERENCES item_variants(id),
      created_at        TEXT NOT NULL,
      UNIQUE (item_id, slug)
    );

    -- The immutable payload. This is what a generation points at.
    CREATE TABLE item_revisions (
      id           TEXT PRIMARY KEY,
      variant_id   TEXT NOT NULL REFERENCES item_variants(id),
      revision     INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      message      TEXT,
      avoid_json   TEXT NOT NULL DEFAULT '[]',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      seed_hint    INTEGER,
      look_json    TEXT,
      UNIQUE (variant_id, revision)
    );

    CREATE TABLE item_plates (
      revision_id       TEXT NOT NULL REFERENCES item_revisions(id),
      position          INTEGER NOT NULL,
      asset_id          TEXT NOT NULL REFERENCES assets(id),
      role              TEXT NOT NULL DEFAULT 'reference',
      weight            INTEGER NOT NULL DEFAULT 0,
      notes             TEXT,
      -- providerId -> the address that provider accepts. Ark takes a permanent
      -- asset:// id for video and refuses it for images, where only a hosted
      -- URL works, so a plate holds every address it has.
      provider_refs_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (revision_id, position)
    );

    CREATE TABLE item_traits (
      revision_id TEXT NOT NULL REFERENCES item_revisions(id),
      position    INTEGER NOT NULL,
      text        TEXT NOT NULL,
      facet       TEXT NOT NULL DEFAULT 'other',
      priority    INTEGER NOT NULL DEFAULT 0,
      -- Marks the discrete nameable details a reference reliably loses, which
      -- are the ones worth spending prompt words on even when plates travel.
      drift_prone INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (revision_id, position)
    );

    -- Renaming is allowed and must not break history: an old prompt still
    -- resolves, because every handle an item has held is kept with the window
    -- it was current for. Linkage is by revision id regardless; the handle is
    -- presentation.
    CREATE TABLE item_handles (
      item_id TEXT NOT NULL REFERENCES items(id),
      handle  TEXT NOT NULL,
      from_at TEXT NOT NULL,
      to_at   TEXT,
      PRIMARY KEY (item_id, handle, from_at)
    );

    CREATE UNIQUE INDEX item_handles_current_idx
      ON item_handles (handle) WHERE to_at IS NULL;

    -- Which items a generation used, at which revision. The join is explicit
    -- rather than JSON so "every shot @sara appears in" is an index lookup.
    CREATE TABLE generation_items (
      generation_id  TEXT NOT NULL REFERENCES generations(id),
      position       INTEGER NOT NULL,
      item_id        TEXT NOT NULL REFERENCES items(id),
      variant_id     TEXT NOT NULL REFERENCES item_variants(id),
      revision_id    TEXT NOT NULL REFERENCES item_revisions(id),
      handle         TEXT NOT NULL,
      tier           TEXT NOT NULL,
      influence      INTEGER NOT NULL,
      labels_json    TEXT NOT NULL DEFAULT '[]',
      plate_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      dropped_plate_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (generation_id, position)
    );

    CREATE INDEX items_handle_idx          ON items (handle);
    CREATE INDEX items_kind_idx            ON items (kind);
    CREATE INDEX items_project_idx         ON items (project);
    CREATE INDEX item_variants_item_idx    ON item_variants (item_id);
    CREATE INDEX item_revisions_variant_idx ON item_revisions (variant_id);
    CREATE INDEX item_plates_asset_idx     ON item_plates (asset_id);
    CREATE INDEX generation_items_item_idx ON generation_items (item_id);
    CREATE INDEX generation_items_revision_idx ON generation_items (revision_id);

    -- A revision is a snapshot. Editing one would rewrite the meaning of every
    -- generation that already resolved to it — the exact failure the split
    -- between item and revision exists to prevent.
    CREATE TRIGGER item_revisions_immutable
    BEFORE UPDATE ON item_revisions
    BEGIN
      SELECT RAISE(ABORT, 'item revisions are immutable: add a new revision instead');
    END;

    CREATE TRIGGER item_revisions_no_delete
    BEFORE DELETE ON item_revisions
    BEGIN
      SELECT RAISE(ABORT, 'item revisions are append-only');
    END;

    CREATE TRIGGER item_plates_immutable
    BEFORE UPDATE ON item_plates
    BEGIN
      SELECT RAISE(ABORT, 'a revision''s plates are immutable: add a new revision instead');
    END;

    CREATE TRIGGER item_traits_immutable
    BEFORE UPDATE ON item_traits
    BEGIN
      SELECT RAISE(ABORT, 'a revision''s traits are immutable: add a new revision instead');
    END;
  `,
});

MIGRATIONS.push({
  version: 6,
  name: "items-deletable-until-used",
  sql: `
    -- A revision is undeletable *because a generation may point at it*, not
    -- because rows are sacred. An item nobody has generated with is just a
    -- draft, and refusing to delete a draft is how a library fills with
    -- half-made characters that cannot be tidied away.
    --
    -- So the guard becomes conditional: abort only when something actually
    -- references this revision. Provenance is protected exactly as before, and
    -- a mistake made two minutes ago can be undone.
    DROP TRIGGER IF EXISTS item_revisions_no_delete;

    CREATE TRIGGER item_revisions_no_delete_when_used
    BEFORE DELETE ON item_revisions
    WHEN EXISTS (SELECT 1 FROM generation_items WHERE revision_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'this revision has been generated with: deleting it would break a recipe');
    END;
  `,
});

MIGRATIONS.push({
  version: 7,
  name: "generation-remembers-its-project",
  sql: `
    -- A result takes its project from its references, which is right when
    -- there are any. Text-to-video has none, so the output landed with no
    -- project and the library — which filters with 'project = ?', and SQL
    -- never matches NULL — hid it entirely. Two finished clips, paid for and
    -- invisible.
    --
    -- Recorded on the generation rather than passed along the call, because
    -- the resume path after a service restart has the generation and not the
    -- request. Nullable: every generation made before now genuinely does not
    -- know, and inventing one would be worse than admitting it.
    ALTER TABLE generations ADD COLUMN project TEXT;
  `,
});

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
