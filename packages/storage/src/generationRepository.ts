import {
  GenerationSchema,
  SeedError,
  newId,
  nowIso,
  type Generation,
  type GenerationOperation,
  type JobStatus,
} from "@seed-ae/domain";
import type { Database } from "./database.js";

export interface GenerationDraft {
  provider: string;
  model: string;
  operation: GenerationOperation;
  prompt: string;
  seed?: number | string;
  parameters?: Record<string, unknown>;
  inputAssetIds?: string[];
  parentAssetId?: string;
  parentGenerationId?: string;
  jobId: string;
  rawRequest?: unknown;
}

export interface GenerationCompletion {
  status: Extract<JobStatus, "succeeded" | "failed" | "cancelled">;
  outputAssetIds?: string[];
  rawResponse?: unknown;
  errorClass?: string;
  errorMessage?: string;
}

interface GenerationRow {
  id: string;
  provider: string;
  model: string;
  operation: string;
  prompt: string;
  seed: string | null;
  parameters_json: string;
  input_asset_ids_json: string;
  output_asset_ids_json: string;
  parent_asset_id: string | null;
  parent_generation_id: string | null;
  job_id: string;
  status: string;
  created_at: string;
  completed_at: string | null;
  error_class: string | null;
  error_message: string | null;
  raw_request_json: string | null;
  raw_response_json: string | null;
}

const SELECT_COLUMNS = `
  id, provider, model, operation, prompt, seed, parameters_json,
  input_asset_ids_json, output_asset_ids_json, parent_asset_id,
  parent_generation_id, job_id, status, created_at, completed_at,
  error_class, error_message, raw_request_json, raw_response_json
`;

export class GenerationRepository {
  constructor(private readonly db: Database) {}

  create(draft: GenerationDraft): Generation {
    const generation: Generation = GenerationSchema.parse({
      ...draft,
      id: newId("generation"),
      parameters: draft.parameters ?? {},
      inputAssetIds: draft.inputAssetIds ?? [],
      outputAssetIds: [],
      status: "queued" satisfies JobStatus,
      createdAt: nowIso(),
    });

    try {
      this.db.exec("BEGIN");
      this.db
        .prepare(
          `INSERT INTO generations (
             id, provider, model, operation, prompt, seed, parameters_json,
             input_asset_ids_json, output_asset_ids_json, parent_asset_id,
             parent_generation_id, job_id, status, created_at, raw_request_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          generation.id,
          generation.provider,
          generation.model,
          generation.operation,
          generation.prompt,
          generation.seed === undefined ? null : String(generation.seed),
          JSON.stringify(generation.parameters),
          JSON.stringify(generation.inputAssetIds),
          JSON.stringify([]),
          generation.parentAssetId ?? null,
          generation.parentGenerationId ?? null,
          generation.jobId,
          generation.status,
          generation.createdAt,
          generation.rawRequest === undefined
            ? null
            : JSON.stringify(generation.rawRequest),
        );

      const link = this.db.prepare(
        `INSERT INTO generation_inputs (generation_id, asset_id, role, position)
         VALUES (?, ?, ?, ?)`,
      );
      generation.inputAssetIds.forEach((assetId, position) => {
        link.run(
          generation.id,
          assetId,
          assetId === generation.parentAssetId ? "parent" : "reference",
          position,
        );
      });
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw new SeedError("storage_error", "could not record generation", { cause });
    }

    return generation;
  }

  getById(id: string): Generation | undefined {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM generations WHERE id = ?`)
      .get(id) as GenerationRow | undefined;
    return row ? rowToGeneration(row) : undefined;
  }

  requireById(id: string): Generation {
    const generation = this.getById(id);
    if (!generation) {
      throw new SeedError("not_found", `generation ${id} not found`);
    }
    return generation;
  }

  setStatus(id: string, status: JobStatus): Generation {
    const result = this.db
      .prepare("UPDATE generations SET status = ? WHERE id = ?")
      .run(status, id);
    if (result.changes === 0) {
      throw new SeedError("not_found", `generation ${id} not found`);
    }
    return this.requireById(id);
  }

  /**
   * Records what was actually sent to the provider.
   *
   * Written after submission rather than at creation, because it is the
   * adapter that decides the wire shape — which model id, which reference
   * form, which parameters survived normalization. Without it a recipe records
   * what was asked for and nothing about what was sent, and the two differ in
   * exactly the cases worth debugging. Adapters strip credentials before
   * returning it.
   *
   * Set once: a request is a fact about a moment, and a second submission is a
   * second generation.
   */
  setRawRequest(id: string, rawRequest: unknown): void {
    const result = this.db
      .prepare(
        "UPDATE generations SET raw_request_json = ? WHERE id = ? AND raw_request_json IS NULL",
      )
      .run(JSON.stringify(rawRequest), id);
    if (result.changes === 0 && !this.getById(id)) {
      throw new SeedError("not_found", `generation ${id} not found`);
    }
  }

  /** Records the terminal outcome. History is completed, never rewritten. */
  complete(id: string, completion: GenerationCompletion): Generation {
    const result = this.db
      .prepare(
        `UPDATE generations
            SET status = ?,
                output_asset_ids_json = ?,
                raw_response_json = ?,
                error_class = ?,
                error_message = ?,
                completed_at = ?
          WHERE id = ?`,
      )
      .run(
        completion.status,
        JSON.stringify(completion.outputAssetIds ?? []),
        completion.rawResponse === undefined
          ? null
          : JSON.stringify(completion.rawResponse),
        completion.errorClass ?? null,
        completion.errorMessage ?? null,
        nowIso(),
        id,
      );
    if (result.changes === 0) {
      throw new SeedError("not_found", `generation ${id} not found`);
    }
    return this.requireById(id);
  }

  list(limit = 50, offset = 0): { generations: Generation[]; total: number } {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM generations
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as unknown as GenerationRow[];
    const { total } = this.db
      .prepare("SELECT COUNT(*) AS total FROM generations")
      .get() as { total: number };
    return { generations: rows.map(rowToGeneration), total };
  }

  /** Generations that consumed this asset as an input or parent. */
  consumersOf(assetId: string): Generation[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM generations
          WHERE id IN (SELECT generation_id FROM generation_inputs WHERE asset_id = ?)
             OR parent_asset_id = ?
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(assetId, assetId) as unknown as GenerationRow[];
    return rows.map(rowToGeneration);
  }
}

/**
 * Seeds are stored as TEXT because providers accept either form, but a seed
 * that went in as a number must come back as one — otherwise reopening a
 * recipe silently changes its type and the round-trip is not reproducible.
 */
function parseSeed(value: string): number | string {
  return /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : value;
}

function rowToGeneration(row: GenerationRow): Generation {
  return GenerationSchema.parse({
    id: row.id,
    provider: row.provider,
    model: row.model,
    operation: row.operation,
    prompt: row.prompt,
    ...(row.seed !== null ? { seed: parseSeed(row.seed) } : {}),
    parameters: JSON.parse(row.parameters_json),
    inputAssetIds: JSON.parse(row.input_asset_ids_json),
    outputAssetIds: JSON.parse(row.output_asset_ids_json),
    ...(row.parent_asset_id !== null ? { parentAssetId: row.parent_asset_id } : {}),
    ...(row.parent_generation_id !== null
      ? { parentGenerationId: row.parent_generation_id }
      : {}),
    jobId: row.job_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.error_class !== null ? { errorClass: row.error_class } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
    ...(row.raw_request_json !== null
      ? { rawRequest: JSON.parse(row.raw_request_json) }
      : {}),
    ...(row.raw_response_json !== null
      ? { rawResponse: JSON.parse(row.raw_response_json) }
      : {}),
  });
}
