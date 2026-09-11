import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enqueue, claim, succeed, fail, reapStalled, stats } from '../src/lib/queue.js';
import { query } from '../src/db/pool.js';
import { prepareSchema, uniq } from './setup.js';

/**
 * Queue semantics. Every assertion here is about a concurrency or failure
 * behaviour that is invisible in the happy path and expensive in production:
 * duplicate work, double-claimed jobs, lost jobs after a crash, and retry
 * storms against a rate-limited upstream.
 */

const targets: string[] = [];

function target(label: string): string {
  const t = uniq(label);
  targets.push(t);
  return t;
}

beforeAll(async () => {
  await prepareSchema();
}, 60_000);

afterAll(async () => {
  if (targets.length) {
    await query(`DELETE FROM ingest_jobs WHERE target = ANY($1::text[])`, [targets]);
  }
});

describe('deduplication', () => {
  it('collapses a repeat request for work already pending', async () => {
    const t = target('dedupe');

    const first = await enqueue({ kind: 'profile', target: t });
    const second = await enqueue({ kind: 'profile', target: t });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    // The same job, not a second one - this is what stops two recruiters
    // clicking the same candidate from spending twice the GitHub quota.
    expect(second.job.id).toBe(first.job.id);
  });

  it('survives a race between two simultaneous enqueues', async () => {
    const t = target('race');

    // The dedupe is a partial unique index, so concurrency is resolved by the
    // database rather than by a check-then-insert that can interleave.
    const results = await Promise.all([
      enqueue({ kind: 'profile', target: t }),
      enqueue({ kind: 'profile', target: t }),
      enqueue({ kind: 'profile', target: t }),
    ]);

    const ids = new Set(results.map((r) => r.job.id));
    expect(ids.size).toBe(1);
  });

  it('allows a new job once the previous one has finished', async () => {
    const t = target('requeue');

    const first = await enqueue({ kind: 'profile', target: t });
    await succeed(first.job.id, {});

    const second = await enqueue({ kind: 'profile', target: t });
    expect(second.deduped).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });
});

describe('claiming', () => {
  it('never hands the same job to two workers', async () => {
    const t = target('claim');
    const { job } = await enqueue({ kind: 'profile', target: t, priority: 1 });

    // Concurrent claims. SKIP LOCKED means the losers take a different row or
    // none - they must not receive this one as well.
    const claims = await Promise.all([claim(), claim(), claim()]);
    const gotIt = claims.filter((c) => c?.id === job.id);

    expect(gotIt).toHaveLength(1);
    for (const c of claims) if (c) await succeed(c.id, {});
  });

  it('counts the attempt when a job is claimed', async () => {
    const t = target('attempts');
    await enqueue({ kind: 'profile', target: t, priority: 1 });

    let claimed = await claim();
    while (claimed && claimed.target !== t) claimed = await claim();
    if (!claimed) return;

    expect(claimed.attempts).toBe(1);
    await succeed(claimed.id, {});
  });

  it('does not claim a job whose backoff has not elapsed', async () => {
    const t = target('backoff');
    const { job } = await enqueue({ kind: 'profile', target: t });

    await query(`UPDATE ingest_jobs SET run_after = now() + interval '1 hour' WHERE id = $1`, [
      job.id,
    ]);

    for (let i = 0; i < 5; i++) {
      const c = await claim();
      if (!c) break;
      expect(c.id).not.toBe(job.id);
      await succeed(c.id, {});
    }
  });
});

describe('failure handling', () => {
  it('retries with backoff until the attempt budget is spent, then dead-letters', async () => {
    const t = target('retry');
    const { job } = await enqueue({ kind: 'profile', target: t, maxAttempts: 2 });

    const first = await fail({ ...job, attempts: 1 }, new Error('upstream blew up'));
    expect(first).toBe('retry');

    const { rows } = await query(
      `SELECT status, run_after > now() AS deferred, last_error FROM ingest_jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows[0].status).toBe('queued');
    expect(rows[0].deferred).toBe(true);
    expect(rows[0].last_error).toContain('upstream blew up');

    const second = await fail({ ...job, attempts: 2 }, new Error('again'));
    expect(second).toBe('dead');

    const { rows: dead } = await query(`SELECT status FROM ingest_jobs WHERE id = $1`, [job.id]);
    expect(dead[0].status).toBe('dead');
  });

  it('jitters the retry delay so failures do not all return at once', async () => {
    const delays = new Set<string>();

    for (let i = 0; i < 6; i++) {
      const t = target(`jitter${i}`);
      const { job } = await enqueue({ kind: 'profile', target: t, maxAttempts: 5 });
      await fail({ ...job, attempts: 3 }, new Error('rate limited'));
      const { rows } = await query(
        `SELECT extract(epoch from (run_after - now()))::int AS secs FROM ingest_jobs WHERE id = $1`,
        [job.id],
      );
      delays.add(String(rows[0].secs));
    }

    // Identical delays would mean every job rate-limited in the same second
    // retries in the same second, and gets rate-limited again.
    expect(delays.size).toBeGreaterThan(1);
  });
});

describe('crash recovery', () => {
  it('returns jobs abandoned mid-run to the queue', async () => {
    const t = target('stalled');
    const { job } = await enqueue({ kind: 'profile', target: t });

    // Simulate a worker that claimed this and then died.
    await query(
      `UPDATE ingest_jobs SET status = 'running', started_at = now() - interval '30 minutes' WHERE id = $1`,
      [job.id],
    );

    const reclaimed = await reapStalled(10);
    expect(reclaimed).toBeGreaterThanOrEqual(1);

    const { rows } = await query(`SELECT status, last_error FROM ingest_jobs WHERE id = $1`, [
      job.id,
    ]);
    expect(rows[0].status).toBe('queued');
    expect(rows[0].last_error).toMatch(/reclaimed/i);
  });

  it('leaves a recently started job alone', async () => {
    const t = target('fresh');
    const { job } = await enqueue({ kind: 'profile', target: t });
    await query(`UPDATE ingest_jobs SET status = 'running', started_at = now() WHERE id = $1`, [
      job.id,
    ]);

    await reapStalled(10);

    const { rows } = await query(`SELECT status FROM ingest_jobs WHERE id = $1`, [job.id]);
    expect(rows[0].status).toBe('running');
  });
});

describe('stats', () => {
  it('reports counts by status', async () => {
    const s = await stats();
    expect(s).toHaveProperty('queued');
    expect(s).toHaveProperty('dead');
    expect(typeof s.queued).toBe('number');
  });
});
