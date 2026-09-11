import { bootstrap } from './app.js';
import { env } from './config/env.js';
import { baseLogger } from './lib/logger.js';
import { claim, reapStalled, stats, waitForWake } from './lib/queue.js';
import { process as runJob } from './services/ingestion.js';
import { pool } from './db/pool.js';
import { store } from './lib/redis.js';

/**
 * Long-running ingestion worker.
 *
 * Run this on any platform that keeps a process alive (Railway, Fly, Render, a
 * container). On Vercel, where there is no long-lived process, the same work
 * is driven by POST /api/cron/drain instead - both call into the same handlers
 * in services/ingestion.ts, so there is one implementation and two schedulers.
 *
 * Concurrency is N independent loops rather than a batch-and-await, so one slow
 * GitHub call cannot stall the other workers.
 */

let shuttingDown = false;
const inFlight = new Set<Promise<unknown>>();

async function loop(id: number): Promise<void> {
  const logger = baseLogger.child({ worker: id });

  while (!shuttingDown) {
    try {
      const job = await claim();

      if (!job) {
        // Idle: wait for a wake-up signal, falling back to a poll interval.
        await waitForWake(2000);
        continue;
      }

      const task = runJob(job);
      inFlight.add(task);
      try {
        await task;
      } finally {
        inFlight.delete(task);
      }
    } catch (e) {
      // The loop itself must survive anything - a database blip should pause
      // the worker, not terminate it.
      logger.error({ err: (e as Error).message }, 'worker loop error');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  logger.info('worker loop stopped');
}

/** Periodically returns jobs abandoned by a crashed worker. */
async function reaper(): Promise<void> {
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, 60_000));
    if (shuttingDown) break;
    await reapStalled().catch((e) => baseLogger.warn({ err: e.message }, 'reaper failed'));
    await stats().catch(() => undefined); // refreshes the queue-depth gauge
  }
}

/**
 * Finishes the job in hand before exiting. A hard kill would leave the row
 * claimed until the reaper notices, delaying that work by minutes.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  baseLogger.info({ signal, inFlight: inFlight.size }, 'worker shutting down');

  const timeout = new Promise((r) => setTimeout(r, 20_000));
  await Promise.race([Promise.allSettled([...inFlight]), timeout]);

  await pool.end().catch(() => undefined);
  await store.close().catch(() => undefined);
  baseLogger.info('worker stopped cleanly');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await bootstrap({ migrate: true });

const concurrency = env.WORKER_CONCURRENCY;
baseLogger.info(
  { concurrency, redis: store.kind, github: env.features.github ? 'token' : 'anonymous' },
  'ingestion worker started',
);

void reaper();
await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i + 1)));
