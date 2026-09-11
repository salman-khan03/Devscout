import type { Request, Response, NextFunction } from 'express';
import { store } from './redis.js';
import { tooMany } from './errors.js';
import type { AuthedRequest } from './auth.js';

/**
 * Sliding-window rate limiter backed by the shared Store, so all replicas
 * enforce one budget when Redis is configured.
 *
 * The window is keyed by org where we know it and by IP otherwise. Keying
 * expensive endpoints by org matters: one tenant hammering search must not
 * consume another tenant's allowance, and a whole office behind one NAT IP
 * must not be limited as a single caller.
 */
export interface LimitOptions {
  name: string;
  windowSeconds: number;
  max: number;
  /** Prefer the tenant as the subject; falls back to IP for anonymous routes. */
  by?: 'ip' | 'org' | 'user';
}

export function rateLimit(opts: LimitOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const a = req as AuthedRequest;
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const subject =
        opts.by === 'org' ? a.org?.id ?? ip : opts.by === 'user' ? a.user?.id ?? ip : ip;

      const count = await store.hitWindow(`rl:${opts.name}:${subject}`, opts.windowSeconds);

      const remaining = Math.max(0, opts.max - count);
      res.setHeader('RateLimit-Limit', opts.max);
      res.setHeader('RateLimit-Remaining', remaining);
      res.setHeader('RateLimit-Policy', `${opts.max};w=${opts.windowSeconds}`);

      if (count > opts.max) {
        res.setHeader('Retry-After', opts.windowSeconds);
        return next(tooMany(`Rate limit exceeded. Try again in ${opts.windowSeconds}s.`));
      }
      next();
    } catch {
      // A limiter that cannot reach its backend fails open. Losing the limit is
      // recoverable; refusing every request because Redis blipped is not.
      next();
    }
  };
}
