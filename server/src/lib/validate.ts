import type { Request, Response, NextFunction } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from './errors.js';

/**
 * Request validation. Parsed output replaces the raw input, so handlers work
 * with typed, coerced values and never re-check a field. A failure returns 400
 * with per-field messages the web app renders next to the offending input.
 */
type Source = 'body' | 'query' | 'params';

export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const fields = result.error.issues.map((i) => ({
        field: i.path.join('.') || source,
        message: i.message,
      }));
      return next(badRequest(fields[0]?.message ?? 'Invalid request', { fields }));
    }
    // Express 5 makes req.query a getter; assign through a cast so both major
    // versions behave the same.
    (req as any)[source] = result.data;
    next();
  };
}

/** Comma-separated query parameter -> string[]. `?languages=Go,Rust` */
export const csv = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const parts = Array.isArray(v) ? v : v.split(',');
    const cleaned = parts.map((s) => s.trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  });

/** Query-string integer with bounds. Query values arrive as strings. */
export const intParam = (min: number, max: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
    .refine((v) => v === undefined || (Number.isFinite(v) && v >= min && v <= max), {
      message: `Must be a number between ${min} and ${max}`,
    });

export const boolParam = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return undefined;
    if (typeof v === 'boolean') return v;
    return v === 'true' || v === '1';
  });

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(320);

export const password = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200, 'That password is too long');

/** A GitHub login: 1-39 chars, alphanumeric or single hyphens. */
export const githubLogin = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/, 'Not a valid GitHub username');

export const uuid = z.string().uuid('Not a valid id');

export const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Use 3-40 lowercase letters, numbers or hyphens');

export { z };
