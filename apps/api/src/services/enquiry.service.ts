import type { FilterQuery, Types } from 'mongoose';
import type { z } from 'zod';
import { Types as MTypes } from 'mongoose';
import {
  PUBLIC_DETAIL_STATUSES,
  normalizePhone,
  type Enquiry as EnquiryDto,
  type ReceivedLead,
  type SentEnquiry,
  type adminEnquiryQuerySchema,
  type enquiryCreateSchema,
  type enquiryUpdateSchema,
} from '@nexus/shared';
import { Enquiry } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { User } from '../models/user.model.js';
import { otpEnabled, env } from '../config/env.js';
import { AppError, badRequest, forbidden, notFound } from '../lib/errors.js';
import type { AuthedUser } from '../middleware/user-auth.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { toCsv } from '../lib/csv.js';
import { nextLeadId } from './support.service.js';
import { getSettings } from './settings.service.js';
import { notifyNewLead, sendMail } from './mail.service.js';

const CONSENT_TEXT =
  'I agree to be contacted by NEXUS Estate by phone, WhatsApp or email about this enquiry.';

/** Submissions faster than this are almost certainly automated. */
const MIN_HUMAN_MS = 2500;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type RequestMeta = { ipHash?: string; userAgent?: string };

type EnquiryLean = {
  _id: Types.ObjectId;
  leadId: string;
  type: EnquiryDto['type'];
  name: string;
  phone: string;
  email?: string | null;
  message: string;
  property?: Types.ObjectId | null;
  propertySnapshot?: { title?: string | null; slug?: string | null } | null;
  sourcePage?: string | null;
  preferredContactTime?: string | null;
  status: EnquiryDto['status'];
  followUpAt?: Date | null;
  assignedTo?: string | null;
  notes: { text: string; by: string; at: Date }[];
  consentAt: Date;
  createdAt: Date;
  updatedAt: Date;
  user?: Types.ObjectId | null;
  listingOwner?: Types.ObjectId | { _id: Types.ObjectId; name: string } | null;
  seenByOwner?: boolean;
};

function ownerRef(o: EnquiryLean['listingOwner']): EnquiryDto['listingOwner'] {
  if (!o) return null;
  if (o instanceof MTypes.ObjectId) return { id: String(o), name: '' };
  return { id: String(o._id), name: o.name };
}

const propertyRef = (e: EnquiryLean) =>
  e.property && e.propertySnapshot?.slug
    ? {
        id: String(e.property),
        title: e.propertySnapshot.title ?? '',
        slug: e.propertySnapshot.slug,
      }
    : null;

function toDto(e: EnquiryLean): EnquiryDto {
  return {
    id: String(e._id),
    leadId: e.leadId,
    type: e.type,
    name: e.name,
    phone: e.phone,
    email: e.email ?? null,
    message: e.message,
    property:
      e.property && e.propertySnapshot?.slug
        ? {
            id: String(e.property),
            title: e.propertySnapshot.title ?? '',
            slug: e.propertySnapshot.slug,
          }
        : null,
    sourcePage: e.sourcePage ?? null,
    preferredContactTime: e.preferredContactTime ?? null,
    status: e.status,
    followUpAt: e.followUpAt ? e.followUpAt.toISOString() : null,
    assignedTo: e.assignedTo ?? null,
    notes: (e.notes ?? []).map((n) => ({
      text: n.text,
      by: n.by,
      at: new Date(n.at).toISOString(),
    })),
    consentAt: e.consentAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    userId: e.user ? String(e.user) : null,
    listingOwner: ownerRef(e.listingOwner),
  };
}

async function requirePhone(raw: string): Promise<string> {
  const settings = await getSettings();
  const phone = normalizePhone(raw, settings.allowInternationalEnquiries);
  if (!phone) {
    throw badRequest('Invalid phone number', {
      phone: [
        settings.allowInternationalEnquiries
          ? 'Enter a 10-digit Indian mobile number, or an international number starting with +'
          : 'Enter a valid 10-digit Indian mobile number',
      ],
    });
  }
  return phone;
}

function looksAutomated(input: { website?: string; elapsedMs?: number }) {
  return (
    Boolean(input.website) || (input.elapsedMs !== undefined && input.elapsedMs < MIN_HUMAN_MS)
  );
}

type EnquiryProperty = {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  postedBy?: Types.ObjectId | null;
};

export async function createEnquiry(
  input: z.output<typeof enquiryCreateSchema>,
  meta: RequestMeta,
  user?: AuthedUser,
): Promise<{ leadId: string; duplicate: boolean }> {
  const phone = await requirePhone(input.phone);

  let property: EnquiryProperty | null = null;
  if (input.propertyId) {
    property = await Property.findOne({
      _id: input.propertyId,
      status: { $in: PUBLIC_DETAIL_STATUSES },
    })
      .select('title slug postedBy')
      .lean<EnquiryProperty>();
  }
  if (user && property?.postedBy && String(property.postedBy) === user.id) {
    throw badRequest('This is your own listing');
  }

  // The same person enquiring twice about the same thing within minutes: keep one lead.
  const recent = await Enquiry.findOne({
    phone,
    property: property?._id ?? null,
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
  })
    .select('leadId')
    .lean();
  if (recent) return { leadId: recent.leadId, duplicate: true };

  const spam = looksAutomated(input);
  const leadId = await nextLeadId('E');
  await Enquiry.create({
    leadId,
    type: property ? 'property' : input.type,
    name: input.name,
    phone,
    email: input.email ?? null,
    message: input.message,
    property: property?._id ?? null,
    propertySnapshot: property ? { title: property.title, slug: property.slug } : undefined,
    sourcePage: input.sourcePage ?? null,
    preferredContactTime: input.preferredContactTime ?? null,
    status: spam ? 'spam' : 'new',
    spamScore: spam ? 100 : 0,
    consentAt: new Date(),
    consentText: CONSENT_TEXT,
    ipHash: meta.ipHash,
    userAgent: meta.userAgent?.slice(0, 300),
    user: user?.id ?? null,
    listingOwner: property?.postedBy ?? null,
  });

  if (!spam && property?.postedBy) {
    void notifyListingOwner(property, input.name, phone, input.message);
  }
  if (!spam) {
    void notifyNewLead(`New enquiry ${leadId}${property ? ` — ${property.title}` : ''}`, {
      'Lead ID': leadId,
      Name: input.name,
      Phone: phone,
      Email: input.email,
      Property: property?.title,
      Message: input.message,
      'Preferred time': input.preferredContactTime,
    });
  }
  return { leadId, duplicate: false };
}

async function notifyListingOwner(
  property: EnquiryProperty,
  name: string,
  phone: string,
  message: string,
) {
  const owner = await User.findById(property.postedBy).select('email name').lean();
  if (!owner) return;
  await sendMail(
    owner.email,
    `New enquiry for ${property.title}`,
    [
      `Hi ${owner.name},`,
      `${name} (${phone}) is interested in “${property.title}”.`,
      ...(message ? [`Message: ${message}`] : []),
    ],
    { label: 'See all your leads', url: `${env.PUBLIC_SITE_URL}/dashboard/leads` },
  );
}

export async function listEnquiries(q: z.output<typeof adminEnquiryQuerySchema>) {
  const f = enquiryFilter(q);
  const [rows, total] = await Promise.all([
    Enquiry.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('listingOwner', 'name')
      .lean<EnquiryLean[]>(),
    Enquiry.countDocuments(f),
  ]);
  return { items: rows.map(toDto), meta: paginate(q.page, q.limit, total) };
}

function enquiryFilter(q: z.output<typeof adminEnquiryQuerySchema>): FilterQuery<EnquiryLean> {
  const f: FilterQuery<EnquiryLean> = {};
  if (q.status) f.status = q.status;
  else f.status = { $ne: 'spam' };
  if (q.type) f.type = q.type;
  if (q.propertyId) f.property = q.propertyId;
  if (q.from || q.to) {
    f.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  if (q.followUpDue) {
    f.followUpAt = { $lte: new Date() };
    f.status = { $in: ['new', 'contacted', 'qualified'] };
  }
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [
      { name: rx },
      { phone: rx },
      { email: rx },
      { leadId: rx },
      { 'propertySnapshot.title': rx },
    ];
  }
  return f;
}

export async function getEnquiry(id: string) {
  const e = await Enquiry.findById(id).populate('listingOwner', 'name').lean<EnquiryLean>();
  if (!e) throw notFound('Enquiry not found');
  return toDto(e);
}

export async function updateEnquiry(
  id: string,
  patch: z.output<typeof enquiryUpdateSchema>,
  by: string,
) {
  const e = await Enquiry.findById(id);
  if (!e) throw notFound('Enquiry not found');
  if (patch.status) e.status = patch.status;
  if (patch.followUpAt !== undefined) e.followUpAt = patch.followUpAt;
  if (patch.assignedTo !== undefined) e.assignedTo = patch.assignedTo || null;
  if (patch.note) e.notes.push({ text: patch.note, by, at: new Date() });
  await e.save();
  return toDto(e.toObject() as unknown as EnquiryLean);
}

export async function exportEnquiriesCsv(
  q: z.output<typeof adminEnquiryQuerySchema>,
): Promise<string> {
  const rows = await Enquiry.find(enquiryFilter(q))
    .sort({ createdAt: -1 })
    .limit(10_000)
    .lean<EnquiryLean[]>();
  return toCsv(
    [
      'Lead ID',
      'Created',
      'Status',
      'Type',
      'Name',
      'Phone',
      'Email',
      'Property',
      'Message',
      'Follow-up',
      'Assigned to',
      'Latest note',
    ],
    rows.map((e) => [
      e.leadId,
      e.createdAt.toISOString(),
      e.status,
      e.type,
      e.name,
      e.phone,
      e.email,
      e.propertySnapshot?.title,
      e.message,
      e.followUpAt?.toISOString(),
      e.assignedTo,
      e.notes.at(-1)?.text,
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* Website users                                                       */
/* ------------------------------------------------------------------ */

/** Leads received on listings the user posted. */
export async function listLeadsForOwner(userId: string, page = 1, limit = 20, unseenOnly = false) {
  const f: FilterQuery<EnquiryLean> = {
    listingOwner: new MTypes.ObjectId(userId),
    status: { $ne: 'spam' },
    ...(unseenOnly ? { seenByOwner: false } : {}),
  };
  const [rows, total] = await Promise.all([
    Enquiry.find(f)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<EnquiryLean[]>(),
    Enquiry.countDocuments(f),
  ]);
  const items: ReceivedLead[] = rows.map((e) => ({
    id: String(e._id),
    leadId: e.leadId,
    type: e.type,
    name: e.name,
    phone: e.phone,
    email: e.email ?? null,
    message: e.message,
    property: propertyRef(e),
    createdAt: e.createdAt.toISOString(),
    seen: Boolean(e.seenByOwner),
  }));
  return { items, meta: paginate(page, limit, total) };
}

export async function markLeadsSeen(userId: string, ids?: string[]) {
  await Enquiry.updateMany(
    {
      listingOwner: new MTypes.ObjectId(userId),
      ...(ids?.length ? { _id: { $in: ids.filter((i) => /^[a-f0-9]{24}$/i.test(i)) } } : {}),
    },
    { $set: { seenByOwner: true } },
  );
}

/** Enquiries the signed-in user sent. Only their own message is shown back. */
export async function listSentEnquiries(userId: string, page = 1, limit = 20) {
  const f = { user: new MTypes.ObjectId(userId) };
  const [rows, total] = await Promise.all([
    Enquiry.find(f)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<EnquiryLean[]>(),
    Enquiry.countDocuments(f),
  ]);
  const items: SentEnquiry[] = rows.map((e) => ({
    id: String(e._id),
    leadId: e.leadId,
    type: e.type,
    message: e.message,
    property: propertyRef(e),
    createdAt: e.createdAt.toISOString(),
  }));
  return { items, meta: paginate(page, limit, total) };
}

const REVEALS_PER_DAY = 40;

/**
 * Shows a listing poster's phone number to a signed-in visitor and records it as
 * a lead for the poster. Limited per day to stop number scraping.
 */
export async function revealContact(propertyId: string, viewer: AuthedUser, meta: RequestMeta) {
  const property = await Property.findOne({ _id: propertyId, status: 'published' })
    .select('title slug postedBy')
    .lean<EnquiryProperty>();
  if (!property) throw notFound('Property not found');
  if (!property.postedBy) {
    throw badRequest('Contact NEXUS Estate directly for this property');
  }
  if (String(property.postedBy) === viewer.id) throw badRequest('This is your own listing');
  if (otpEnabled && !viewer.phoneVerified) {
    throw new AppError(
      403,
      'PHONE_NOT_VERIFIED',
      'Verify your mobile number to see contact details.',
    );
  }
  const poster = await User.findById(property.postedBy)
    .select('name companyName phone showPhone whatsappEnabled status role')
    .lean();
  if (!poster || poster.status !== 'active') throw notFound('This poster is no longer available');
  if (!poster.showPhone) {
    throw forbidden('This poster prefers to be contacted through the enquiry form.');
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const already = await Enquiry.findOne({
    user: viewer.id,
    property: property._id,
    type: 'contact',
  })
    .select('_id')
    .lean();
  if (!already) {
    const today = await Enquiry.countDocuments({
      user: viewer.id,
      type: 'contact',
      createdAt: { $gte: dayAgo },
    });
    if (today >= REVEALS_PER_DAY) {
      throw new AppError(
        429,
        'RATE_LIMITED',
        'You have viewed many contacts today. Try again tomorrow.',
      );
    }
    await Enquiry.create({
      leadId: await nextLeadId('E'),
      type: 'contact',
      name: viewer.name,
      phone: viewer.phone,
      email: viewer.email,
      message: 'Viewed your contact details.',
      property: property._id,
      propertySnapshot: { title: property.title, slug: property.slug },
      sourcePage: `/properties/${property.slug}`,
      status: 'new',
      consentAt: new Date(),
      consentText: 'Signed-in user viewed contact details',
      ipHash: meta.ipHash,
      userAgent: meta.userAgent?.slice(0, 300),
      user: viewer.id,
      listingOwner: property.postedBy,
    });
  }
  return {
    name: poster.role === 'individual' ? poster.name : poster.companyName || poster.name,
    contactPerson: poster.name,
    phone: poster.phone,
    whatsapp: poster.whatsappEnabled ? poster.phone : null,
  };
}
