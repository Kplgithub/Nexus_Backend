import { Types } from 'mongoose';
import {
  PROPERTY_STATUSES,
  type DashboardPerformance,
  type DashboardStats,
  type PropertyStatus,
  type UserDashboard,
  type UserRole,
} from '@nexus/shared';
import { Property } from '../models/property.model.js';
import { Enquiry, PropertyViewDay } from '../models/misc.models.js';
import { indiaDay, indiaDayStart, lastIndiaDays } from '../lib/india-day.js';
import { User } from '../models/user.model.js';
import { listLeadsForOwner } from './enquiry.service.js';
import { activeSubscription, listingLimitFor, usageFor } from './billing.service.js';

export async function getDashboard(): Promise<DashboardStats> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [byStatus, demo, enqByStatus, followUpsDue, usersByRole, newUsers, recentProps, recentEnq] =
    await Promise.all([
      Property.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      Property.countDocuments({ isDemo: true }),
      Enquiry.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
      Enquiry.countDocuments({
        followUpAt: { $lte: new Date() },
        status: { $in: ['new', 'contacted', 'qualified'] },
      }),
      User.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$role', n: { $sum: 1 } } }]),
      User.countDocuments({ createdAt: { $gte: weekAgo } }),
      Property.find()
        .sort({ createdAt: -1 })
        .limit(6)
        .select('title slug status price listingType createdAt')
        .lean(),
      Enquiry.find({ status: { $ne: 'spam' } })
        .sort({ createdAt: -1 })
        .limit(6)
        .select('leadId name status createdAt property propertySnapshot')
        .lean(),
    ]);
  const ps = Object.fromEntries(byStatus.map((r) => [r._id, r.n])) as Record<string, number>;
  const es = Object.fromEntries(enqByStatus.map((r) => [r._id, r.n])) as Record<string, number>;
  const us = Object.fromEntries(usersByRole.map((r) => [r._id, r.n])) as Record<string, number>;
  const sum = (o: Record<string, number>, skip: string[] = []) =>
    Object.entries(o).reduce((a, [k, v]) => (skip.includes(k) ? a : a + v), 0);

  return {
    properties: {
      total: sum(ps),
      published: ps.published ?? 0,
      pending: ps.pending ?? 0,
      draft: ps.draft ?? 0,
      rented: ps.rented ?? 0,
      sold: ps.sold ?? 0,
      inactive: ps.inactive ?? 0,
      archived: ps.archived ?? 0,
      demo,
    },
    enquiries: {
      total: sum(es, ['spam']),
      new: es.new ?? 0,
      contacted: es.contacted ?? 0,
      qualified: es.qualified ?? 0,
      followUpsDue,
    },
    users: {
      total: sum(us),
      individual: us.individual ?? 0,
      agent: us.agent ?? 0,
      builder: us.builder ?? 0,
      newThisWeek: newUsers,
    },
    recentProperties: recentProps.map((p) => ({
      id: String(p._id),
      title: p.title,
      slug: p.slug,
      status: p.status as PropertyStatus,
      price: p.price,
      listingType: p.listingType as 'rent' | 'sale',
      createdAt: (p.createdAt as Date).toISOString(),
    })),
    recentEnquiries: recentEnq.map((e) => ({
      id: String(e._id),
      leadId: e.leadId,
      name: e.name,
      status: e.status as DashboardStats['recentEnquiries'][number]['status'],
      createdAt: (e.createdAt as Date).toISOString(),
      property:
        e.property && e.propertySnapshot?.slug
          ? {
              id: String(e.property),
              title: e.propertySnapshot.title ?? '',
              slug: e.propertySnapshot.slug,
            }
          : null,
    })),
  };
}

export async function getUserDashboard(userId: string, role: UserRole): Promise<UserDashboard> {
  const uid = new Types.ObjectId(userId);
  const [byStatus, leadsTotal, leadsUnseen, user, sent, recent] = await Promise.all([
    Property.aggregate<{ _id: string; n: number }>([
      { $match: { postedBy: uid } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Enquiry.countDocuments({ listingOwner: uid, status: { $ne: 'spam' } }),
    Enquiry.countDocuments({ listingOwner: uid, status: { $ne: 'spam' }, seenByOwner: false }),
    User.findById(uid).select('saved').lean(),
    Enquiry.countDocuments({ user: uid }),
    listLeadsForOwner(userId, 1, 5),
  ]);
  const counts = Object.fromEntries(PROPERTY_STATUSES.map((s) => [s, 0])) as Record<
    PropertyStatus,
    number
  >;
  let total = 0;
  for (const r of byStatus) {
    counts[r._id as PropertyStatus] = r.n;
    total += r.n;
  }
  return {
    listings: { ...counts, total },
    leads: { total: leadsTotal, unseen: leadsUnseen },
    saved: user?.saved?.length ?? 0,
    enquiriesSent: sent,
    listingLimit: await listingLimitFor(userId, role),
    recentLeads: recent.items,
    subscription: await activeSubscription(userId),
    usage: await usageFor(userId, role),
    performance: await performanceFor(uid),
  };
}

/** Daily views and leads for one poster: 14-day series plus 30-day totals vs the 30 days before. */
export async function performanceFor(
  uid: Types.ObjectId,
  now: Date = new Date(),
): Promise<DashboardPerformance> {
  const sixty = lastIndiaDays(60, now);
  const from = sixty[0]!;
  const fromDate = indiaDayStart(from);
  const [viewRows, leadRows] = await Promise.all([
    PropertyViewDay.aggregate<{ _id: string; n: number }>([
      { $match: { owner: uid, day: { $gte: from } } },
      { $group: { _id: '$day', n: { $sum: '$n' } } },
    ]),
    Enquiry.aggregate<{ _id: { day: string; type: string }; n: number }>([
      { $match: { listingOwner: uid, status: { $ne: 'spam' }, createdAt: { $gte: fromDate } } },
      {
        $group: {
          _id: {
            day: {
              $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'Asia/Kolkata' },
            },
            type: '$type',
          },
          n: { $sum: 1 },
        },
      },
    ]),
  ]);
  const views = new Map(viewRows.map((r) => [r._id, r.n]));
  const leads = new Map<string, number>();
  const contacts = new Map<string, number>();
  for (const r of leadRows) {
    leads.set(r._id.day, (leads.get(r._id.day) ?? 0) + r.n);
    if (r._id.type === 'contact') contacts.set(r._id.day, (contacts.get(r._id.day) ?? 0) + r.n);
  }
  const sum = (m: Map<string, number>, days: string[]) =>
    days.reduce((a, d) => a + (m.get(d) ?? 0), 0);
  const prev = sixty.slice(0, 30);
  const last = sixty.slice(30);
  const days = sixty.slice(-14);
  return {
    days,
    views: days.map((d) => views.get(d) ?? 0),
    leads: days.map((d) => leads.get(d) ?? 0),
    views30: sum(views, last),
    viewsPrev30: sum(views, prev),
    leads30: sum(leads, last),
    leadsPrev30: sum(leads, prev),
    leadsToday: leads.get(indiaDay(now)) ?? 0,
    contacts30: sum(contacts, last),
  };
}
