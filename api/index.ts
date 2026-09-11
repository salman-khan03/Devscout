import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../server/src/app.js';
import { assertTenantIsolation } from '../server/src/db/verify.js';
import { baseLogger } from '../server/src/lib/logger.js';

/**
 * Vercel serverless entry point.
 *
 * Vercel gives each function a Node request/response pair, and an Express app
 * IS a (req, res) handler, so the whole API runs unchanged behind one
 * function - no per-route rewriting, and the same code path the tests and the
 * local server exercise.
 *
 * Two things differ from the long-running server on purpose:
 *
 *   1. The app is built once per container and reused across invocations.
 *      Rebuilding it per request would re-create the connection pool every
 *      time and exhaust Postgres connections under any real traffic.
 *   2. Migrations do NOT run here. Many cold starts can happen at once, and
 *      while the advisory lock in the migrator makes that safe, it would make
 *      every one of them wait. Migrations run in the deploy step instead
 *      (`npm run migrate`), which is where schema changes belong.
 */
const app = createApp();

// Verify tenant isolation once per container, not per request.
let verified = false;
const verifyOnce = async () => {
  if (verified) return;
  verified = true;
  await assertTenantIsolation().catch((e) => {
    baseLogger.error({ err: e.message }, 'tenant isolation check failed on cold start');
    // In production assertTenantIsolation throws, which surfaces as a 500 on
    // the first request rather than silently serving unisolated data.
    throw e;
  });
};

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  await verifyOnce();
  return app(req as never, res as never);
}
