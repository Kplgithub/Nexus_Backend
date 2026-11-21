import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import type {
  ActivityItem,
  AdminRef,
  AdminRole,
  TeamMember,
  activityQuerySchema,
  teamCreateSchema,
  teamUpdateSchema,
} from '@nexus/shared';
import { Admin, AuditLog, Enquiry } from '../models/misc.models.js';
import { SiteVisit } from '../models/admin-panel.models.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { paginate } from '../lib/respond.js';
import { hashPassword } from './auth.service.js';

const OPEN = ['new', 'contacted', 'qualified'];
const SUPER: AdminRole[] = ['owner', 'admin'];

type AdminLean = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  role: AdminRole;
  active: boolean;
  lastLoginAt?: Date | null;
  lockedUntil?: Date | null;
  createdAt: Date;
};

export const adminRef = (a: { _id: unknown; name: string; role: string }): AdminRef => ({
  id: String(a._id),
  name: a.name,
  role: a.role as AdminRole,
});

async function statsFor(ids: Types.ObjectId[]) {
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);
  const [leads, visits, actions] = await Promise.all([
    Enquiry.aggregate<{ _id: { a: Types.ObjectId; open: boolean }; n: number }>([
      { $match: { assignedAdmin: { $in: ids }, status: { $ne: 'spam' } } },
      {
        $group: {
          _id: { a: '$assignedAdmin', open: { $in: ['$status', OPEN] } },
          n: { $sum: 1 },
        },
      },
    ]),
    SiteVisit.aggregate<{ _id: Types.ObjectId; n: number }>([
      {
        $match: {
          assignedAdmin: { $in: ids },
          status: 'scheduled',
          scheduledAt: { $gte: new Date() },
        },
      },
      { $group: { _id: '$assignedAdmin', n: { $sum: 1 } } },
    ]),
    AuditLog.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { actor: { $in: ids }, createdAt: { $gte: monthAgo }, action: { $ne: 'login' } } },
      { $group: { _id: '$actor', n: { $sum: 1 } } },
    ]),
  ]);
  const key = (id: unknown) => String(id);
  const out = new Map<string, TeamMember['stats']>();
  for (const id of ids)
    out.set(key(id), { openLeads: 0, closedLeads: 0, upcomingVisits: 0, actions30d: 0 });
  for (const r of leads) {
    const s = out.get(key(r._id.a));
    if (!s) continue;
    if (r._id.open) s.openLeads += r.n;
    else s.closedLeads += r.n;
  }
  for (const r of visits) {
    const s = out.get(key(r._id));
    if (s) s.upcomingVisits = r.n;
  }
  for (const r of actions) {
    const s = out.get(key(r._id));
    if (s) s.actions30d = r.n;
  }
  return out;
}

function toMember(a: AdminLean, stats: TeamMember['stats']): TeamMember {
  return {
    id: String(a._id),
    name: a.name,
    email: a.email,
    role: a.role,
    active: a.active,
    lastLoginAt: a.lastLoginAt ? a.lastLoginAt.toISOString() : null,
    lockedUntil: a.lockedUntil && a.lockedUntil > new Date() ? a.lockedUntil.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
    stats,
  };
}

export async function listTeam(): Promise<TeamMember[]> {
  const rows = await Admin.find().sort({ active: -1, createdAt: 1 }).lean<AdminLean[]>();
  const stats = await statsFor(rows.map((r) => r._id));
  return rows.map((r) => toMember(r, stats.get(String(r._id))!));
}

/** Active members, for "assign to" pickers. Everyone can read this. */
export async function listAssignees(): Promise<AdminRef[]> {
  const rows = await Admin.find({ active: true }).sort({ name: 1 }).select('name role').lean();
  return rows.map(adminRef);
}

async function getMember(id: string) {
  const a = await Admin.findById(id).lean<AdminLean>();
  if (!a) throw notFound('Team member not found');
  const stats = await statsFor([a._id]);
  return toMember(a, stats.get(String(a._id))!);
}

export async function createMember(input: z.output<typeof teamCreateSchema>) {
  if (await Admin.exists({ email: input.email }))
    throw conflict('Someone on the team already uses this email');
  const a = await Admin.create({
    name: input.name,
    email: input.email,
    role: input.role,
    passwordHash: await hashPassword(input.password),
  });
  return getMember(String(a._id));
}

/** A Super Admin must always remain, and nobody can lock themselves out. */
async function assertKeepsASuperAdmin(id: string, change: { role?: AdminRole; active?: boolean }) {
  const target = await Admin.findById(id).select('role active').lean();
  if (!target) throw notFound('Team member not found');
  const losesSuper =
    SUPER.includes(target.role as AdminRole) &&
    target.active &&
    ((change.role && !SUPER.includes(change.role)) || change.active === false);
  if (!losesSuper) return;
  const others = await Admin.countDocuments({
    _id: { $ne: id },
    role: { $in: SUPER },
    active: true,
  });
  if (others === 0) throw badRequest('Keep at least one active Super Admin');
}

export async function updateMember(
  id: string,
  patch: z.output<typeof teamUpdateSchema>,
  actorId: string,
) {
  if (id === actorId && (patch.role !== undefined || patch.active === false)) {
    throw badRequest('You cannot change your own role or turn off your own account');
  }
  await assertKeepsASuperAdmin(id, patch);
  const a = await Admin.findById(id);
  if (!a) throw notFound('Team member not found');
  if (patch.name) a.name = patch.name;
  if (patch.role) {
    a.role = patch.role;
    a.tokenVersion += 1; // new permissions take effect on next sign-in
  }
  if (patch.active !== undefined) {
    a.active = patch.active;
    if (!patch.active) a.tokenVersion += 1;
  }
  await a.save();
  // Leads of someone who left go back to the unassigned pile.
  if (patch.active === false) {
    await Enquiry.updateMany(
      { assignedAdmin: a._id, status: { $in: OPEN } },
      { $set: { assignedAdmin: null, assignedTo: null } },
    );
  }
  return getMember(id);
}

export async function setMemberPassword(id: string, password: string) {
  const a = await Admin.findById(id);
  if (!a) throw notFound('Team member not found');
  a.passwordHash = await hashPassword(password);
  a.tokenVersion += 1;
  a.failedLogins = 0;
  a.lockedUntil = null;
  await a.save();
  return { name: a.name };
}

/* ---------------- Activity log ---------------- */

type AuditLean = {
  _id: Types.ObjectId;
  actor?: { _id: Types.ObjectId; name: string; role: string } | null;
  actorEmail?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  summary?: string | null;
  createdAt: Date;
};

const toActivity = (r: AuditLean): ActivityItem => ({
  id: String(r._id),
  actor: r.actor ? adminRef(r.actor) : null,
  actorEmail: r.actorEmail ?? null,
  action: r.action,
  entity: r.entity,
  entityId: r.entityId ?? null,
  summary: r.summary ?? null,
  createdAt: r.createdAt.toISOString(),
});

export async function listActivity(q: z.output<typeof activityQuerySchema>) {
  const f: FilterQuery<AuditLean> = {};
  if (q.actor) f.actor = new Types.ObjectId(q.actor);
  if (q.entity) f.entity = q.entity;
  if (q.from || q.to)
    f.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  const [rows, total] = await Promise.all([
    AuditLog.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('actor', 'name role')
      .lean<AuditLean[]>(),
    AuditLog.countDocuments(f),
  ]);
  return { items: rows.map(toActivity), meta: paginate(q.page, q.limit, total) };
}

export async function recentActivity(limit = 8) {
  const rows = await AuditLog.find({ action: { $ne: 'login' } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor', 'name role')
    .lean<AuditLean[]>();
  return rows.map(toActivity);
}
