import { isBusinessRole, type UserRole } from '@nexus/shared';
import type { FilterQuery } from 'mongoose';
import type { z } from 'zod';
import type {
  AdminWebsiteUser,
  VerificationItem,
  adminUserQuerySchema,
  adminUserUpdateSchema,
  verificationDecisionSchema,
  verificationQuerySchema,
} from '@nexus/shared';
import { env } from '../config/env.js';
import { badRequest } from '../lib/errors.js';
import { hashPassword } from './auth.service.js';
import { sendMail } from './mail.service.js';
import { User, type UserAttrs } from '../models/user.model.js';
import { Property } from '../models/property.model.js';
import { notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { toSessionUser } from './user.service.js';

type UserLean = UserAttrs & { _id: unknown; createdAt: Date };

function toAdminUser(u: UserLean, listingCount: number): AdminWebsiteUser {
  return {
    ...toSessionUser(u),
    status: u.status as AdminWebsiteUser['status'],
    verificationStatus: (u.verificationStatus ??
      'unverified') as AdminWebsiteUser['verificationStatus'],
    lastLoginAt: u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : null,
    listingCount,
    notes: (u.notes ?? []).map((n) => ({
      text: n.text,
      by: n.by,
      at: new Date(n.at).toISOString(),
    })),
  };
}

async function listingCounts(ids: unknown[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await Property.aggregate<{ _id: unknown; n: number }>([
    { $match: { postedBy: { $in: ids } } },
    { $group: { _id: '$postedBy', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

export async function listUsers(q: z.output<typeof adminUserQuerySchema>) {
  const f: FilterQuery<UserLean> = {};
  if (q.role) f.role = q.role;
  if (q.status) f.status = q.status;
  if (q.verified) f.verified = true;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [{ name: rx }, { email: rx }, { phone: rx }, { companyName: rx }, { reraNumber: rx }];
  }
  const [rows, total] = await Promise.all([
    User.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<UserLean[]>(),
    User.countDocuments(f),
  ]);
  const counts = await listingCounts(rows.map((r) => r._id));
  return {
    items: rows.map((r) => toAdminUser(r, counts.get(String(r._id)) ?? 0)),
    meta: paginate(q.page, q.limit, total),
  };
}

export async function getUser(id: string) {
  const u = await User.findById(id).lean<UserLean>();
  if (!u) throw notFound('User not found');
  const counts = await listingCounts([u._id]);
  return toAdminUser(u, counts.get(String(u._id)) ?? 0);
}

export async function updateUser(
  id: string,
  patch: z.output<typeof adminUserUpdateSchema>,
  by: string,
) {
  const u = await User.findById(id);
  if (!u) throw notFound('User not found');
  if (patch.status) {
    u.status = patch.status;
    // Blocking signs the user out everywhere and takes their live listings down.
    if (patch.status === 'blocked') {
      u.tokenVersion += 1;
      await Property.updateMany(
        { postedBy: u._id, status: { $in: ['published', 'pending'] } },
        { $set: { status: 'inactive', featured: false } },
      );
    }
  }
  if (patch.verified !== undefined) {
    u.verified = patch.verified;
    u.verificationStatus = patch.verified ? 'verified' : 'unverified';
    u.verifiedAt = patch.verified ? new Date() : null;
    u.verifiedBy = patch.verified ? by : null;
  }
  if (patch.note) u.notes.push({ text: patch.note, by, at: new Date() });
  await u.save();
  return getUser(id);
}

/** Only Super Admins reach this (rule: Sub-admins can edit details, never passwords). */
export async function setUserPassword(id: string, password: string) {
  const u = await User.findById(id);
  if (!u) throw notFound('User not found');
  u.passwordHash = await hashPassword(password);
  u.tokenVersion += 1; // signs them out everywhere
  u.failedLogins = 0;
  u.lockedUntil = null;
  await u.save();
  return { name: u.name };
}

/* ---------------- Agent & builder verification ---------------- */

type VerifyLean = UserLean & {
  verificationStatus?: string | null;
  verifiedAt?: Date | null;
  verifiedBy?: string | null;
  verificationNote?: string | null;
};

const toVerification = (u: VerifyLean, n: number): VerificationItem => ({
  ...toAdminUser(u, n),
  verificationStatus: (u.verificationStatus ??
    'unverified') as VerificationItem['verificationStatus'],
  verifiedAt: u.verifiedAt ? new Date(u.verifiedAt).toISOString() : null,
  verifiedBy: u.verifiedBy ?? null,
  verificationNote: u.verificationNote ?? null,
});

export async function listVerification(q: z.output<typeof verificationQuerySchema>) {
  const f: FilterQuery<VerifyLean> = { role: q.role ?? { $in: ['agent', 'builder'] } };
  if (q.status === 'unverified' || q.status === 'pending')
    f.verificationStatus = { $in: ['unverified', 'pending'] };
  else if (q.status) f.verificationStatus = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [{ name: rx }, { companyName: rx }, { phone: rx }, { reraNumber: rx }];
  }
  const [rows, total, counts] = await Promise.all([
    User.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<VerifyLean[]>(),
    User.countDocuments(f),
    User.aggregate<{ _id: string; n: number }>([
      { $match: { role: { $in: ['agent', 'builder'] } } },
      { $group: { _id: '$verificationStatus', n: { $sum: 1 } } },
    ]),
  ]);
  const lc = await listingCounts(rows.map((r) => r._id));
  const c = Object.fromEntries(counts.map((r) => [r._id ?? 'unverified', r.n]));
  return {
    items: rows.map((r) => toVerification(r, lc.get(String(r._id)) ?? 0)),
    meta: paginate(q.page, q.limit, total),
    counts: {
      waiting: (c.unverified ?? 0) + (c.pending ?? 0),
      verified: c.verified ?? 0,
      rejected: c.rejected ?? 0,
    },
  };
}

export async function decideVerification(
  id: string,
  input: z.output<typeof verificationDecisionSchema>,
  by: string,
) {
  const u = await User.findById(id);
  if (!u) throw notFound('User not found');
  if (!isBusinessRole(u.role as UserRole))
    throw badRequest('Only agents and builders are verified');
  if (input.decision === 'rejected' && !input.note)
    throw badRequest('Write the reason so they know what to fix', { note: ['Required'] });
  u.verificationStatus = input.decision;
  u.verified = input.decision === 'verified';
  u.verifiedAt = input.decision === 'verified' ? new Date() : null;
  u.verifiedBy = input.decision === 'unverified' ? null : by;
  u.verificationNote = input.note || null;
  u.notes.push({
    text: `Verification: ${input.decision}${input.note ? ` — ${input.note}` : ''}`,
    by,
    at: new Date(),
  });
  await u.save();
  if (input.decision !== 'unverified') {
    void sendMail(
      u.email,
      input.decision === 'verified'
        ? 'Your NEXUS Estate profile is verified'
        : 'We could not verify your NEXUS Estate profile yet',
      input.decision === 'verified'
        ? [`Hi ${u.name},`, 'Your profile now shows the Verified badge on NEXUS Estate.']
        : [
            `Hi ${u.name},`,
            `Reason: ${input.note}`,
            'Update your profile and reply to this email.',
          ],
      { label: 'Open your profile', url: `${env.PUBLIC_SITE_URL}/dashboard/profile` },
    );
  }
  const n = (await listingCounts([u._id])).get(String(u._id)) ?? 0;
  return toVerification(u.toObject() as unknown as VerifyLean, n);
}
