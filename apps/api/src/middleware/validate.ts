import type { Request } from 'express';
import type { ZodType, z } from 'zod';
import { validationError } from '../lib/errors.js';
import { objectIdSchema } from '@nexus/shared';

/** Parse and validate the JSON body. Throws a 422 with field details on failure. */
export function parseBody<S extends ZodType>(schema: S, req: Request): z.output<S> {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) throw validationError(r.error);
  return r.data;
}

/** Parse the query string. Express 5 makes req.query read-only, so we return the parsed copy. */
export function parseQuery<S extends ZodType>(schema: S, req: Request): z.output<S> {
  const r = schema.safeParse(req.query ?? {});
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function parseId(req: Request, name = 'id'): string {
  const r = objectIdSchema.safeParse(req.params[name]);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

/**
 * For PATCH requests: keep only keys the client actually sent. Prevents schema
 * defaults (e.g. status: "draft") from silently overwriting stored values.
 */
export function onlySentKeys<T extends Record<string, unknown>>(
  parsed: T,
  raw: unknown,
): Partial<T> {
  if (!raw || typeof raw !== 'object') return {};
  const sent = new Set(Object.keys(raw));
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => sent.has(k))) as Partial<T>;
}
