import { Router } from 'express';
import { handler, AppError } from '../lib/errors.js';
import { env } from '../config/env.js';
import { healthy } from '../db/pool.js';
import { store } from '../lib/redis.js';
import { registry } from '../lib/metrics.js';
import { verifyTenantIsolation, verifyVectorSupport } from '../db/verify.js';
import { drain } from '../services/ingestion.js';
import { enqueue, stats, reapStalled } from '../lib/queue.js';
import { log } from '../lib/logger.js';

export const system = Router();

const startedAt = Date.now();

/**
 * Liveness. Answers "is this process running" and nothing else, so a load
 * balancer does not recycle a healthy instance because a dependency blipped.
 */
system.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'devscout-api',
    version: '2.0.0',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
});

/**
 * Readiness. Answers "can this instance serve traffic", which is a different
 * question: it checks the dependencies a request actually needs and returns
 * 503 when one is missing, so a deploy does not shift traffic onto an instance
 * that cannot reach its database.
 */
system.get(
  '/health/ready',
  handler(async (_req, res) => {
    const [db, redis, vector, isolation] = await Promise.all([
      healthy(),
      store.ping(),
      verifyVectorSupport(),
      verifyTenantIsolation(),
    ]);

    const checks = {
      database: { ok: db },
      redis: { ok: redis, backend: store.kind },
      pgvector: vector,
      tenantIsolation: { ok: isolation.enforced, detail: isolation.detail },
    };

    // The memory store is a documented single-instance fallback, not a
    // failure, so it does not fail readiness on its own.
    const ready = db && vector.ok && isolation.enforced;

    res.status(ready ? 200 : 503).json({
      ready,
      checks,
      features: env.features,
      embeddingProvider: env.EMBEDDING_PROVIDER,
    });
  }),
);

/** Prometheus scrape endpoint. */
system.get(
  '/metrics',
  handler(async (_req, res) => {
    // Refresh gauges that are only accurate when read.
    await stats().catch(() => undefined);
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }),
);

/**
 * Cron endpoints.
 *
 * On a platform with no long-running process (Vercel), a scheduler calls these
 * to do what the worker would otherwise do continuously. They call exactly the
 * same handlers as the worker, so there is one implementation of the work and
 * two ways to schedule it.
 *
 * Authentication is a shared secret compared in constant time. Vercel Cron
 * sends it as a bearer token; anything else can send the header directly.
 */
function authorizeCron(req: { headers: Record<string, unknown> }): void {
  if (!env.CRON_SECRET) {
    throw new AppError(503, 'CRON_SECRET is not configured, so cron endpoints are disabled.');
  }

  const header = String(req.headers.authorization ?? '');
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : String(req.headers['x-cron-secret'] ?? '');

  // Length-independent comparison, so a failure does not leak the secret's
  // length through timing.
  const expected = env.CRON_SECRET;
  let mismatch = provided.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.max(provided.length, expected.length); i++) {
    mismatch |= (provided.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  if (mismatch !== 0) throw new AppError(401, 'Invalid cron secret.');
}

const cronHandler = (fn: () => Promise<unknown>) =>
  handler(async (req, res) => {
    authorizeCron(req as any);
    const started = Date.now();
    const result = await fn();
    log().info({ result, ms: Date.now() - started }, 'cron run complete');
    res.json({ ok: true, tookMs: Date.now() - started, result });
  });

/** Drains the ingestion queue within the invocation budget. */
system.all('/cron/drain', cronHandler(async () => {
  await reapStalled();
  // 45s of work inside a 60s function limit leaves room to return cleanly.
  return drain(25, 45_000);
}));

/** Queues a daily refresh of the least recently fetched profiles. */
system.all('/cron/refresh', cronHandler(async () => {
  const { job } = await enqueue({
    kind: 'refresh',
    target: `daily:${new Date().toISOString().slice(0, 10)}`,
    priority: 9,
    payload: { limit: 50 },
  });
  return { jobId: job.id };
}));
