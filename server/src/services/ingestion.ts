import { AppError } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { jobsProcessed, jobDuration } from '../lib/metrics.js';
import { claim, succeed, fail, enqueue, reapStalled, type Job } from '../lib/queue.js';
import { ingestLogin, reembedStale } from './corpus.js';
import { searchUsers } from './github.js';
import { query } from '../db/pool.js';

/**
 * Executes ingestion jobs. One function per job kind, plus the loop body that
 * claims, runs, and records the outcome.
 *
 * The important behaviour is what happens on failure. A 429 from GitHub is not
 * the job's fault and must not burn a retry attempt at full speed - the error
 * carries a retry hint and the job is rescheduled past the rate-limit reset. A
 * 404 is permanent: the handle does not exist, so retrying it three more times
 * only wastes quota, and the job is marked skipped immediately.
 */

async function runProfile(job: Job): Promise<unknown> {
  const result = await ingestLogin(job.target);
  return { developerId: result.id, login: result.login, created: result.created };
}

/**
 * Runs a GitHub user search and fans out one profile job per hit, rather than
 * fetching them inline. Keeping discovery and fetching as separate jobs means
 * a rate limit part-way through costs one retry, not the whole batch.
 */
async function runDiscover(job: Job): Promise<unknown> {
  const perPage = Number(job.payload?.perPage ?? 30);
  const hits = await searchUsers(job.target, Math.min(perPage, 100));

  let enqueued = 0;
  let deduped = 0;
  for (const hit of hits) {
    const { deduped: wasDeduped } = await enqueue({
      kind: 'profile',
      target: hit.login,
      orgId: job.org_id,
      requestedBy: job.requested_by,
      // Discovered profiles run behind directly-requested ones.
      priority: 7,
      payload: { discoveredBy: job.id },
    });
    if (wasDeduped) deduped++;
    else enqueued++;
  }

  return { found: hits.length, enqueued, deduped };
}

async function runEmbed(job: Job): Promise<unknown> {
  const batch = Number(job.payload?.batch ?? 100);
  const count = await reembedStale(batch);
  // More to do: chain another job rather than looping here, so the work stays
  // interruptible and every batch is separately retryable.
  if (count >= batch) {
    await enqueue({ kind: 'embed', target: `batch:${Date.now()}`, payload: { batch }, priority: 8 });
  }
  return { reembedded: count };
}

/** Refreshes the profiles most likely to be stale, oldest first. */
async function runRefresh(job: Job): Promise<unknown> {
  const limit = Number(job.payload?.limit ?? 25);
  const { rows } = await query<{ login: string }>(
    `SELECT login FROM developers
      WHERE is_synthetic = false
      ORDER BY fetched_at ASC NULLS FIRST
      LIMIT $1`,
    [limit],
    'ingest.find_stale',
  );

  let enqueued = 0;
  for (const row of rows) {
    const { deduped } = await enqueue({
      kind: 'profile',
      target: row.login,
      orgId: job.org_id,
      priority: 9, // lowest: never delay an interactive request
      payload: { refresh: true },
    });
    if (!deduped) enqueued++;
  }
  return { candidates: rows.length, enqueued };
}

const HANDLERS: Record<Job['kind'], (job: Job) => Promise<unknown>> = {
  profile: runProfile,
  discover: runDiscover,
  embed: runEmbed,
  refresh: runRefresh,
};

/** Runs one claimed job to completion. Never throws. */
export async function process(job: Job): Promise<'succeeded' | 'retry' | 'dead' | 'skipped'> {
  const stopTimer = jobDuration.startTimer({ kind: job.kind });
  try {
    const result = await HANDLERS[job.kind](job);
    await succeed(job.id, result);
    jobsProcessed.inc({ kind: job.kind, status: 'succeeded' });
    log().info({ jobId: job.id, kind: job.kind, target: job.target, result }, 'job succeeded');
    return 'succeeded';
  } catch (e) {
    const err = e as Error & { status?: number };

    // A missing GitHub account will never appear by retrying.
    if (err instanceof AppError && err.status === 404) {
      await query(
        `UPDATE ingest_jobs SET status = 'skipped', finished_at = now(), last_error = $2 WHERE id = $1`,
        [job.id, err.message],
        'ingest.skip',
      );
      jobsProcessed.inc({ kind: job.kind, status: 'skipped' });
      return 'skipped';
    }

    // Rate limited: wait out the window instead of spending a retry now.
    const retryAfterMs = err instanceof AppError && err.status === 429 ? 60_000 : undefined;
    const outcome = await fail(job, err, retryAfterMs);
    jobsProcessed.inc({ kind: job.kind, status: outcome === 'dead' ? 'dead' : 'failed' });
    log().warn(
      { jobId: job.id, kind: job.kind, target: job.target, err: err.message, outcome },
      'job failed',
    );
    return outcome;
  } finally {
    stopTimer();
  }
}

/**
 * Drains up to `max` jobs and returns.
 *
 * This is the shape a serverless platform needs: a cron request calls it, it
 * does bounded work inside the invocation budget, and it exits. The
 * long-running worker in worker.ts calls the same function in a loop.
 */
export async function drain(max = 25, budgetMs = 45_000): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  timedOut: boolean;
}> {
  const deadline = Date.now() + budgetMs;
  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  await reapStalled();

  while (processed < max) {
    // Stop before the platform kills the invocation mid-job, which would leave
    // a row claimed and waiting on the reaper.
    if (Date.now() > deadline) {
      return { processed, succeeded, failed, skipped, timedOut: true };
    }

    const job = await claim();
    if (!job) break;

    const outcome = await process(job);
    processed++;
    if (outcome === 'succeeded') succeeded++;
    else if (outcome === 'skipped') skipped++;
    else failed++;
  }

  return { processed, succeeded, failed, skipped, timedOut: false };
}
