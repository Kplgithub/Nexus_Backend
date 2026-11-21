import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import {
  SUPPORT_STATUSES,
  SUPPORT_TOPIC_LABELS,
  USER_ROLES,
  USER_ROLE_LABELS,
  type AdminSupportCounts,
  type AdminSupportTicket,
  type SupportStatus,
  type SupportTicket as SupportTicketDto,
  type SupportTicketSummary,
  type SupportTopic,
  type UserRole,
  type adminSupportQuerySchema,
  type adminSupportReplySchema,
  type supportReplySchema,
  type supportTicketCreateSchema,
} from '@nexus/shared';
import { SupportTicket } from '../models/admin-panel.models.js';
import { User } from '../models/user.model.js';
import { Property } from '../models/property.model.js';
import { badRequest, notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import type { AuthedAdmin } from '../middleware/auth.js';
import { nextLeadId } from './support.service.js';
import { businessAlert, notifyAdmins } from './notification.service.js';

type Msg = {
  from: 'user' | 'admin';
  by: string;
  text: string;
  images: string[];
  at: Date;
};

type TicketLean = {
  _id: Types.ObjectId;
  ticketId: string;
  user: Types.ObjectId;
  role: UserRole;
  userSnapshot?: { name?: string; phone?: string; companyName?: string | null } | null;
  topic?: SupportTopic | null;
  subject: string;
  property?: Types.ObjectId | null;
  propertySnapshot?: { title?: string | null; slug?: string | null } | null;
  status: SupportStatus;
  messages: Msg[];
  lastMessageAt: Date;
  firstReplyAt?: Date | null;
  resolvedAt?: Date | null;
  userUnread: boolean;
  adminUnread: boolean;
  createdAt: Date;
};

const SUMMARY_FIELDS = '-messages';

function summary(t: TicketLean, side: 'user' | 'admin'): SupportTicketSummary {
  return {
    id: String(t._id),
    ticketId: t.ticketId,
    topic: t.topic ?? null,
    subject: t.subject,
    status: t.status,
    property:
      t.property && t.propertySnapshot?.slug
        ? {
            id: String(t.property),
            title: t.propertySnapshot.title ?? '',
            slug: t.propertySnapshot.slug,
          }
        : null,
    lastMessageAt: t.lastMessageAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    unread: side === 'user' ? t.userUnread : t.adminUnread,
    user: {
      id: String(t.user),
      name: t.userSnapshot?.name ?? '',
      role: t.role,
      companyName: t.userSnapshot?.companyName ?? null,
      // Users never need their own number back; admins do.
      phone: side === 'admin' ? (t.userSnapshot?.phone ?? '') : '',
    },
  };
}

function full(t: TicketLean, side: 'user' | 'admin'): SupportTicketDto {
  return {
    ...summary(t, side),
    messages: (t.messages ?? []).map((m) => ({
      from: m.from,
      by: m.by,
      text: m.text ?? '',
      images: m.images ?? [],
      at: new Date(m.at).toISOString(),
    })),
    resolvedAt: t.resolvedAt ? t.resolvedAt.toISOString() : null,
  };
}

/** A short title for lists: the first line of the message, or the topic. */
function subjectFor(topic: SupportTopic | null | undefined, message: string) {
  const line =
    message
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  if (line) return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  return topic ? SUPPORT_TOPIC_LABELS[topic] : 'Support request';
}

/* ---------------- Website user side ---------------- */

export async function listMine(userId: string) {
  const rows = await SupportTicket.find({ user: userId })
    .select(SUMMARY_FIELDS)
    .sort({ lastMessageAt: -1 })
    .limit(100)
    .lean<TicketLean[]>();
  const items = rows.map((r) => summary(r, 'user'));
  return { items, unread: items.filter((i) => i.unread).length };
}

/** Count of tickets with a team reply the user has not opened; for the menu badge. */
export const unreadForUser = (userId: string) =>
  SupportTicket.countDocuments({ user: userId, userUnread: true });

export async function getMine(userId: string, id: string) {
  const t = await SupportTicket.findOneAndUpdate(
    { _id: id, user: userId },
    { $set: { userUnread: false } },
    { new: true },
  ).lean<TicketLean>();
  if (!t) throw notFound('Request not found');
  return full(t, 'user');
}

export async function createTicket(
  userId: string,
  input: z.output<typeof supportTicketCreateSchema>,
) {
  const user = await User.findById(userId).select('name phone role companyName').lean();
  if (!user) throw notFound('Account not found');
  // Stop one account from flooding the queue.
  const recent = await SupportTicket.countDocuments({
    user: userId,
    createdAt: { $gte: new Date(Date.now() - 24 * 3600 * 1000) },
  });
  if (recent >= 10)
    throw badRequest('You have sent many requests today. Please reply on an open one.');

  let propertySnapshot: { title: string; slug: string } | null = null;
  if (input.propertyId) {
    const p = await Property.findById(input.propertyId).select('title slug').lean();
    if (!p) throw badRequest('Listing not found', { propertyId: ['Not found'] });
    propertySnapshot = { title: p.title, slug: p.slug };
  }

  const message = input.message || (input.topic ? `${SUPPORT_TOPIC_LABELS[input.topic]}` : '');
  const now = new Date();
  const doc = await SupportTicket.create({
    ticketId: await nextLeadId('S'),
    user: userId,
    role: user.role,
    userSnapshot: { name: user.name, phone: user.phone, companyName: user.companyName ?? null },
    topic: input.topic ?? null,
    subject: subjectFor(input.topic, input.message),
    property: propertySnapshot ? input.propertyId : null,
    propertySnapshot,
    status: 'open',
    messages: [{ from: 'user', by: user.name, text: message, images: input.images, at: now }],
    lastMessageAt: now,
    adminUnread: true,
  });
  const t = doc.toObject() as unknown as TicketLean;

  void businessAlert('support', {
    title: `Support request from ${user.name} (${USER_ROLE_LABELS[user.role as UserRole]})`,
    body: `${t.ticketId}: ${t.subject}`,
    link: `/admin/support?open=${t._id}`,
  });
  return full(t, 'user');
}

export async function replyMine(
  userId: string,
  id: string,
  input: z.output<typeof supportReplySchema>,
) {
  const user = await User.findById(userId).select('name').lean();
  if (!user) throw notFound('Account not found');
  const now = new Date();
  const existing = await SupportTicket.findOne({ _id: id, user: userId })
    .select('status messages')
    .lean<Pick<TicketLean, 'status' | 'messages'>>();
  if (!existing) throw notFound('Request not found');
  if ((existing.messages?.length ?? 0) >= 200)
    throw badRequest('This request is too long. Please raise a new one.');
  const t = await SupportTicket.findOneAndUpdate(
    { _id: id, user: userId },
    {
      $push: {
        messages: {
          from: 'user',
          by: user.name,
          text: input.message,
          images: input.images,
          at: now,
        },
      },
      $set: {
        lastMessageAt: now,
        adminUnread: true,
        userUnread: false,
        // A reply on a closed request opens it again.
        ...(existing.status === 'resolved' ? { status: 'open', resolvedAt: null } : {}),
      },
    },
    { new: true },
  ).lean<TicketLean>();
  if (!t) throw notFound('Request not found');
  void notifyAdmins({
    kind: 'support',
    title: `New reply from ${user.name} on ${t.ticketId}`,
    body: input.message.slice(0, 200),
    link: `/admin/support?open=${t._id}`,
  });
  return full(t, 'user');
}

/* ---------------- Admin side ---------------- */

type AdminQuery = z.output<typeof adminSupportQuerySchema>;

function searchFilter(q?: string): FilterQuery<TicketLean> {
  if (!q) return {};
  const rx = new RegExp(escapeRegex(q), 'i');
  const digits = q.replace(/\D/g, '');
  return {
    $or: [
      { ticketId: rx },
      { subject: rx },
      { 'userSnapshot.name': rx },
      { 'userSnapshot.companyName': rx },
      ...(digits.length >= 4 ? [{ 'userSnapshot.phone': new RegExp(escapeRegex(digits)) }] : []),
    ],
  };
}

async function countBy(field: 'role' | 'status', base: FilterQuery<TicketLean>) {
  const rows = await SupportTicket.aggregate<{ _id: string; n: number }>([
    { $match: base },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function listForAdmin(q: AdminQuery) {
  const common: FilterQuery<TicketLean> = {
    ...searchFilter(q.q),
    ...(q.topic ? { topic: q.topic } : {}),
  };
  const f: FilterQuery<TicketLean> = {
    ...common,
    ...(q.role ? { role: q.role } : {}),
    ...(q.status ? { status: q.status } : {}),
  };
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [rows, total, byRole, byStatus, open, inProgress, resolved7d, replyTimes] =
    await Promise.all([
      SupportTicket.find(f)
        .select(SUMMARY_FIELDS)
        // Unread first, then newest activity.
        .sort({ adminUnread: -1, lastMessageAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean<TicketLean[]>(),
      SupportTicket.countDocuments(f),
      countBy('role', { ...common, ...(q.status ? { status: q.status } : {}) }),
      countBy('status', { ...common, ...(q.role ? { role: q.role } : {}) }),
      SupportTicket.countDocuments({ status: 'open' }),
      SupportTicket.countDocuments({ status: 'in-progress' }),
      SupportTicket.countDocuments({ status: 'resolved', resolvedAt: { $gte: weekAgo } }),
      SupportTicket.aggregate<{ avg: number | null }>([
        {
          $match: {
            firstReplyAt: { $ne: null },
            createdAt: { $gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
          },
        },
        { $group: { _id: null, avg: { $avg: { $subtract: ['$firstReplyAt', '$createdAt'] } } } },
      ]),
    ]);

  const roles = Object.fromEntries(USER_ROLES.map((r) => [r, byRole.get(r) ?? 0])) as Record<
    UserRole,
    number
  >;
  const statuses = Object.fromEntries(
    SUPPORT_STATUSES.map((s) => [s, byStatus.get(s) ?? 0]),
  ) as Record<SupportStatus, number>;
  const avgMs = replyTimes[0]?.avg ?? null;
  const counts: AdminSupportCounts = {
    roles: { all: Object.values(roles).reduce((a, b) => a + b, 0), ...roles },
    statuses: { all: Object.values(statuses).reduce((a, b) => a + b, 0), ...statuses },
    stats: {
      open,
      inProgress,
      resolved7d,
      avgFirstReplyMins: avgMs == null ? null : Math.round(avgMs / 60_000),
    },
  };
  return {
    items: rows.map((r) => summary(r, 'admin')),
    meta: paginate(q.page, q.limit, total),
    counts,
  };
}

async function adminView(t: TicketLean): Promise<AdminSupportTicket> {
  const u = await User.findById(t.user).select('email premiumUntil verified').lean();
  return {
    ...full(t, 'admin'),
    userInfo: u
      ? {
          email: u.email,
          premiumUntil: u.premiumUntil ? new Date(u.premiumUntil).toISOString() : null,
          verified: Boolean(u.verified),
        }
      : null,
  };
}

export async function getForAdmin(id: string) {
  const t = await SupportTicket.findByIdAndUpdate(
    id,
    { $set: { adminUnread: false } },
    { new: true },
  ).lean<TicketLean>();
  if (!t) throw notFound('Support request not found');
  return adminView(t);
}

export async function replyAsAdmin(
  id: string,
  input: z.output<typeof adminSupportReplySchema>,
  admin: AuthedAdmin,
) {
  const current = await SupportTicket.findById(id)
    .select('status firstReplyAt')
    .lean<Pick<TicketLean, 'status' | 'firstReplyAt'>>();
  if (!current) throw notFound('Support request not found');
  const now = new Date();
  const set: Record<string, unknown> = { adminUnread: false };
  const changes: string[] = [];
  // A reply on an open request moves it to "in progress" unless a status was picked.
  const status: SupportStatus | undefined =
    input.status ?? (input.message && current.status === 'open' ? 'in-progress' : undefined);
  if (status && status !== current.status) {
    set.status = status;
    set.resolvedAt = status === 'resolved' ? now : null;
    changes.push(`status → ${status}`);
  }
  const update: Record<string, unknown> = { $set: set };
  if (input.message) {
    const name = admin.name || 'NEXUS Support';
    update.$push = {
      messages: {
        from: 'admin',
        by: name,
        admin: new Types.ObjectId(admin.id),
        text: input.message,
        images: [],
        at: now,
      },
    };
    set.lastMessageAt = now;
    set.userUnread = true;
    if (!current.firstReplyAt) set.firstReplyAt = now;
    changes.unshift('reply');
  }
  const t = await SupportTicket.findByIdAndUpdate(id, update, { new: true }).lean<TicketLean>();
  if (!t) throw notFound('Support request not found');
  return { ticket: await adminView(t), changes };
}
