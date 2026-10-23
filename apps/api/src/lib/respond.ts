import type { Response } from 'express';
import type { PaginationMeta } from '@nexus/shared';

export function ok<T>(res: Response, data: T, meta?: PaginationMeta, status = 200) {
  return res.status(status).json(meta ? { ok: true, data, meta } : { ok: true, data });
}

export function created<T>(res: Response, data: T) {
  return ok(res, data, undefined, 201);
}

export function paginate(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

/** Escape user text before using it inside a RegExp. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
