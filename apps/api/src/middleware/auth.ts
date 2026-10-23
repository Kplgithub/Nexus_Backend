import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { AdminRole } from '@nexus/shared';
import { env, isProd } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { safeEqual, randomToken } from '../lib/crypto.js';
import { Admin } from '../models/misc.models.js';

export const SESSION_COOKIE = 'nexus_session';
export const CSRF_COOKIE = 'nexus_csrf';
export const CSRF_HEADER = 'x-csrf-token';

type SessionClaims = { sub: string; tv: number; role: AdminRole; csrf: string };

export type AuthedAdmin = { id: string; email: string; name: string; role: AdminRole };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AuthedAdmin;
      csrfToken?: string;
    }
  }
}

export const cookieBase = () => ({
  secure: env.COOKIE_SECURE || isProd,
  sameSite: 'lax' as const,
  path: '/',
  ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
});

export function issueSession(
  res: Response,
  admin: { id: string; role: AdminRole; tokenVersion: number },
) {
  const csrf = randomToken(24);
  const maxAgeMs = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
  const token = jwt.sign(
    { tv: admin.tokenVersion, role: admin.role, csrf } satisfies Omit<SessionClaims, 'sub'>,
    env.JWT_SECRET,
    {
      subject: admin.id,
      expiresIn: `${env.SESSION_TTL_HOURS}h`,
      algorithm: 'HS256',
      issuer: 'nexus-api',
      audience: 'nexus-admin',
    },
  );
  res.cookie(SESSION_COOKIE, token, { ...cookieBase(), httpOnly: true, maxAge: maxAgeMs });
  // Readable by the admin UI so it can echo the value in the CSRF header.
  res.cookie(CSRF_COOKIE, csrf, { ...cookieBase(), httpOnly: false, maxAge: maxAgeMs });
  return csrf;
}

export function clearSession(res: Response) {
  res.clearCookie(SESSION_COOKIE, { ...cookieBase(), httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase(), httpOnly: false });
}

/** Verifies the session cookie, reloads the admin (so deactivation is immediate) and enforces CSRF on writes. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) throw unauthorized();

  let claims: SessionClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: 'nexus-api',
      audience: 'nexus-admin',
    }) as SessionClaims;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  const admin = await Admin.findById(claims.sub).lean();
  if (!admin || !admin.active || admin.tokenVersion !== claims.tv) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const header = req.get(CSRF_HEADER);
    if (!header || !safeEqual(header, claims.csrf))
      throw forbidden('Security check failed. Refresh the page and try again.');
  }

  req.admin = {
    id: String(admin._id),
    email: admin.email,
    name: admin.name,
    role: admin.role as AdminRole,
  };
  req.csrfToken = claims.csrf;
  next();
}

const rank: Record<AdminRole, number> = { editor: 1, admin: 2, owner: 3 };

/** Allow the given role or anything above it (owner > admin > editor). */
export function requireRole(min: AdminRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) throw unauthorized();
    if (rank[req.admin.role] < rank[min]) throw forbidden();
    next();
  };
}
