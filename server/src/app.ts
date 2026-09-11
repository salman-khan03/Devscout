import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { AppError } from './lib/errors.js';
import { requestContext, log, baseLogger } from './lib/logger.js';
import { httpMetrics } from './lib/metrics.js';
import { rateLimit } from './lib/ratelimit.js';

import { auth } from './routes/auth.js';
import { orgs } from './routes/orgs.js';
import { searchRoutes } from './routes/search.js';
import { candidates } from './routes/candidates.js';
import { lists } from './routes/lists.js';
import { savedSearches } from './routes/savedSearches.js';
import { analytics } from './routes/analytics.js';
import { ingest } from './routes/ingest.js';
import { billing } from './routes/billing.js';
import { exportRoutes } from './routes/exportRoutes.js';
import { system } from './routes/system.js';

/**
 * Builds the Express application.
 *
 * Exported as a factory with no side effects so the same app can be driven by
 * three callers: the local HTTP server, the Vercel serverless handler, and
 * supertest in the test suite. Anything that must happen once at boot
 * (migrations, the isolation check) belongs in the caller, not here - a
 * serverless function may construct this on every cold start.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  // Required for req.ip to be the client rather than the proxy, which the
  // rate limiter keys on.
  app.set('trust proxy', 1);

  app.use(requestContext);
  app.use(httpMetrics);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // GitHub avatars, and the identicon service the synthetic demo
          // corpus uses for its placeholder images.
          imgSrc: ["'self'", 'data:', 'https://avatars.githubusercontent.com', 'https://api.dicebear.com'],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'", env.WEB_ORIGIN],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // The API is JSON; HSTS is set by the platform edge in production.
      hsts: env.isProd ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server requests arrive without an Origin.
        if (!origin) return callback(null, true);
        const allowed = [env.WEB_ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173'];
        // Vercel preview deployments get a generated subdomain per commit, so
        // an exact list cannot cover them.
        const isPreview = /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
        if (allowed.includes(origin) || (env.isProd && isPreview)) return callback(null, true);
        callback(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true, // the session cookie must travel
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'x-devscout-org', 'x-request-id'],
      exposedHeaders: ['x-request-id', 'RateLimit-Remaining', 'RateLimit-Limit'],
      maxAge: 86_400,
    }),
  );

  app.use(cookieParser());

  /*
   * The Stripe webhook verifies a signature over the exact bytes Stripe sent,
   * so it must not be JSON-parsed. Skipping the global parser for that one
   * path is what lets express.raw() inside the billing router see the buffer.
   */
  app.use((req, res, next) => {
    if (req.path === '/api/billing/webhook') return next();
    express.json({ limit: '512kb' })(req, res, next);
  });

  // A broad ceiling. Per-route limits in the routers are the meaningful ones.
  app.use('/api', rateLimit({ name: 'global', windowSeconds: 60, max: 600 }));

  // ---- routes -------------------------------------------------------------
  app.use('/api', system);
  app.use('/api/auth', auth);
  app.use('/api/orgs', orgs);
  app.use('/api/search', searchRoutes);
  app.use('/api/candidates', candidates);
  app.use('/api/lists', lists);
  app.use('/api/saved-searches', savedSearches);
  app.use('/api/analytics', analytics);
  app.use('/api/ingest', ingest);
  app.use('/api/billing', billing);
  app.use('/api/export', exportRoutes);

  // Prometheus conventionally scrapes /metrics, not /api/metrics.
  app.use('/', system);

  app.use((req, res) => {
    res.status(404).json({ error: `No route for ${req.method} ${req.path}`, code: 'not_found' });
  });

  /**
   * Central error handler.
   *
   * AppError carries a status and a message written for a user. Anything else
   * is unexpected: it is logged in full with the request id, and the client
   * gets a generic message, because internal error text leaks schema and stack
   * details. The request id is the bridge between the two.
   */
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      if (err.status >= 500) log().error({ err: err.message, status: err.status }, 'app error');
      return res.status(err.status).json({
        error: err.message,
        code: err.code ?? 'error',
        ...(err.details ? { details: err.details } : {}),
      });
    }

    if (err instanceof Error && /not allowed/.test(err.message) && /Origin/.test(err.message)) {
      return res.status(403).json({ error: 'Origin not allowed', code: 'cors_denied' });
    }

    log().error(
      { err: err instanceof Error ? err.message : String(err), stack: (err as Error)?.stack },
      'unhandled error',
    );
    res.status(500).json({
      error: 'Something went wrong on our side.',
      code: 'internal_error',
      requestId: res.getHeader('x-request-id'),
    });
  });

  return app;
}

/** Boot-time checks shared by every entry point. */
export async function bootstrap(opts: { migrate: boolean }): Promise<void> {
  if (opts.migrate) {
    const { migrate } = await import('./db/migrate.js');
    const { applied, skipped } = await migrate();
    baseLogger.info({ applied: applied.length, skipped }, 'schema ready');
  }

  const { assertTenantIsolation } = await import('./db/verify.js');
  await assertTenantIsolation();
}
