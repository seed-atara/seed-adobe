import {
  JobStatusSchema,
  SeedError,
  newId,
  nowIso,
  type GenerationOperation,
  type JobStatus,
} from "@seed-ae/domain";
import type { Database } from "./database.js";

export interface Job {
  id: string;
  kind: "generation";
  provider: string;
  model: string;
  operation: GenerationOperation;
  providerJobId?: string;
  status: JobStatus;
  progress?: number;
  generationId?: string;
  correlationId: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorClass?: string;
  errorMessage?: string;
}

export interface JobDraft {
  provider: string;
  model: string;
  operation: GenerationOperation;
  correlationId: string;
}

export interface JobUpdate {
  status?: JobStatus;
  progress?: number;
  providerJobId?: string;
  generationId?: string;
  attempts?: number;
  errorClass?: string;
  errorMessage?: string;
}

interface JobRow {
  id: string;
  kind: string;
  provider: string;
  model: string;
  operation: string;
  provider_job_id: string | null;
  status: string;
  progress: number | null;
  generation_id: string | null;
  correlation_id: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error_class: string | null;
  error_message: string | null;
}

const SELECT_COLUMNS = `
  id, kind, provider, model, operation, provider_job_id, status, progress,
  generation_id, correlation_id, attempts, created_at, updated_at,
  completed_at, error_class, error_message
`;

const TERMINAL: JobStatus[] = ["succeeded", "failed", "cancelled"];

export class JobRepository {
  constructor(private readonly db: Database) {}

  create(draft: JobDraft): Job {
    const timestamp = nowIso();
    const job: Job = {
      id: newId("job"),
      kind: "generation",
      provider: draft.provider,
      model: draft.model,
      operation: draft.operation,
      status: "queued",
      correlationId: draft.correlationId,
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db
      .prepare(
        `INSERT INTO jobs (
           id, kind, provider, model, operation, status, correlation_id,
           attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.id,
        job.kind,
        job.provider,
        job.model,
        job.operation,
        job.status,
        job.correlationId,
        job.attempts,
        job.createdAt,
        job.updatedAt,
      );

    return job;
  }

  getById(id: string): Job | undefined {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM jobs WHERE id = ?`)
      .get(id) as JobRow | undefined;
    return row ? rowToJob(row) : undefined;
  }

  requireById(id: string): Job {
    const job = this.getById(id);
    if (!job) throw new SeedError("not_found", `job ${id} not found`);
    return job;
  }

  update(id: string, update: JobUpdate): Job {
    const current = this.requireById(id);
    const status = update.status ?? current.status;
    const completedAt =
      TERMINAL.includes(status) && !current.completedAt ? nowIso() : current.completedAt;

    this.db
      .prepare(
        `UPDATE jobs
            SET status = ?, progress = ?, provider_job_id = ?, generation_id = ?,
                attempts = ?, error_class = ?, error_message = ?,
                updated_at = ?, completed_at = ?
          WHERE id = ?`,
      )
      .run(
        JobStatusSchema.parse(status),
        update.progress ?? current.progress ?? null,
        update.providerJobId ?? current.providerJobId ?? null,
        update.generationId ?? current.generationId ?? null,
        update.attempts ?? current.attempts,
        update.errorClass ?? current.errorClass ?? null,
        update.errorMessage ?? current.errorMessage ?? null,
        nowIso(),
        completedAt ?? null,
        id,
      );

    return this.requireById(id);
  }

  /** Jobs that were still in flight — used to resume after a service restart. */
  listUnfinished(): Job[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM jobs
          WHERE status IN ('queued', 'running')
          ORDER BY created_at ASC`,
      )
      .all() as unknown as JobRow[];
    return rows.map(rowToJob);
  }

  listRecent(limit = 50): Job[] {
    const rows = this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM jobs
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(limit) as unknown as JobRow[];
    return rows.map(rowToJob);
  }
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: "generation",
    provider: row.provider,
    model: row.model,
    operation: row.operation as GenerationOperation,
    ...(row.provider_job_id !== null ? { providerJobId: row.provider_job_id } : {}),
    status: JobStatusSchema.parse(row.status),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.generation_id !== null ? { generationId: row.generation_id } : {}),
    correlationId: row.correlation_id,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.error_class !== null ? { errorClass: row.error_class } : {}),
    ...(row.error_message !== null ? { errorMessage: row.error_message } : {}),
  };
}
