import type { FilterQuery } from 'mongoose';
import type { z } from 'zod';
import type { AdminWebsiteUser, adminUserQuerySchema, adminUserUpdateSchema } from '@nexus/shared';
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
  if (patch.verified !== undefined) u.verified = patch.verified;
  if (patch.note) u.notes.push({ text: patch.note, by, at: new Date() });
  await u.save();
  return getUser(id);
}
