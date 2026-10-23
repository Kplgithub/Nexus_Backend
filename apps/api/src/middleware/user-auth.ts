import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@nexus/shared';
import { env } from '../config/env.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { User } from '../models/user.model.js';
import { CSRF_HEADER, cookieBase } from './auth.js';

/** Website-user session. Separate cookie names from staff so both can coexist in one browser. */
export const USER_SESSION_COOKIE = 'nexus_user';
export const USER_CSRF_COOKIE = 'nexus_ucsrf';

type UserClaims = { sub: string; tv: number; role: UserRole; csrf: string };

export type AuthedUser = {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  phone: string;
  phoneVerified: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      userCsrfToken?: string;
    }
  }
}

const JWT_OPTS = { algorithms: ['HS256' as const], issuer: 'nexus-api', audience: 'nexus-user' };

export function issueUserSession(
  res: Response,
  user: { id: string; role: UserRole; tokenVersion: number },
) {
  const csrf = randomToken(24);
  const maxAgeMs = env.USER_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
  const token = jwt.sign({ tv: user.tokenVersion, role: user.role, csrf }, env.JWT_SECRET, {
    subject: user.id,
    expiresIn: `${env.USER_SESSION_TTL_DAYS}d`,
    algorithm: 'HS256',
    issuer: 'nexus-api',
    audience: 'nexus-user',
  });
  res.cookie(USER_SESSION_COOKIE, token, { ...cookieBase(), httpOnly: true, maxAge: maxAgeMs });
  res.cookie(USER_CSRF_COOKIE, csrf, { ...cookieBase(), httpOnly: false, maxAge: maxAgeMs });
  return csrf;
}

export function clearUserSession(res: Response) {
  res.clearCookie(USER_SESSION_COOKIE, { ...cookieBase(), httpOnly: true });
  res.clearCookie(USER_CSRF_COOKIE, { ...cookieBase(), httpOnly: false });
}

/** Resolves the session to a user, or null. Never throws for a missing/expired session. */
async function resolveUser(req: Request): Promise<{ user: AuthedUser; csrf: string } | null> {
  const token: unknown = req.cookies?.[USER_SESSION_COOKIE];
  if (typeof token !== 'string' || !token) return null;
  let claims: UserClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET, JWT_OPTS) as UserClaims;
  } catch {
    return null;
  }
  const u = await User.findById(claims.sub)
    .select('role name email phone phoneVerified status tokenVersion')
    .lean();
  if (!u || u.status !== 'active' || u.tokenVersion !== claims.tv) return null;
  return {
    user: {
      id: String(u._id),
      role: u.role as UserRole,
      name: u.name,
      email: u.email,
      phone: u.phone,
      phoneVerified: u.phoneVerified,
    },
    csrf: claims.csrf,
  };
}

function checkCsrf(req: Request, csrf: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const header = req.get(CSRF_HEADER);
  if (!header || !safeEqual(header, csrf)) {
    throw forbidden('Security check failed. Refresh the page and try again.');
  }
}

export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const found = await resolveUser(req);
  if (!found) throw unauthorized('Please sign in to continue.');
  checkCsrf(req, found.csrf);
  req.user = found.user;
  req.userCsrfToken = found.csrf;
  next();
}

/**
 * Attaches the user when a valid session is present (e.g. to link an enquiry to an
 * account) but lets anonymous requests through. CSRF is still enforced for a
 * signed-in user's writes so a session cookie can't be ridden cross-site.
 */
export async function optionalUser(req: Request, _res: Response, next: NextFunction) {
  const found = await resolveUser(req);
  if (found) {
    checkCsrf(req, found.csrf);
    req.user = found.user;
    req.userCsrfToken = found.csrf;
  }
  next();
}

/** Restrict to listing posters. Every role may post (individuals as owners). */
export function requireRoles(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
}
