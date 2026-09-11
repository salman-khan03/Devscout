import { query } from '../db/pool.js';
import { store } from './redis.js';
import { queueDepth } from './metrics.js';
import { log } from './logger.js';

/**
 * Durable job queue for GitHub ingestion.
 *
 * Job state lives in Postgres and workers claim rows with
 * `FOR UPDATE SKIP LOCKED`, which is what makes concurrent workers safe: the
 * claim is atomic, a locked row is skipped rather than waited on, and a worker
 * that dies mid-job leaves a row that the reaper can return to the queue. A
 * Redis list alone would lose in-flight jobs on a crash, and Redis is optional
 * here anyway.
 *
 * Redis, when configured, carries a wake-up signal so a freshly enqueued job
 * starts in milliseconds instead of waiting out the poll interval. It is a
 * latency optimisation, never the source of truth - drop Redis entirely and
 * the queue still works, just with up to POLL_MS of extra latency.
 */

export type JobKind = 'profile' | 'discover' | 'embed' | 'refresh';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead' | 'skipped';

export interface Job {
  id: string;
  org_id: string | null;
  requested_by: string | null;
  kind: JobKind;
  target: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
}

export interface EnqueueInput {
  kind: JobKind;
  target: string;
  orgId?: string | null;
  requestedBy?: string | null;
  payload?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
}

const WAKE_KEY = 'queue:ingest:wake';

/**
 * Adds a job unless an identical one is already queued or running.
 *
 * The deduplication is enforced by a partial unique index on
 * (kind, target) WHERE status IN ('queued','running'), so two requests racing
 * to scan the same developer cannot both win - the loser gets the existing
 * job back. Doing this in the database rather than with a SELECT-then-INSERT
 * is what makes it correct under concurrency.
 */
export async function enqueue(input: EnqueueInput): Promise<{ job: Job; deduped: boolean }> {
  const { rows } = await query<Job>(
    `INSERT INTO ingest_jobs (org_id, requested_by, kind, target, payload, priority, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (kind, target) WHERE status IN ('queued','running') DO NOTHING
     RETURNING *`,
    [
      input.orgId ?? null,
      input.requestedBy ?? null,
      input.kind,
      input.target,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 5,
      input.maxAttempts ?? 4,
    ],
    'queue.enqueue',
  );

  if (rows.length) {
    await store.push(WAKE_KEY, rows[0].id).catch(() => undefined);
    return { job: rows[0], deduped: false };
  }

  // Lost the race, or one was already pending. Return the live job.
  const { rows: existing } = await query<Job>(
    `SELECT * FROM ingest_jobs
      WHERE kind = $1 AND target = $2 AND status IN ('queued','running')
      LIMIT 1`,
    [input.kind, input.target],
    'queue.enqueue_dedupe',
  );

  if (existing.length) return { job: existing[0], deduped: true };

  // The conflicting job finished between the two statements. Insert again.
  const { rows: retry } = await query<Job>(
    `INSERT INTO ingest_jobs (org_id, requested_by, kind, target, payload, priority, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      input.orgId ?? null,
      input.requestedBy ?? null,
      input.kind,
      input.target,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 5,
      input.maxAttempts ?? 4,
    ],
    'queue.enqueue_retry',
  );
  await store.push(WAKE_KEY, retry[0].id).catch(() => undefined);
  return { job: retry[0], deduped: false };
}

/**
 * Atomically claims the next runnable job.
 *
 * SKIP LOCKED is the whole trick: each worker takes a different row without
 * blocking on the others, so throughput scales with worker count instead of
 * serialising on a single hot row.
 */
export async function claim(): Promise<Job | null> {
  const { rows } = await query<Job>(
    `UPDATE ingest_jobs SET status = 'running', started_at = now(), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM ingest_jobs
         WHERE status = 'queued' AND run_after <= now()
         ORDER BY priority ASC, run_after ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [],
    'queue.claim',
  );
  return rows[0] ?? null;
}

export async function succeed(jobId: string, result: unknown): Promise<void> {
  await query(
    `UPDATE ingest_jobs
        SET status = 'succeeded', finished_at = now(), result = $2, last_error = NULL
      WHERE id = $1`,
    [jobId, JSON.stringify(result ?? {})],
    'queue.succeed',
  );
}

/**
 * Records a failure and decides whether to retry.
 *
 * Backoff is exponential with jitter. The jitter matters more than it looks:
 * when GitHub rate-limits us, every in-flight job fails at once, and without
 * jitter they would all retry at the same instant and be rate-limited again.
 */
export async function fail(job: Job, error: Error, retryAfterMs?: number): Promise<'retry' | 'dead'> {
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    await query(
      `UPDATE ingest_jobs SET status = 'dead', finished_at = now(), last_error = $2 WHERE id = $1`,
      [job.id, error.message.slice(0, 1000)],
      'queue.dead',
    );
    log().error({ jobId: job.id, kind: job.kind, target: job.target }, 'job dead-lettered');
    return 'dead';
  }

  const base = retryAfterMs ?? Math.min(2 ** job.attempts * 1000, 5 * 60_000);
  const delay = Math.round(base * (0.75 + Math.random() * 0.5));

  await query(
    `UPDATE ingest_jobs
        SET status = 'queued', last_error = $2, run_after = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [job.id, error.message.slice(0, 1000), delay / 1000],
    'queue.retry',
  );
  return 'retry';
}

/**
 * Returns jobs stuck in 'running' to the queue.
 *
 * A worker killed mid-job (a deploy, an OOM, a serverless timeout) leaves its
 * row claimed forever. Without this the job is silently lost, which is the
 * kind of failure nobody notices until a customer asks why their import never
 * finished.
 */
export async function reapStalled(olderThanMinutes = 10): Promise<number> {
  const { rowCount } = await query(
    `UPDATE ingest_jobs
        SET status = 'queued', last_error = 'reclaimed after worker timeout'
      WHERE status = 'running' AND started_at < now() - make_interval(mins => $1)`,
    [olderThanMinutes],
    'queue.reap',
  );
  if (rowCount) log().warn({ reclaimed: rowCount }, 'reclaimed stalled jobs');
  return rowCount ?? 0;
}

/** Blocks briefly for a wake-up signal, so new jobs do not wait out the poll. */
export async function waitForWake(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const signal = await store.pop(WAKE_KEY).catch(() => null);
    if (signal) return;
    await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
  }
}

export interface QueueStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  oldestQueuedSeconds: number | null;
}

export async function stats(orgId?: string | null): Promise<QueueStats> {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::int    AS queued,
       count(*) FILTER (WHERE status = 'running')::int   AS running,
       count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
       count(*) FILTER (WHERE status = 'failed')::int    AS failed,
       count(*) FILTER (WHERE status = 'dead')::int      AS dead,
       EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status = 'queued')))::int
         AS oldest_queued_seconds
     FROM ingest_jobs
     WHERE ($1::uuid IS NULL OR org_id = $1)`,
    [orgId ?? null],
    'queue.stats',
  );

  const r = rows[0];
  queueDepth.set({ queue: 'ingest' }, r.queued ?? 0);
  return {
    queued: r.queued ?? 0,
    running: r.running ?? 0,
    succeeded: r.succeeded ?? 0,
    failed: r.failed ?? 0,
    dead: r.dead ?? 0,
    oldestQueuedSeconds: r.oldest_queued_seconds ?? null,
  };
}
