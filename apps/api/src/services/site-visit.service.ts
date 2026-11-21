import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import {
  normalizePhone,
  type SiteVisit as SiteVisitDto,
  type siteVisitCreateSchema,
  type siteVisitQuerySchema,
  type siteVisitUpdateSchema,
} from '@nexus/shared';
import { Admin, Enquiry } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { SiteVisit } from '../models/admin-panel.models.js';
import { badRequest, notFound } from '../lib/errors.js';
import { paginate } from '../lib/respond.js';
import { adminRef } from './team.service.js';
import { businessAlert, notifyAdmins } from './notification.service.js';

type VisitLean = {
  _id: Types.ObjectId;
  name: string;
  phone: string;
  scheduledAt: Date;
  status: SiteVisitDto['status'];
  enquiry?: Types.ObjectId | null;
  leadId?: string | null;
  property?: Types.ObjectId | null;
  propertySnapshot?: { title?: string | null; slug?: string | null } | null;
  assignedAdmin?: { _id: Types.ObjectId; name: string; role: string } | null;
  outcome?: string | null;
  notes: { text: string; by: string; at: Date }[];
  createdBy: string;
  createdAt: Date;
};

const toDto = (v: VisitLean): SiteVisitDto => ({
  id: String(v._id),
  name: v.name,
  phone: v.phone,
  scheduledAt: v.scheduledAt.toISOString(),
  status: v.status,
  enquiry: v.enquiry ? { id: String(v.enquiry), leadId: v.leadId ?? '' } : null,
  property:
    v.property && v.propertySnapshot?.slug
      ? {
          id: String(v.property),
          title: v.propertySnapshot.title ?? '',
          slug: v.propertySnapshot.slug,
        }
      : null,
  assignedAdmin: v.assignedAdmin ? adminRef(v.assignedAdmin) : null,
  outcome: v.outcome ?? null,
  notes: (v.notes ?? []).map((n) => ({ text: n.text, by: n.by, at: new Date(n.at).toISOString() })),
  createdBy: v.createdBy,
  createdAt: v.createdAt.toISOString(),
});

async function getVisit(id: string) {
  const v = await SiteVisit.findById(id).populate('assignedAdmin', 'name role').lean<VisitLean>();
  if (!v) throw notFound('Site visit not found');
  return toDto(v);
}

async function activeAdmin(id: string) {
  const a = await Admin.findOne({ _id: id, active: true }).select('name').lean();
  if (!a) throw badRequest('Choose an active team member', { assignedAdminId: ['Not found'] });
  return a;
}

export async function listVisits(q: z.output<typeof siteVisitQuerySchema>, adminId: string) {
  const f: FilterQuery<VisitLean> = {};
  if (q.from || q.to)
    f.scheduledAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.status) f.status = q.status;
  if (q.enquiryId) f.enquiry = new Types.ObjectId(q.enquiryId);
  if (q.assignee === 'none') f.assignedAdmin = null;
  else if (q.assignee === 'me') f.assignedAdmin = new Types.ObjectId(adminId);
  else if (q.assignee) f.assignedAdmin = new Types.ObjectId(q.assignee);
  const [rows, total] = await Promise.all([
    SiteVisit.find(f)
      .sort({ scheduledAt: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('assignedAdmin', 'name role')
      .lean<VisitLean[]>(),
    SiteVisit.countDocuments(f),
  ]);
  return { items: rows.map(toDto), meta: paginate(q.page, q.limit, total) };
}

export async function createVisit(
  input: z.output<typeof siteVisitCreateSchema>,
  by: { id: string; name: string },
) {
  const phone = normalizePhone(input.phone, true);
  if (!phone) throw badRequest('Invalid phone number', { phone: ['Enter a valid mobile number'] });

  let enquiry: { _id: Types.ObjectId; leadId: string; property?: Types.ObjectId | null } | null =
    null;
  if (input.enquiryId) {
    enquiry = await Enquiry.findById(input.enquiryId).select('leadId property').lean();
    if (!enquiry) throw notFound('Enquiry not found');
  }
  const propertyId = input.propertyId ?? (enquiry?.property ? String(enquiry.property) : null);
  const property = propertyId
    ? await Property.findById(propertyId).select('title slug').lean()
    : null;
  if (propertyId && !property) throw notFound('Property not found');
  const assignee = input.assignedAdminId ? await activeAdmin(input.assignedAdminId) : null;

  const v = await SiteVisit.create({
    name: input.name,
    phone,
    scheduledAt: input.scheduledAt,
    enquiry: enquiry?._id ?? null,
    leadId: enquiry?.leadId ?? null,
    property: property?._id ?? null,
    propertySnapshot: property ? { title: property.title, slug: property.slug } : undefined,
    assignedAdmin: assignee?._id ?? null,
    notes: input.note ? [{ text: input.note, by: by.name, at: new Date() }] : [],
    createdBy: by.name,
  });

  // A booked visit means the lead was reached.
  if (enquiry) {
    await Enquiry.updateOne(
      { _id: enquiry._id },
      {
        $push: {
          notes: {
            text: `Site visit booked for ${input.scheduledAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
            by: by.name,
            at: new Date(),
          },
        },
      },
    );
    await Enquiry.updateOne(
      { _id: enquiry._id, status: 'new' },
      { $set: { status: 'contacted', contactedAt: new Date() } },
    );
  }

  const when = input.scheduledAt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  void businessAlert('visit', {
    title: `Site visit: ${input.name}, ${when}`,
    body: property?.title ?? '',
    link: '/admin/visits',
  });
  if (assignee && String(assignee._id) !== by.id) {
    void notifyAdmins({
      kind: 'assigned',
      to: [assignee._id],
      title: `${by.name} gave you a site visit: ${input.name}`,
      body: `${when}${property ? ` · ${property.title}` : ''}`,
      link: '/admin/visits',
    });
  }
  return getVisit(String(v._id));
}

export async function updateVisit(
  id: string,
  patch: z.output<typeof siteVisitUpdateSchema>,
  by: { id: string; name: string },
) {
  const v = await SiteVisit.findById(id);
  if (!v) throw notFound('Site visit not found');
  const changes: string[] = [];
  if (patch.scheduledAt) {
    v.scheduledAt = patch.scheduledAt;
    changes.push('rescheduled');
  }
  if (patch.status) {
    v.status = patch.status;
    changes.push(patch.status);
  }
  if (patch.outcome !== undefined) v.outcome = patch.outcome || null;
  if (patch.assignedAdminId !== undefined) {
    if (patch.assignedAdminId) {
      const a = await activeAdmin(patch.assignedAdminId);
      v.assignedAdmin = a._id;
      if (String(a._id) !== by.id)
        void notifyAdmins({
          kind: 'assigned',
          to: [a._id],
          title: `${by.name} gave you a site visit: ${v.name}`,
          link: '/admin/visits',
        });
    } else v.assignedAdmin = null;
  }
  if (patch.note) v.notes.push({ text: patch.note, by: by.name, at: new Date() });
  await v.save();
  // A visit that happened moves its lead forward and records the outcome there too.
  if (patch.status === 'done' && v.enquiry) {
    await Enquiry.updateOne(
      { _id: v.enquiry, status: { $in: ['new', 'contacted'] } },
      { $set: { status: 'qualified' } },
    );
    await Enquiry.updateOne(
      { _id: v.enquiry },
      {
        $push: {
          notes: {
            text: `Site visit done${v.outcome ? `: ${v.outcome}` : ''}`,
            by: by.name,
            at: new Date(),
          },
        },
      },
    );
  }
  return { visit: await getVisit(id), changes };
}

export async function deleteVisit(id: string) {
  const v = await SiteVisit.findByIdAndDelete(id).lean();
  if (!v) throw notFound('Site visit not found');
  return { name: v.name };
}
