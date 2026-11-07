import { createId, EngineError } from '@universal-flow/core-engine';
import { col, jsonParam, ts, type SqlClient, type SqlRow } from '../db/sql.js';

/**
 * Durable job queue on PostgreSQL. Workers claim jobs with
 * FOR UPDATE SKIP LOCKED, so any number of workers can poll without taking
 * the same job. A claim is a lease: a worker that dies stops renewing it and
 * the job becomes claimable again. Jobs sharing a concurrency key never run
 * at the same time (one execution is advanced by one worker at a time).
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'dead';

export type Job = {
  id: string;
  /** Insertion order; ties on runAt are served first-in, first-out. */
  seq: number;
  type: string;
  payload: unknown;
  status: JobStatus;
  dedupeKey: string | undefined;
  concurrencyKey: string | undefined;
  runAt: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | undefined;
};

export type EnqueueInput = {
  type: string;
  payload: unknown;
  runAt?: number;
  /** A second enqueue with the same key is a no-op that returns the first job. */
  dedupeKey?: string;
  concurrencyKey?: string;
  maxAttempts?: number;
};

export type JobQueue = {
  enqueue: (input: EnqueueInput) => Promise<{ job: Job; created: boolean }>;
  claim: (workerId: string, options: { limit: number; leaseMs: number }) => Promise<Job[]>;
  extendLease: (jobId: string, workerId: string, leaseMs: number) => Promise<boolean>;
  complete: (jobId: string, workerId: string) => Promise<void>;
  /** Puts the job back for another attempt at `retryAt`, or marks it dead when retryAt is undefined. */
  fail: (jobId: string, workerId: string, error: string, retryAt: number | undefined) => Promise<void>;
  get: (jobId: string) => Promise<Job | undefined>;
  findByExecutionId: (executionId: string) => Promise<Job | undefined>;
  counts: () => Promise<Record<JobStatus, number>>;
};

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'dead'];
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 2_000;

const toJob = (row: SqlRow): Job => {
  const status = STATUSES.find((candidate) => candidate === col.string(row, 'status'));
  if (!status) throw new EngineError('WORKFLOW', `Unexpected job status ${col.string(row, 'status')}`);
  return {
    id: col.string(row, 'id'),
    seq: col.number(row, 'seq'),
    type: col.string(row, 'type'),
    payload: col.json(row, 'payload'),
    status,
    dedupeKey: col.optionalString(row, 'dedupe_key'),
    concurrencyKey: col.optionalString(row, 'concurrency_key'),
    runAt: col.epoch(row, 'run_at'),
    attempts: col.number(row, 'attempts'),
    maxAttempts: col.number(row, 'max_attempts'),
    lastError: col.optionalString(row, 'last_error'),
  };
};

export const createPgJobQueue = (sql: SqlClient, now: () => number): JobQueue => ({
  enqueue: async ({ type, payload, runAt, dedupeKey, concurrencyKey, maxAttempts = DEFAULT_MAX_ATTEMPTS }) => {
    const created = await sql.query(
      `INSERT INTO jobs (id, type, payload, status, dedupe_key, concurrency_key, run_at, max_attempts, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, 'queued', $4, $5, $6::timestamptz, $7::int, $8::timestamptz, $8::timestamptz)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      [createId('job'), type, jsonParam(payload), dedupeKey ?? null, concurrencyKey ?? null, ts(runAt ?? now()), maxAttempts, ts(now())],
    );
    const [row] = created;
    if (row) return { job: toJob(row), created: true };
    const [existing] = await sql.query('SELECT * FROM jobs WHERE dedupe_key = $1', [dedupeKey ?? null]);
    if (!existing) throw new EngineError('CONFLICT', `Job ${dedupeKey ?? type} could not be enqueued`);
    return { job: toJob(existing), created: false };
  },

  claim: async (workerId, { limit, leaseMs }) => {
    const current = ts(now());
    const rows = await sql.query(
      `UPDATE jobs SET status = 'running', locked_by = $1, locked_until = $2::timestamptz + ($3::int * interval '1 millisecond'),
         attempts = attempts + 1, updated_at = $2::timestamptz
       WHERE id IN (
         SELECT candidate.id FROM jobs candidate
         WHERE ((candidate.status = 'queued' AND candidate.run_at <= $2::timestamptz)
                OR (candidate.status = 'running' AND candidate.locked_until < $2::timestamptz))
           AND (candidate.concurrency_key IS NULL OR NOT EXISTS (
                 SELECT 1 FROM jobs busy
                 WHERE busy.concurrency_key = candidate.concurrency_key AND busy.id <> candidate.id
                   AND busy.status = 'running' AND busy.locked_until >= $2::timestamptz))
         ORDER BY candidate.run_at, candidate.seq
         LIMIT $4::int
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [workerId, current, leaseMs, limit],
    );
    // The claim above can race another worker's; the lock row is what really grants a key.
    const claimed: Job[] = [];
    for (const job of rows.map(toJob).sort((a, b) => a.runAt - b.runAt || a.seq - b.seq)) {
      if (!job.concurrencyKey) {
        claimed.push(job);
        continue;
      }
      const locked = await sql.query(
        `INSERT INTO job_locks (key, owner_job_id, locked_until)
         VALUES ($1, $2, $3::timestamptz + ($4::int * interval '1 millisecond'))
         ON CONFLICT (key) DO UPDATE SET owner_job_id = EXCLUDED.owner_job_id, locked_until = EXCLUDED.locked_until
         WHERE job_locks.locked_until < $3::timestamptz OR job_locks.owner_job_id = EXCLUDED.owner_job_id
         RETURNING key`,
        [job.concurrencyKey, job.id, current, leaseMs],
      );
      if (locked.length > 0) {
        claimed.push(job);
        continue;
      }
      await sql.query(
        `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_until = NULL, attempts = attempts - 1 WHERE id = $1 AND locked_by = $2 RETURNING id`,
        [job.id, workerId],
      );
    }
    return claimed;
  },

  extendLease: async (jobId, workerId, leaseMs) => {
    const rows = await sql.query(
      `WITH renewed_lock AS (
         UPDATE job_locks SET locked_until = $3::timestamptz + ($4::int * interval '1 millisecond') WHERE owner_job_id = $1 RETURNING key
       )
       UPDATE jobs SET locked_until = $3::timestamptz + ($4::int * interval '1 millisecond')
       WHERE id = $1 AND locked_by = $2 AND status = 'running' RETURNING id`,
      [jobId, workerId, ts(now()), leaseMs],
    );
    return rows.length > 0;
  },

  complete: async (jobId, workerId) => {
    await sql.query(
      `WITH released AS (DELETE FROM job_locks WHERE owner_job_id = $1 RETURNING key)
       UPDATE jobs SET status = 'succeeded', locked_by = NULL, locked_until = NULL, updated_at = $3::timestamptz
       WHERE id = $1 AND locked_by = $2 RETURNING id`,
      [jobId, workerId, ts(now())],
    );
  },

  fail: async (jobId, workerId, error, retryAt) => {
    await sql.query(
      `WITH released AS (DELETE FROM job_locks WHERE owner_job_id = $1 RETURNING key)
       UPDATE jobs SET status = $3, run_at = COALESCE($4::timestamptz, run_at), last_error = $5,
         locked_by = NULL, locked_until = NULL, updated_at = $6::timestamptz
       WHERE id = $1 AND locked_by = $2 RETURNING id`,
      [jobId, workerId, retryAt === undefined ? 'dead' : 'queued', retryAt === undefined ? null : ts(retryAt), error.slice(0, MAX_ERROR_LENGTH), ts(now())],
    );
  },

  get: async (jobId) => {
    const [row] = await sql.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return row ? toJob(row) : undefined;
  },

  findByExecutionId: async (executionId) => {
    const [row] = await sql.query("SELECT * FROM jobs WHERE payload ->> 'executionId' = $1 ORDER BY seq LIMIT 1", [executionId]);
    return row ? toJob(row) : undefined;
  },

  counts: async () => {
    const rows = await sql.query('SELECT status, count(*)::int AS total FROM jobs GROUP BY status');
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, dead: 0 };
    for (const row of rows) {
      const status = STATUSES.find((candidate) => candidate === col.string(row, 'status'));
      if (status) counts[status] = col.number(row, 'total');
    }
    return counts;
  },
});
