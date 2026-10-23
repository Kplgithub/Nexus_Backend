import type { NextFunction, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { corsOrigins, isTest } from '../config/env.js';
import { AppError, forbidden } from '../lib/errors.js';

/**
 * Removes keys starting with "$" or containing "." from JSON bodies so user input
 * can never become a MongoDB operator (NoSQL injection). Query strings are always
 * parsed through Zod schemas that only output primitive values.
 */
export function sanitizeBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body && typeof req.body === 'object') req.body = strip(req.body, 0);
  next();
}

function strip(value: unknown, depth: number): unknown {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor')
        continue;
      out[k] = strip(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Rejects cross-site state-changing requests whose Origin isn't one of ours. */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !corsOrigins.includes(origin)) throw forbidden('Request origin not allowed');
  next();
}

const tooMany = (message: string) => (_req: Request, _res: Response, next: NextFunction) => {
  next(new AppError(429, 'RATE_LIMITED', message));
};

const make = (windowMs: number, limit: number, message: string) =>
  rateLimit({
    windowMs,
    limit: isTest ? 10_000 : limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? 'unknown'),
    handler: tooMany(message),
  });

export const limiters = {
  global: make(60_000, 300, 'Too many requests. Please slow down.'),
  login: make(15 * 60_000, 10, 'Too many sign-in attempts. Try again in 15 minutes.'),
  publicForm: make(
    60 * 60_000,
    10,
    'Too many submissions from this network. Please call us instead.',
  ),
  upload: make(60_000, 40, 'Too many uploads. Please wait a minute.'),
  userLogin: make(15 * 60_000, 20, 'Too many sign-in attempts. Try again in 15 minutes.'),
  signup: make(60 * 60_000, 10, 'Too many sign-ups from this network. Try again later.'),
  otp: make(15 * 60_000, 10, 'Too many code requests. Try again in 15 minutes.'),
  userWrite: make(60_000, 60, 'Too many requests. Please slow down.'),
};
