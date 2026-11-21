import type { Types } from 'mongoose';
import { PROPERTY_TYPE_LABELS, type DashboardCharts, type PropertyType } from '@nexus/shared';
import { Property } from '../models/property.model.js';
import { Project } from '../models/project.model.js';
import { Admin, Enquiry, Report } from '../models/misc.models.js';
import { User } from '../models/user.model.js';
import { AdminNotification, SiteVisit } from '../models/admin-panel.models.js';
import { adminRef, recentActivity } from './team.service.js';

const DAY = 86_400_000;
/** India has no daylight saving, so a fixed offset is exact. */
const IST_OFFSET = 330 * 60_000;
const TZ = 'Asia/Kolkata';
const OPEN = ['new', 'contacted', 'qualified'];

/** Midnight IST of the day `daysAgo` days before today. */
export function istDayStart(daysAgo = 0, now = Date.now()) {
  const ist = new Date(now + IST_OFFSET);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET - daysAgo * DAY);
}

const dayKey = (d: Date) => new Date(d.getTime() + IST_OFFSET).toISOString().slice(0, 10);

function dayKeys(from: Date, count: number) {
  return Array.from({ length: count }, (_, i) => dayKey(new Date(from.getTime() + i * DAY)));
}

type Countable = {
  aggregate: (typeof Enquiry)['aggregate'];
};

/** Count documents per IST day; returns an array aligned with `keys`. */
async function perDay(
  model: Countable,
  match: Record<string, unknown>,
  field: string,
  keys: string[],
) {
  const rows = await model.aggregate<{ _id: string; n: number }>([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: `$${field}`, timezone: TZ } },
        n: { $sum: 1 },
      },
    },
  ]);
  const m = new Map(rows.map((r) => [r._id, r.n]));
  return keys.map((k) => m.get(k) ?? 0);
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

export async function getCharts(days: number, includeActivity: boolean): Promise<DashboardCharts> {
  const now = new Date();
  // "Today" still draws a week so the chart has a shape.
  const span = Math.max(days, 7);
  const start = istDayStart(days - 1);
  const prevStart = new Date(start.getTime() - days * DAY);
  const chartStart = istDayStart(span - 1);
  const keys = dayKeys(start, days);
  const chartKeys = dayKeys(chartStart, span);
  const notSpam = { status: { $ne: 'spam' } };
  const todayStart = istDayStart(0);

  const [
    toReviewP,
    toReviewProj,
    newLeads,
    followUpsOverdue,
    visitsToday,
    openReports,
    pendingVerification,
    live,
    newLive,
    leadsSpark,
    leadsPrev,
    closedSpark,
    closedPrev,
    signupSpark,
    signupsPrev,
    byDayRaw,
    pipelineRaw,
    visited,
    uncontacted24h,
    locRaw,
    liveByLocality,
    byType,
    teamRaw,
  ] = await Promise.all([
    Property.countDocuments({ status: 'pending' }),
    Project.countDocuments({ status: 'pending' }),
    Enquiry.countDocuments({ status: 'new' }),
    Enquiry.countDocuments({ followUpAt: { $lte: now }, status: { $in: OPEN } }),
    SiteVisit.countDocuments({
      status: 'scheduled',
      scheduledAt: { $gte: todayStart, $lt: new Date(todayStart.getTime() + DAY) },
    }),
    Report.countDocuments({ status: 'open' }),
    User.countDocuments({
      role: { $in: ['agent', 'builder'] },
      status: 'active',
      verificationStatus: { $in: ['unverified', 'pending'] },
    }),
    Property.countDocuments({ status: 'published' }),
    perDay(Property, { status: 'published', publishedAt: { $gte: start } }, 'publishedAt', keys),
    perDay(Enquiry, { ...notSpam, createdAt: { $gte: start } }, 'createdAt', keys),
    Enquiry.countDocuments({ ...notSpam, createdAt: { $gte: prevStart, $lt: start } }),
    perDay(Enquiry, { status: 'closed', updatedAt: { $gte: start } }, 'updatedAt', keys),
    Enquiry.countDocuments({ status: 'closed', updatedAt: { $gte: prevStart, $lt: start } }),
    perDay(User, { createdAt: { $gte: start } }, 'createdAt', keys),
    User.countDocuments({ createdAt: { $gte: prevStart, $lt: start } }),
    Enquiry.aggregate<{ _id: { d: string; t: string | null }; n: number }>([
      { $match: { ...notSpam, createdAt: { $gte: chartStart } } },
      { $lookup: { from: 'properties', localField: 'property', foreignField: '_id', as: 'p' } },
      {
        $group: {
          _id: {
            d: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TZ } },
            t: { $first: '$p.listingType' },
          },
          n: { $sum: 1 },
        },
      },
    ]),
    Enquiry.aggregate<{ _id: string; n: number }>([
      { $match: { ...notSpam, createdAt: { $gte: start } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SiteVisit.aggregate<{ n: number }>([
      { $match: { status: { $ne: 'cancelled' }, enquiry: { $ne: null } } },
      { $lookup: { from: 'enquiries', localField: 'enquiry', foreignField: '_id', as: 'e' } },
      { $match: { 'e.createdAt': { $gte: start } } },
      { $group: { _id: '$enquiry' } },
      { $count: 'n' },
    ]),
    Enquiry.countDocuments({ status: 'new', createdAt: { $lt: new Date(Date.now() - DAY) } }),
    Enquiry.aggregate<{ _id: { s: string; n: string }; leads: number }>([
      { $match: { ...notSpam, createdAt: { $gte: start }, property: { $ne: null } } },
      { $lookup: { from: 'properties', localField: 'property', foreignField: '_id', as: 'p' } },
      { $unwind: '$p' },
      {
        $group: {
          _id: { s: '$p.localitySlug', n: '$p.localityName' },
          leads: { $sum: 1 },
        },
      },
      { $sort: { leads: -1 } },
      { $limit: 6 },
    ]),
    Property.aggregate<{ _id: string; n: number }>([
      { $match: { status: 'published' } },
      { $group: { _id: '$localitySlug', n: { $sum: 1 } } },
    ]),
    Property.aggregate<{ _id: string; n: number }>([
      { $match: { status: 'published' } },
      { $group: { _id: '$propertyType', n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]),
    Enquiry.aggregate<{ _id: Types.ObjectId; open: number; closed: number }>([
      { $match: { assignedAdmin: { $ne: null }, status: { $ne: 'spam' } } },
      {
        $group: {
          _id: '$assignedAdmin',
          open: { $sum: { $cond: [{ $in: ['$status', OPEN] }, 1, 0] } },
          closed: {
            $sum: {
              $cond: [
                { $and: [{ $eq: ['$status', 'closed'] }, { $gte: ['$updatedAt', start] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  // Live listings over the period: today's count, walked back by what was published each day.
  const liveSpark: number[] = [];
  let running = live;
  for (let i = newLive.length - 1; i >= 0; i--) {
    liveSpark.unshift(running);
    running -= newLive[i]!;
  }

  const byDay = new Map(chartKeys.map((k) => [k, { date: k, buy: 0, rent: 0, other: 0 }]));
  for (const r of byDayRaw) {
    const row = byDay.get(r._id.d);
    if (!row) continue;
    if (r._id.t === 'sale') row.buy += r.n;
    else if (r._id.t === 'rent') row.rent += r.n;
    else row.other += r.n;
  }

  const ps = Object.fromEntries(pipelineRaw.map((r) => [r._id, r.n])) as Record<string, number>;
  const total = sum(Object.values(ps));
  const liveMap = new Map(liveByLocality.map((r) => [r._id, r.n]));

  const admins = await Admin.find({ _id: { $in: teamRaw.map((t) => t._id) } })
    .select('name role')
    .lean();
  const adminMap = new Map(admins.map((a) => [String(a._id), a]));

  return {
    days,
    today: {
      toReview: toReviewP + toReviewProj,
      newLeads,
      followUpsOverdue,
      visitsToday,
      openReports,
      pendingVerification,
    },
    kpis: {
      liveListings: { value: live, previous: Math.max(0, running), spark: liveSpark },
      newLeads: { value: sum(leadsSpark), previous: leadsPrev, spark: leadsSpark },
      closedLeads: { value: sum(closedSpark), previous: closedPrev, spark: closedSpark },
      signups: { value: sum(signupSpark), previous: signupsPrev, spark: signupSpark },
    },
    leadsByDay: [...byDay.values()],
    pipeline: {
      total,
      contacted: total - (ps.new ?? 0),
      visited: visited[0]?.n ?? 0,
      closed: ps.closed ?? 0,
    },
    uncontacted24h,
    localities: locRaw.map((r) => ({
      slug: r._id.s,
      name: r._id.n,
      leads: r.leads,
      live: liveMap.get(r._id.s) ?? 0,
    })),
    listingsByType: byType.map((r) => ({
      type: r._id,
      label: PROPERTY_TYPE_LABELS[r._id as PropertyType] ?? r._id,
      count: r.n,
    })),
    team: teamRaw
      .filter((t) => adminMap.has(String(t._id)))
      .map((t) => ({
        admin: adminRef(adminMap.get(String(t._id))!),
        open: t.open,
        closed: t.closed,
      }))
      .sort((a, b) => b.open - a.open),
    activity: includeActivity ? await recentActivity(6) : [],
  };
}

/** Numbers on the sidebar: work waiting in each queue. */
export async function getBadges(adminId: string) {
  const [review, projects, leads, reports, verification, unread] = await Promise.all([
    Property.countDocuments({ status: 'pending' }),
    Project.countDocuments({ status: 'pending' }),
    Enquiry.countDocuments({ status: 'new' }),
    Report.countDocuments({ status: 'open' }),
    User.countDocuments({
      role: { $in: ['agent', 'builder'] },
      status: 'active',
      verificationStatus: { $in: ['unverified', 'pending'] },
    }),
    AdminNotification.countDocuments({ admin: adminId, read: false }),
  ]);
  return { review, projects, leads, reports, verification, unread };
}
