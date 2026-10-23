import argon2 from 'argon2';
import type { AdminRole, AdminUser } from '@nexus/shared';
import { Admin } from '../models/misc.models.js';
import { AppError, badRequest, unauthorized } from '../lib/errors.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

// Argon2id with OWASP-recommended parameters.
const HASH_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const hashPassword = (password: string) => argon2.hash(password, HASH_OPTS);

export const verifyPassword = (hash: string, password: string) =>
  argon2.verify(hash, password).catch(() => false);
export const passwordNeedsRehash = (hash: string) => argon2.needsRehash(hash, HASH_OPTS);

let dummyHash: string | null = null;
export async function burnTime(password: string) {
  dummyHash ??= await argon2.hash('not-a-real-password-placeholder', HASH_OPTS);
  await argon2.verify(dummyHash, password).catch(() => false);
}

export async function login(
  email: string,
  password: string,
): Promise<AdminUser & { tokenVersion: number }> {
  const admin = await Admin.findOne({ email }).select('+passwordHash');
  if (!admin || !admin.active) {
    // Spend comparable time so response timing doesn't reveal which emails exist.
    await burnTime(password);
    throw unauthorized('Incorrect email or password');
  }
  if (admin.lockedUntil && admin.lockedUntil > new Date()) {
    throw new AppError(423, 'LOCKED', 'Too many failed attempts. Try again later.');
  }
  const valid = await argon2.verify(admin.passwordHash, password).catch(() => false);
  if (!valid) {
    admin.failedLogins += 1;
    if (admin.failedLogins >= MAX_FAILED) {
      admin.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      admin.failedLogins = 0;
    }
    await admin.save();
    throw unauthorized('Incorrect email or password');
  }
  admin.failedLogins = 0;
  admin.lockedUntil = null;
  admin.lastLoginAt = new Date();
  if (argon2.needsRehash(admin.passwordHash, HASH_OPTS))
    admin.passwordHash = await hashPassword(password);
  await admin.save();
  return {
    id: String(admin._id),
    email: admin.email,
    name: admin.name,
    role: admin.role as AdminRole,
    tokenVersion: admin.tokenVersion,
  };
}

export async function changePassword(adminId: string, current: string, next: string) {
  const admin = await Admin.findById(adminId).select('+passwordHash');
  if (!admin) throw unauthorized();
  if (!(await argon2.verify(admin.passwordHash, current).catch(() => false))) {
    throw badRequest('Current password is incorrect', { currentPassword: ['Incorrect password'] });
  }
  admin.passwordHash = await hashPassword(next);
  admin.tokenVersion += 1; // signs out every other session
  await admin.save();
  return { id: String(admin._id), role: admin.role as AdminRole, tokenVersion: admin.tokenVersion };
}

export async function signOutEverywhere(adminId: string) {
  await Admin.updateOne({ _id: adminId }, { $inc: { tokenVersion: 1 } });
}
