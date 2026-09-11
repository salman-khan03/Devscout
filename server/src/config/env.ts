import 'dotenv/config';
import { z } from 'zod';

/**
 * Every environment variable the server reads, parsed and validated once at
 * boot. Two rules hold everywhere below:
 *
 *  1. If a variable is missing the process must either fail loudly (because
 *     nothing works without it) or degrade to a documented local fallback.
 *     There is no third category - nothing silently half-works.
 *  2. Nothing else in the codebase touches `process.env`, so the set of
 *     external dependencies is exactly this file.
 */
const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : v === 'true' || v === '1'));

const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number(v)))
    .pipe(z.number().int().positive());

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required - see .env.example'),
  /** Unpooled connection used only for migrations - see db/migrate.ts. */
  DIRECT_DATABASE_URL: optional,
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  REDIS_URL: optional,
  GITHUB_TOKEN: optional,

  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  OPENAI_API_KEY: optional,

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  OPENROUTER_API_KEY: optional,
  LLM_MODEL: z.string().default('anthropic/claude-3.5-haiku'),

  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_TEAM: optional,
  STRIPE_PRICE_SCALE: optional,
  TRIAL_DAYS: int(14),

  CRON_SECRET: optional,
  WORKER_CONCURRENCY: int(4),
  DEMO_MODE: bool(true),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // Fail at boot rather than at the first request that needs the value.
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;

  // An OpenAI embedding provider without a key would silently produce vectors
  // from a different model than the ones already indexed. Refuse instead.
  if (e.EMBEDDING_PROVIDER === 'openai' && !e.OPENAI_API_KEY) {
    throw new Error('EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY');
  }

  return {
    ...e,
    isProd: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    /** Feature flags derived from which optional credentials are present. */
    features: {
      redis: Boolean(e.REDIS_URL),
      github: Boolean(e.GITHUB_TOKEN),
      llm: Boolean(e.GEMINI_API_KEY || e.OPENROUTER_API_KEY),
      billing: Boolean(e.STRIPE_SECRET_KEY),
      remoteEmbeddings: e.EMBEDDING_PROVIDER === 'openai',
    },
  };
}

export const env = load();
export type Env = typeof env;
