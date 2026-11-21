import type { z } from 'zod';
import type { Types } from 'mongoose';
import type {
  ListingReport,
  ReportReason,
  ReportStatus,
  adminReportQuerySchema,
  reportCreateSchema,
} from '@nexus/shared';
import { Report } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { notFound } from '../lib/errors.js';
import { paginate } from '../lib/respond.js';
import type { AuthedUser } from '../middleware/user-auth.js';
import { notifyNewLead } from './mail.service.js';
import { businessAlert } from './notification.service.js';

type ReportLean = {
  _id: Types.ObjectId;
  property: Types.ObjectId;
  propertySnapshot?: { title?: string | null; slug?: string | null } | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  user?: Types.ObjectId | null;
  reporterName?: string | null;
  note?: string | null;
  createdAt: Date;
};

function toDto(r: ReportLean): ListingReport {
  return {
    id: String(r._id),
    property: r.propertySnapshot?.slug
      ? {
          id: String(r.property),
          title: r.propertySnapshot.title ?? '',
          slug: r.propertySnapshot.slug,
        }
      : null,
    reason: r.reason,
    details: r.details,
    status: r.status,
    reporter: { name: r.reporterName ?? null, userId: r.user ? String(r.user) : null },
    note: r.note ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

/** One open report per listing per visitor per day; repeats are accepted silently. */
export async function createReport(
  input: z.output<typeof reportCreateSchema>,
  meta: { ipHash?: string },
  user?: AuthedUser,
) {
  if (input.website) return;
  const p = await Property.findOne({ _id: input.propertyId, status: 'published' })
    .select('title slug')
    .lean();
  if (!p) throw notFound('Property not found');
  const dup = await Report.exists({
    property: p._id,
    ...(user ? { user: user.id } : { ipHash: meta.ipHash }),
    createdAt: { $gte: new Date(Date.now() - 86_400_000) },
  });
  if (dup) return;
  await Report.create({
    property: p._id,
    propertySnapshot: { title: p.title, slug: p.slug },
    reason: input.reason,
    details: input.details,
    user: user?.id ?? null,
    reporterName: user?.name ?? null,
    ipHash: meta.ipHash,
  });
  void businessAlert(
    'report',
    { title: `Listing reported: ${p.title}`, body: input.reason, link: '/admin/reports' },
    { skipEmail: true },
  );
  void notifyNewLead(`Listing reported: ${p.title}`, {
    Reason: input.reason,
    Details: input.details,
    Listing: p.slug,
  });
}

export async function listReports(q: z.output<typeof adminReportQuerySchema>) {
  const f = q.status ? { status: q.status } : {};
  const [rows, total] = await Promise.all([
    Report.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ReportLean[]>(),
    Report.countDocuments(f),
  ]);
  return { items: rows.map(toDto), meta: paginate(q.page, q.limit, total) };
}

export async function updateReport(id: string, status: ReportStatus, by: string, note?: string) {
  const r = await Report.findById(id);
  if (!r) throw notFound('Report not found');
  r.status = status;
  if (note !== undefined) r.note = note || null;
  r.resolvedBy = by;
  await r.save();
  return toDto(r.toObject() as unknown as ReportLean);
}

export async function openReportCount() {
  return Report.countDocuments({ status: 'open' });
}
