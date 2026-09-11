import pino from 'pino';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

/**
 * Request-scoped context. Every log line, metric label and audit row can reach
 * the current request id / actor without threading them through call
 * signatures, which is what makes a trace readable end to end.
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  orgId?: string;
  route?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const ctx = () => storage.getStore();

export const baseLogger = pino({
  level: env.LOG_LEVEL,
  // Pretty output is a dev-only nicety; production emits newline-delimited JSON
  // so a log shipper can parse it without a transform.
  ...(env.isProd
    ? {}
    : {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }),
  base: { service: 'devscout-api' },
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'password',
      '*.password',
      '*.password_hash',
      'token',
      '*.token',
    ],
    censor: '[redacted]',
  },
  formatters: { level: (label) => ({ level: label }) },
});

/** Logger that automatically carries the current request context. */
export function log() {
  const c = ctx();
  return c ? baseLogger.child(c) : baseLogger;
}

/** Establishes the async context and echoes a correlatable request id back. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  res.setHeader('x-request-id', requestId);
  storage.run({ requestId }, () => next());
}

/** Attach identity to the live context once auth has resolved it. */
export function enrichContext(patch: Partial<RequestContext>) {
  const c = storage.getStore();
  if (c) Object.assign(c, patch);
}
