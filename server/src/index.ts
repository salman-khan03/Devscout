import { env } from './config/env.js';
import { createApp, bootstrap } from './app.js';
import { baseLogger } from './lib/logger.js';
import { pool } from './db/pool.js';
import { store } from './lib/redis.js';

/**
 * Local / container entry point. Runs migrations on boot, which is right for a
 * single long-lived process. The serverless entry point (api/index.ts) does
 * not, because dozens of cold starts should not race to migrate.
 */
async function main() {
  await bootstrap({ migrate: true });

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    baseLogger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        redis: store.kind,
        embeddings: env.EMBEDDING_PROVIDER,
        features: env.features,
      },
      `DevScout API listening on http://localhost:${env.PORT}`,
    );
  });

  // Finish in-flight requests before exiting, so a deploy does not sever a
  // response mid-write.
  const shutdown = async (signal: string) => {
    baseLogger.info({ signal }, 'shutting down');
    server.close(async () => {
      await pool.end().catch(() => undefined);
      await store.close().catch(() => undefined);
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 15_000).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  baseLogger.error({ err: e.message, stack: e.stack }, 'failed to start');
  process.exit(1);
});
