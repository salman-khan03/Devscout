import type { Request, Response, NextFunction, RequestHandler } from 'express';

/** An error that is safe to show a user, carrying the status to answer with. */
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Sign in to continue') => new AppError(401, m, 'unauthorized');
export const forbidden = (m = 'You do not have access to that') => new AppError(403, m, 'forbidden');
export const notFound = (m = 'Not found') => new AppError(404, m, 'not_found');
export const conflict = (m: string) => new AppError(409, m, 'conflict');
/** 402 is the plan-limit signal the web app listens for to show an upgrade path. */
export const paymentRequired = (m: string, d?: unknown) => new AppError(402, m, 'plan_limit', d);
export const tooMany = (m = 'Too many requests') => new AppError(429, m, 'rate_limited');
export const upstream = (m: string) => new AppError(502, m, 'upstream_error');

/** Wraps async handlers so a rejected promise reaches the error middleware. */
export const handler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
