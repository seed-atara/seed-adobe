import {
  AssetSchema,
  AssetSourceSchema,
  SeedError,
  newId,
  nowIso,
  type Asset,
  type AssetDraft,
  type AssetKind,
  type AssetStatus,
} from "@seed-ae/domain";
import type { Database } from "./database.js";

export interface ListAssetsOptions {
  limit?: number;
  offset?: number;
  kind?: AssetKind;
}

export interface ListAssetsResult {
  assets: Asset[];
  total: number;
}

interface AssetRow {
  id: string;
  kind: string;
  status: string;
  filename: string;
  mime_type: string;
  storage_uri: string;
  thumbnail_uri: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  fps: number | null;
  byte_size: number | null;
  created_at: string;
  generation_id: string | null;
  source_type: string;
  source_json: string;
}

const INSERT_SQL = `
  INSERT INTO assets (
    id, kind, status, filename, mime_type, storage_uri, thumbnail_uri,
    width, height, duration_seconds, fps, byte_size, created_at,
    generation_id, source_type, source_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SELECT_COLUMNS = `
  id, kind, status, filename, mime_type, storage_uri, thumbnail_uri,
  width, height, duration_seconds, fps, byte_size, created_at,
  generation_id, source_type, source_json
`;

export class AssetRepository {
  constructor(private readonly db: Database) {}

  create(draft: AssetDraft): Asset {
    const asset: Asset = {
      ...draft,
      id: newId("asset"),
      status: draft.status ?? "ready",
      createdAt: nowIso(),
    };

    const parsed = AssetSchema.parse(asset);

    try {
      this.db
        .prepare(INSERT_SQL)
        .run(
          parsed.id,
          parsed.kind,
          parsed.status,
          parsed.filename,
          parsed.mimeType,
          parsed.storageUri,
          parsed.thumbnailUri ?? null,
          parsed.width ?? null,
          parsed.height ?? null,
          parsed.durationSeconds ?? null,
          parsed.fps ?? null,
          parsed.byteSize ?? null,
          parsed.createdAt,
          parsed.generationId ?? null,
          parsed.source.type,
          JSON.stringify(parsed.source),
        );
    } catch (cause) {
      throw new SeedError("storage_error", "could not register asset", { cause });
    }

    return parsed;
  }

  getById(id: string): Asset | undefined {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM assets WHERE id = ?`)
      .get(id) as AssetRow | undefined;
    return row ? rowToAsset(row) : undefined;
  }

  requireById(id: string): Asset {
    const asset = this.getById(id);
    if (!asset) {
      throw new SeedError("not_found", `asset ${id} not found`);
    }
    return asset;
  }

  list(options: ListAssetsOptions = {}): ListAssetsResult {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const where = options.kind ? "WHERE kind = ?" : "";
    const filterParams = options.kind ? [options.kind] : [];

    const rows = this.db
      .prepare(
        // rowid breaks ties in true insertion order: createdAt is only
        // millisecond-precise, and several captures can land in one tick.
        // Safe because assets are never deleted (assets_no_delete trigger).
        `SELECT ${SELECT_COLUMNS} FROM assets ${where}
         ORDER BY created_at DESC, rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...filterParams, limit, offset) as unknown as AssetRow[];

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM assets ${where}`)
      .get(...filterParams) as { total: number };

    return { assets: rows.map(rowToAsset), total: totalRow.total };
  }

  /** Ready assets that have no thumbnail yet, oldest first. */
  listMissingThumbnails(limit = 200): Asset[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM assets
          WHERE thumbnail_uri IS NULL AND status = 'ready' AND kind = 'image'
          ORDER BY rowid ASC LIMIT ?`,
      )
      .all(limit) as unknown as AssetRow[];
    return rows.map(rowToAsset);
  }

  /**
   * Status and derived metadata are the only mutable parts of an asset; the
   * `assets_core_immutable` trigger enforces the rest at the database level.
   */
  updateStatus(id: string, status: AssetStatus): Asset {
    const result = this.db
      .prepare("UPDATE assets SET status = ? WHERE id = ?")
      .run(status, id);
    if (result.changes === 0) {
      throw new SeedError("not_found", `asset ${id} not found`);
    }
    return this.requireById(id);
  }

  setThumbnail(id: string, thumbnailUri: string): Asset {
    const result = this.db
      .prepare("UPDATE assets SET thumbnail_uri = ? WHERE id = ?")
      .run(thumbnailUri, id);
    if (result.changes === 0) {
      throw new SeedError("not_found", `asset ${id} not found`);
    }
    return this.requireById(id);
  }
}

function rowToAsset(row: AssetRow): Asset {
  const source = AssetSourceSchema.parse(JSON.parse(row.source_json));
  return AssetSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    filename: row.filename,
    mimeType: row.mime_type,
    storageUri: row.storage_uri,
    ...(row.thumbnail_uri !== null ? { thumbnailUri: row.thumbnail_uri } : {}),
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(row.duration_seconds !== null
      ? { durationSeconds: row.duration_seconds }
      : {}),
    ...(row.fps !== null ? { fps: row.fps } : {}),
    ...(row.byte_size !== null ? { byteSize: row.byte_size } : {}),
    createdAt: row.created_at,
    ...(row.generation_id !== null ? { generationId: row.generation_id } : {}),
    source,
  });
}
