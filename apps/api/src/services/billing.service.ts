import crypto from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import {
  AUTOPAY_GRACE_DAYS,
  DEFAULT_PLAN,
  FEATURE_ADDONS,
  FREE_LEADS_PER_MONTH,
  LISTING_LIMITS,
  PLAN_REMINDER_DAYS,
  type AutopayCheckout,
  type AutopayStatus,
  type CheckoutOrder,
  type MyAutopay,
  type FeatureAddonDays,
  type PlanUsage,
  type MySubscription,
  type Payment as PaymentDto,
  type PaymentInvoice,
  type PaymentSummary,
  type Plan as PlanDto,
  type UserRole,
  type manualPaymentSchema,
  type paymentQuerySchema,
  type planSchema,
  type planUpdateSchema,
} from '@nexus/shared';
import { env, razorpayEnabled } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppError, badRequest, notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { Autopay, Payment, Plan } from '../models/admin-panel.models.js';
import { User } from '../models/user.model.js';
import { Property } from '../models/property.model.js';
import { City, Counter, Enquiry } from '../models/misc.models.js';
import { businessAlert, sendWhatsApp } from './notification.service.js';
import { sendMail } from './mail.service.js';
import { getSettings } from './settings.service.js';

const DAY = 86_400_000;

/* ---------------- Plans ---------------- */

type PlanLean = {
  _id: Types.ObjectId;
  name: string;
  description?: string | null;
  price: number;
  durationDays: number;
  listingLimit: number;
  featuredListings?: number | null;
  featuredDays?: number | null;
  leadLimit?: number | null;
  mrp?: number | null;
  searchRank?: number | null;
  partnerBadge?: boolean | null;
  autoRefreshDays?: number | null;
  recommended?: boolean | null;
  roles: string[];
  active: boolean;
  sortOrder?: number | null;
};

const toPlan = (p: PlanLean): PlanDto => ({
  id: String(p._id),
  name: p.name,
  description: p.description ?? '',
  price: p.price,
  durationDays: p.durationDays,
  listingLimit: p.listingLimit,
  featuredListings: p.featuredListings ?? 0,
  featuredDays: p.featuredDays ?? 7,
  leadLimit: p.leadLimit ?? 0,
  mrp: p.mrp ?? 0,
  searchRank: p.searchRank ?? 0,
  partnerBadge: p.partnerBadge ?? false,
  autoRefreshDays: p.autoRefreshDays ?? 0,
  recommended: p.recommended ?? false,
  roles: p.roles as UserRole[],
  active: p.active,
  sortOrder: p.sortOrder ?? 0,
});

export async function listPlans(onlyActive = false, role?: UserRole) {
  const rows = await Plan.find({
    ...(onlyActive ? { active: true } : {}),
    ...(role ? { roles: role } : {}),
  })
    .sort({ sortOrder: 1, price: 1 })
    .lean<PlanLean[]>();
  return rows.map(toPlan);
}

/**
 * The admin's free (₹0) plan for this account type, if there is one. It is on for every
 * such user who has no paid plan running: nothing to buy, no payment, no end date.
 * With several, the first in admin order wins.
 */
export async function freePlanFor(role: UserRole) {
  return Plan.findOne({ active: true, price: 0, roles: role })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean<PlanLean>();
}

/** Creates the ₹599 Premium plan the first time the API starts with no plans at all. */
export async function ensureDefaultPlan() {
  if (await Plan.exists({})) return false;
  await Plan.create({
    ...DEFAULT_PLAN,
    roles: [...DEFAULT_PLAN.roles],
    active: true,
    sortOrder: 0,
  });
  logger.info('Default Premium plan created');
  return true;
}

const snapshotOf = (plan: PlanLean) => ({
  name: plan.name,
  durationDays: plan.durationDays,
  listingLimit: plan.listingLimit,
  featuredListings: plan.featuredListings ?? 0,
  featuredDays: plan.featuredDays ?? 7,
  leadLimit: plan.leadLimit ?? 0,
  searchRank: plan.searchRank ?? 0,
  partnerBadge: plan.partnerBadge ?? false,
  autoRefreshDays: plan.autoRefreshDays ?? 0,
});

/** Only one plan can be "Most chosen": marking one clears the rest. */
async function keepOneRecommended(id: Types.ObjectId | string) {
  await Plan.updateMany({ _id: { $ne: id }, recommended: true }, { $set: { recommended: false } });
}

export async function createPlan(input: z.output<typeof planSchema>) {
  const p = await Plan.create(input);
  if (input.recommended) await keepOneRecommended(p._id);
  return toPlan(p.toObject() as unknown as PlanLean);
}

export async function updatePlan(id: string, patch: z.output<typeof planUpdateSchema>) {
  const p = await Plan.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<PlanLean>();
  if (!p) throw notFound('Plan not found');
  if (patch.recommended) await keepOneRecommended(p._id);
  return toPlan(p);
}

/* ---------------- Payments & subscriptions ---------------- */

type PaymentLean = {
  _id: Types.ObjectId;
  user?: { _id: Types.ObjectId; name: string; role: string; phone: string } | null;
  kind?: 'plan' | 'featured' | null;
  plan?: Types.ObjectId | null;
  property?: { _id: Types.ObjectId; title: string; slug: string } | Types.ObjectId | null;
  postsUsed?: number | null;
  planSnapshot: {
    name: string;
    durationDays: number;
    listingLimit: number;
    featuredListings?: number | null;
    featuredDays?: number | null;
    leadLimit?: number | null;
    searchRank?: number | null;
    partnerBadge?: boolean | null;
    autoRefreshDays?: number | null;
  };
  amount: number;
  status: PaymentDto['status'];
  method: PaymentDto['method'];
  orderId?: string | null;
  paymentId?: string | null;
  reference?: string | null;
  note?: string | null;
  recordedBy?: string | null;
  paidAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  invoiceNo?: string | null;
  subscriptionId?: string | null;
  createdAt: Date;
};

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

const planRef = (p: PaymentLean) => ({
  id: p.plan ? String(p.plan) : '',
  name: p.planSnapshot.name,
  durationDays: p.planSnapshot.durationDays,
  listingLimit: p.planSnapshot.listingLimit,
  featuredListings: p.planSnapshot.featuredListings ?? 0,
  featuredDays: p.planSnapshot.featuredDays ?? 7,
  leadLimit: p.planSnapshot.leadLimit ?? 0,
  searchRank: p.planSnapshot.searchRank ?? 0,
  partnerBadge: p.planSnapshot.partnerBadge ?? false,
  autoRefreshDays: p.planSnapshot.autoRefreshDays ?? 0,
});

const propertyRefOf = (p: PaymentLean['property']) =>
  p && 'title' in p ? { id: String(p._id), title: p.title, slug: p.slug } : null;

const toPayment = (p: PaymentLean): PaymentDto => ({
  id: String(p._id),
  kind: p.kind ?? 'plan',
  property: propertyRefOf(p.property),
  user: p.user
    ? {
        id: String(p.user._id),
        name: p.user.name,
        role: p.user.role as UserRole,
        phone: p.user.phone,
      }
    : null,
  plan: planRef(p),
  amount: p.amount,
  status: p.status,
  method: p.method,
  orderId: p.orderId ?? null,
  paymentId: p.paymentId ?? null,
  reference: p.reference ?? null,
  note: p.note ?? null,
  recordedBy: p.recordedBy ?? null,
  paidAt: iso(p.paidAt),
  startsAt: iso(p.startsAt),
  endsAt: iso(p.endsAt),
  invoiceNo: p.invoiceNo ?? null,
  autopay: Boolean(p.subscriptionId),
  createdAt: p.createdAt.toISOString(),
});

async function getPayment(id: Types.ObjectId | string) {
  const p = await Payment.findById(id)
    .populate('user', 'name role phone')
    .populate('property', 'title slug')
    .lean<PaymentLean>();
  if (!p) throw notFound('Payment not found');
  return toPayment(p);
}

export async function listPayments(q: z.output<typeof paymentQuerySchema>) {
  const f: FilterQuery<PaymentLean> = {};
  if (q.status) f.status = q.status;
  else f.status = { $ne: 'created' };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const users = await User.find({ $or: [{ name: rx }, { phone: rx }, { companyName: rx }] })
      .select('_id')
      .limit(200)
      .lean();
    f.$or = [
      { user: { $in: users.map((u) => u._id) } },
      { reference: rx },
      { paymentId: rx },
      { 'planSnapshot.name': rx },
    ];
  }
  const [rows, total] = await Promise.all([
    Payment.find(f)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate('user', 'name role phone')
      .populate('property', 'title slug')
      .lean<PaymentLean[]>(),
    Payment.countDocuments(f),
  ]);
  return { items: rows.map(toPayment), meta: paginate(q.page, q.limit, total) };
}

/** Featured payments are not subscriptions. Older payments have no kind. */
const PLAN_ONLY = { kind: { $ne: 'featured' } } as const;

export async function paymentSummary(): Promise<PaymentSummary> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [rows, active] = await Promise.all([
    Payment.aggregate<{ _id: boolean; total: number }>([
      { $match: { status: 'paid', paidAt: { $gte: lastMonthStart } } },
      { $group: { _id: { $gte: ['$paidAt', monthStart] }, total: { $sum: '$amount' } } },
    ]),
    Payment.distinct('user', { ...PLAN_ONLY, status: 'paid', endsAt: { $gt: now } }),
  ]);
  return {
    thisMonth: rows.find((r) => r._id === true)?.total ?? 0,
    lastMonth: rows.find((r) => r._id === false)?.total ?? 0,
    activeSubscriptions: active.length,
    onlineEnabled: razorpayEnabled,
  };
}

/* ---------------- Invoices ---------------- */

/** Indian financial year of a date, e.g. "2026-27" (April to March, India time). */
export function financialYear(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

/** Next invoice number in the payment's financial year: NX/2026-27/0001, NX/2026-27/0002 … */
async function nextInvoiceNo(paidAt: Date) {
  const fy = financialYear(paidAt);
  const c = await Counter.findOneAndUpdate(
    { _id: `INV-${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true },
  ).lean();
  return `NX/${fy}/${String(c!.seq).padStart(4, '0')}`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number) {
  return n < 20 ? ONES[n]! : [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
}

function belowThousand(n: number) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Whole rupees in Indian words: 1,23,456 → "One Lakh Twenty Three Thousand Four Hundred Fifty Six". */
export function rupeesInWords(amount: number) {
  let n = Math.round(amount);
  if (n === 0) return 'Rupees Zero Only';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return `Rupees ${parts.join(' ')} Only`;
}

const GST_RATE = 18;
const paise = (n: number) => Math.round(n * 100) / 100;

/** Splits a GST-inclusive total into value before tax and the tax parts. */
export function gstBreakup(total: number, sameState: boolean) {
  const taxable = paise(total / (1 + GST_RATE / 100));
  const tax = paise(total - taxable);
  if (!sameState) return { taxable, cgst: 0, sgst: 0, igst: tax };
  const cgst = paise(tax / 2);
  return { taxable, cgst, sgst: paise(tax - cgst), igst: 0 };
}

const sameText = (a?: string | null, b?: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The invoice for one paid (or refunded) payment. With `userId` the payment must be that
 * user's own. Older payments get their invoice number the first time it is opened.
 */
export async function paymentInvoice(id: string, userId?: string): Promise<PaymentInvoice> {
  const p = await Payment.findOne({ _id: id, ...(userId ? { user: userId } : {}) });
  if (!p || (p.status !== 'paid' && p.status !== 'refunded')) throw notFound('Invoice not found');
  const paidAt = p.paidAt ?? (p as unknown as { createdAt: Date }).createdAt;
  if (!p.invoiceNo) {
    p.invoiceNo = await nextInvoiceNo(paidAt);
    await p.save();
  }
  const [settings, user, property] = await Promise.all([
    getSettings(),
    User.findById(p.user).select('name phone email companyName citySlug').lean(),
    p.property ? Property.findById(p.property).select('title').lean() : null,
  ]);
  const city = user?.citySlug
    ? await City.findOne({ slug: user.citySlug }).select('name state').lean()
    : null;
  const inv = settings.invoice;
  const gstin = inv.gstin ?? null;
  // Buyers with no city on file are taken as local: the site serves Jaipur today.
  const sameState = !city || sameText(city.state, inv.state);
  const taxed = gstin
    ? gstBreakup(p.amount, sameState)
    : { taxable: p.amount, cgst: 0, sgst: 0, igst: 0 };
  const snap = p.planSnapshot;
  const featured = p.kind === 'featured';
  const sellerAddress =
    inv.address ||
    [settings.address.line1, settings.address.line2, settings.address.city, settings.address.state]
      .filter(Boolean)
      .join(', ');
  return {
    number: p.invoiceNo!,
    kind: gstin ? 'tax-invoice' : 'receipt',
    date: paidAt.toISOString(),
    status: p.status as 'paid' | 'refunded',
    seller: {
      name: settings.businessName,
      legalName: inv.legalName || settings.businessName,
      gstin,
      address: sellerAddress,
      state: inv.state,
      phone: settings.phone,
      email: settings.email ?? null,
    },
    buyer: {
      name: user?.name ?? 'Customer',
      company: user?.companyName || null,
      phone: user?.phone ?? '',
      email: user?.email ?? null,
      city: city?.name ?? null,
      state: city?.state ?? null,
    },
    item: {
      description: featured
        ? `${snap?.name ?? 'Featured listing'}`
        : `${snap?.name ?? 'Membership'} plan · ${snap?.durationDays ?? 30} days`,
      detail: featured
        ? (property?.title ?? null)
        : `Up to ${snap?.listingLimit ?? 0} live listings at a time`,
      sacCode: inv.sacCode || null,
      from: p.startsAt ? p.startsAt.toISOString() : null,
      to: p.endsAt ? p.endsAt.toISOString() : null,
    },
    total: p.amount,
    taxable: taxed.taxable,
    gstRate: gstin ? GST_RATE : 0,
    cgst: taxed.cgst,
    sgst: taxed.sgst,
    igst: taxed.igst,
    totalInWords: rupeesInWords(p.amount),
    payment: {
      method: p.method as PaymentInvoice['payment']['method'],
      paymentId: p.paymentId ?? null,
      orderId: p.orderId ?? null,
      reference: p.reference ?? null,
    },
  };
}

/** A new plan starts when the current one ends, so renewing early never loses days. */
async function periodFor(userId: Types.ObjectId, durationDays: number, startFrom?: Date | null) {
  if (startFrom)
    return { startsAt: startFrom, endsAt: new Date(startFrom.getTime() + durationDays * DAY) };
  const current = await Payment.findOne({
    ...PLAN_ONLY,
    user: userId,
    status: 'paid',
    endsAt: { $gt: new Date() },
  })
    .sort({ endsAt: -1 })
    .select('endsAt')
    .lean();
  const startsAt = current?.endsAt ?? new Date();
  return { startsAt, endsAt: new Date(startsAt.getTime() + durationDays * DAY) };
}

async function markPaid(
  payment: InstanceType<typeof Payment>,
  extra: { paymentId?: string; recordedBy?: string; startFrom?: Date | null },
) {
  if (payment.kind === 'featured') return markFeaturedPaid(payment, extra);
  const { startsAt, endsAt } = await periodFor(
    payment.user as Types.ObjectId,
    payment.planSnapshot!.durationDays!,
    extra.startFrom,
  );
  payment.status = 'paid';
  payment.paidAt = new Date();
  payment.startsAt = startsAt;
  payment.endsAt = endsAt;
  payment.invoiceNo ??= await nextInvoiceNo(payment.paidAt);
  if (extra.paymentId) payment.paymentId = extra.paymentId;
  if (extra.recordedBy) payment.recordedBy = extra.recordedBy;
  await payment.save();
  await syncPremium(payment.user as Types.ObjectId);
  await syncPlanPerksFor(String(payment.user));
  await unlockLeads(payment.user as Types.ObjectId);
  await releaseAwaitingListings(String(payment.user));
  const user = await User.findById(payment.user).select('name email').lean();
  void businessAlert('payment', {
    title: `Payment ₹${payment.amount.toLocaleString('en-IN')} from ${user?.name ?? 'a user'}`,
    body: `${payment.planSnapshot!.name} plan · ${payment.subscriptionId ? 'auto-renew' : payment.method === 'online' ? 'online' : 'recorded by hand'}`,
    link: '/admin/payments',
    to: 'super',
  });
  if (user)
    void sendMail(
      user.email,
      `Your ${payment.planSnapshot!.name} plan is active`,
      [
        `Hi ${user.name},`,
        `We received ₹${payment.amount.toLocaleString('en-IN')} for the ${payment.planSnapshot!.name} plan.`,
        `It is active until ${endsAt.toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}.`,
      ],
      { label: 'Open your dashboard', url: `${env.PUBLIC_SITE_URL}/dashboard` },
    );
}

/** Cash, UPI or bank transfer taken outside the site. Super Admins only. */
export async function recordManualPayment(input: z.output<typeof manualPaymentSchema>, by: string) {
  const [user, plan] = await Promise.all([
    User.findById(input.userId).select('role').lean(),
    Plan.findById(input.planId).lean<PlanLean>(),
  ]);
  if (!user) throw notFound('User not found');
  if (!plan) throw notFound('Plan not found');
  if (!plan.roles.includes(user.role))
    throw badRequest('This plan is not for this type of account');
  if (plan.price <= 0) throw badRequest('This plan is free and turns on by itself');
  const p = await Payment.create({
    user: user._id,
    plan: plan._id,
    planSnapshot: snapshotOf(plan),
    amount: input.amount,
    method: 'manual',
    reference: input.reference || null,
    note: input.note || null,
  });
  await markPaid(p, { recordedBy: by });
  return getPayment(p._id);
}

/** Marks a paid payment refunded and ends its plan now. Money goes back outside the site. */
export async function refundPayment(id: string, by: string) {
  const p = await Payment.findById(id);
  if (!p) throw notFound('Payment not found');
  if (p.status !== 'paid') throw badRequest('Only paid payments can be refunded');
  p.status = 'refunded';
  p.note = [p.note, `Refunded by ${by}`].filter(Boolean).join(' · ');
  if (p.endsAt && p.endsAt > new Date()) p.endsAt = new Date();
  await p.save();
  if (p.kind === 'featured' && p.property)
    await Property.updateOne(
      { _id: p.property },
      { $set: { featured: false, featuredUntil: null } },
    );
  await syncPremium(p.user as Types.ObjectId);
  await syncPlanPerksFor(String(p.user));
  return getPayment(p._id);
}

/** The paid plan payment covering right now, if any. */
async function currentPlanPayment(userId: string) {
  const now = new Date();
  return Payment.findOne({
    ...PLAN_ONLY,
    user: userId,
    status: 'paid',
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  })
    .sort({ endsAt: -1 })
    .lean<PaymentLean>();
}

export async function activeSubscription(userId: string): Promise<MySubscription> {
  const now = new Date();
  const p = await Payment.findOne({
    ...PLAN_ONLY,
    user: userId,
    status: 'paid',
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  })
    .sort({ endsAt: -1 })
    .lean<PaymentLean>();
  if (!p) return null;
  return { plan: planRef(p), startsAt: p.startsAt!.toISOString(), endsAt: p.endsAt!.toISOString() };
}

/** Statuses that hold a plan slot: listings that are live or waiting for review. */
export const ACTIVE_LISTING_STATUSES = ['published', 'pending'] as const;

/** How many of the user's listings are live or in review right now (optionally leaving one out). */
export async function activeListingCount(userId: string, exceptId?: string) {
  return Property.countDocuments({
    postedBy: userId,
    status: { $in: [...ACTIVE_LISTING_STATUSES] },
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
  });
}

/** The listing limit of the plan covering right now, or null with no plan on. */
export async function currentPlanListingLimit(userId: string) {
  const pay = await currentPlanPayment(userId);
  return pay ? pay.planSnapshot.listingLimit : null;
}

/**
 * Takes one listing slot for a listing being sent for review.
 * With a plan on, the plan limit is how many listings may be live or in review at one
 * time: unlisting, selling, renting or deleting one frees a place. "full": that many are
 * already running. Without a plan, it uses the free allowance, which is a lifetime total
 * that deleting does not give back. "hold": no plan and no free slot, so the listing
 * waits for a plan.
 */
export async function claimListingSlot(userId: string, role: UserRole, exceptId?: string) {
  const pay = await currentPlanPayment(userId);
  if (pay) {
    const active = await activeListingCount(userId, exceptId);
    if (active >= pay.planSnapshot.listingLimit) return 'full' as const;
    await Payment.updateOne({ _id: pay._id }, { $inc: { postsUsed: 1 } });
    return 'claimed' as const;
  }
  // The admin's free plan works like a plan: a limit on listings live at one time.
  const freePlan = await freePlanFor(role);
  if (freePlan) {
    const active = await activeListingCount(userId, exceptId);
    return active >= freePlan.listingLimit ? ('hold' as const) : ('claimed' as const);
  }
  const free = LISTING_LIMITS[role];
  if (free > 0) {
    const r = await User.updateOne(
      { _id: userId, freePostsUsed: { $not: { $gte: free } } },
      { $inc: { freePostsUsed: 1 } },
    );
    if (r.modifiedCount) return 'claimed' as const;
  }
  return 'hold' as const;
}

/**
 * Listing slots used and allowed right now: with a plan, listings live or in review out of
 * the plan limit; without one, the free listings posted so far out of the free total.
 */
async function listingSlots(userId: string, role: UserRole) {
  const pay = await currentPlanPayment(userId);
  if (pay) {
    return { used: await activeListingCount(userId), limit: pay.planSnapshot.listingLimit };
  }
  const freePlan = await freePlanFor(role);
  if (freePlan) return { used: await activeListingCount(userId), limit: freePlan.listingLimit };
  const u = await User.findById(userId).select('freePostsUsed').lean();
  const limit = LISTING_LIMITS[role];
  return { used: Math.min(u?.freePostsUsed ?? 0, limit), limit };
}

export async function listingLimitFor(userId: string, role: UserRole) {
  return (await listingSlots(userId, role)).limit;
}

/** Keeps user.premiumUntil (the Premium badge) in step with their paid payments. */
async function syncPremium(userId: Types.ObjectId) {
  const last = await Payment.findOne({
    ...PLAN_ONLY,
    user: userId,
    status: 'paid',
    endsAt: { $gt: new Date() },
  })
    .sort({ endsAt: -1 })
    .select('endsAt')
    .lean();
  await User.updateOne({ _id: userId }, { $set: { premiumUntil: last?.endsAt ?? null } });
}

/* ---------------- Plan perks on listings ---------------- */

type Perks = { boostRank: number; partnerBadge: boolean; autoRefreshDays: number };
const NO_PERKS: Perks = { boostRank: 0, partnerBadge: false, autoRefreshDays: 0 };

const perksOf = (snap?: PaymentLean['planSnapshot'] | null): Perks =>
  snap
    ? {
        boostRank: snap.searchRank ?? 0,
        partnerBadge: Boolean(snap.partnerBadge),
        autoRefreshDays: snap.autoRefreshDays ?? 0,
      }
    : NO_PERKS;

/** Search position and badge a new listing gets from the poster's current plan. */
export async function listingPerksFor(userId: string) {
  const { boostRank, partnerBadge } = perksOf((await currentPlanPayment(userId))?.planSnapshot);
  return { boostRank, partnerBadge };
}

/** Puts one user's plan position and badge on all their listings, and refreshes when due. */
async function applyPerks(userId: string | Types.ObjectId, perks: Perks, now: Date) {
  await Property.updateMany(
    {
      postedBy: userId,
      $or: [{ boostRank: { $ne: perks.boostRank } }, { partnerBadge: { $ne: perks.partnerBadge } }],
    },
    { $set: { boostRank: perks.boostRank, partnerBadge: perks.partnerBadge } },
  );
  if (perks.autoRefreshDays > 0)
    await Property.updateMany(
      {
        postedBy: userId,
        status: 'published',
        refreshedAt: { $lt: new Date(now.getTime() - perks.autoRefreshDays * DAY) },
      },
      { $set: { refreshedAt: now } },
    );
}

export async function syncPlanPerksFor(userId: string, now = new Date()) {
  await applyPerks(userId, perksOf((await currentPlanPayment(userId))?.planSnapshot), now);
}

/**
 * Runs on the sweep: every user with a plan on gets its search position, badge and auto
 * refresh; listings of users whose plan ended go back to normal. Also fills refreshedAt
 * on listings published before it existed.
 */
export async function syncPlanPerks(now = new Date()) {
  await Property.updateMany({ refreshedAt: null, publishedAt: { $ne: null } }, [
    { $set: { refreshedAt: '$publishedAt' } },
  ]);
  const pays = await Payment.find({
    ...PLAN_ONLY,
    status: 'paid',
    startsAt: { $lte: now },
    endsAt: { $gt: now },
  })
    .sort({ endsAt: -1 })
    .select('user planSnapshot')
    .lean<PaymentLean[]>();
  const seen = new Set<string>();
  for (const p of pays) {
    const uid = String(p.user);
    if (seen.has(uid)) continue;
    seen.add(uid);
    await applyPerks(uid, perksOf(p.planSnapshot), now);
  }
  await Property.updateMany(
    {
      postedBy: { $nin: [...seen].map((id) => new Types.ObjectId(id)) },
      $or: [{ boostRank: { $gt: 0 } }, { partnerBadge: true }],
    },
    { $set: { boostRank: 0, partnerBadge: false } },
  );
  return seen.size;
}

/** A paid plan shows every lead that was held back. */
async function unlockLeads(userId: Types.ObjectId) {
  await Enquiry.updateMany(
    { listingOwner: userId, lockedForOwner: true },
    { $set: { lockedForOwner: false } },
  );
}

/** Listings saved while waiting for a plan go to review once the plan is on, while slots last. */
export async function releaseAwaitingListings(userId: string) {
  const user = await User.findById(userId).select('role').lean();
  if (!user) return 0;
  const waiting = await Property.find({ postedBy: userId, awaitingPlan: true, status: 'draft' })
    .sort({ updatedAt: 1 })
    .select('_id title')
    .lean();
  let n = 0;
  for (const p of waiting) {
    if ((await claimListingSlot(userId, user.role as UserRole)) !== 'claimed') break;
    await Property.updateOne(
      { _id: p._id },
      { $set: { status: 'pending', awaitingPlan: false, slotUsed: true, submittedAt: new Date() } },
    );
    void businessAlert('listing', {
      title: `Listing waiting for review: ${p.title}`,
      link: '/admin/review',
    });
    n++;
  }
  return n;
}

const monthStart = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), 1);

/** How many leads with contact details the owner may see in the current period, and since when. */
async function leadAllowance(userId: string, role: UserRole) {
  const sub = await activeSubscription(userId);
  if (sub) {
    return {
      limit: sub.plan.leadLimit > 0 ? sub.plan.leadLimit : null,
      since: new Date(sub.startsAt),
      sub,
    };
  }
  const freePlan = await freePlanFor(role);
  if (freePlan)
    return {
      limit: (freePlan.leadLimit ?? 0) > 0 ? freePlan.leadLimit! : null,
      since: monthStart(),
      sub: null,
    };
  return { limit: FREE_LEADS_PER_MONTH[role], since: monthStart(), sub: null };
}

/** True when a new lead for this owner should hide its contact details. */
export async function shouldLockLead(ownerId: Types.ObjectId | string) {
  const owner = await User.findById(ownerId).select('role').lean();
  if (!owner) return false;
  const { limit, since } = await leadAllowance(String(ownerId), owner.role as UserRole);
  if (limit === null) return false;
  const seen = await Enquiry.countDocuments({
    listingOwner: owner._id,
    status: { $ne: 'spam' },
    lockedForOwner: { $ne: true },
    createdAt: { $gte: since },
  });
  return seen >= limit;
}

export async function usageFor(userId: string, role: UserRole): Promise<PlanUsage> {
  const uid = new Types.ObjectId(userId);
  const { limit: leadLimit, since, sub } = await leadAllowance(userId, role);
  const [slots, leadsUsed, locked, awaiting] = await Promise.all([
    listingSlots(userId, role),
    Enquiry.countDocuments({
      listingOwner: uid,
      status: { $ne: 'spam' },
      lockedForOwner: { $ne: true },
      createdAt: { $gte: since },
    }),
    Enquiry.countDocuments({ listingOwner: uid, status: { $ne: 'spam' }, lockedForOwner: true }),
    Property.countDocuments({ postedBy: uid, awaitingPlan: true, status: 'draft' }),
  ]);
  return {
    listings: slots,
    leads: { used: leadsUsed, limit: leadLimit, locked, periodStart: since.toISOString() },
    awaitingPlan: awaiting,
    premium: Boolean(sub),
  };
}

/** Emails and WhatsApps users whose plan ends within PLAN_REMINDER_DAYS and who have not renewed. */
export async function sendPlanReminders(now = new Date()) {
  const due = await Payment.find({
    ...PLAN_ONLY,
    status: 'paid',
    reminderSentAt: null,
    endsAt: { $gt: now, $lte: new Date(now.getTime() + PLAN_REMINDER_DAYS * DAY) },
  })
    .select('user endsAt planSnapshot')
    .limit(200);
  let sent = 0;
  for (const p of due) {
    p.reminderSentAt = now;
    await p.save();
    // Already renewed: a later plan starts when this one ends.
    const later = await Payment.exists({
      ...PLAN_ONLY,
      user: p.user,
      status: 'paid',
      endsAt: { $gt: p.endsAt },
    });
    if (later) continue;
    const user = await User.findById(p.user).select('name email phone whatsappEnabled').lean();
    if (!user) continue;
    const ends = p.endsAt!.toLocaleDateString('en-IN', {
      dateStyle: 'long',
      timeZone: 'Asia/Kolkata',
    });
    const url = `${env.PUBLIC_SITE_URL}/dashboard/plans`;
    // Auto-renew on: tell them the debit is coming instead of asking them to renew.
    const auto = await Autopay.findOne({
      user: p.user,
      status: { $in: ['active', 'authenticated'] },
    })
      .sort({ createdAt: -1 })
      .select('amount')
      .lean();
    if (auto) {
      void sendMail(
        user.email,
        `Your ${p.planSnapshot?.name ?? 'Premium'} plan renews on ${ends}`,
        [
          `Hi ${user.name},`,
          `Auto-renew is on. ₹${auto.amount.toLocaleString('en-IN')} will be taken around ${ends} and your plan will carry on.`,
          'You can turn auto-renew off any time from Plan & usage.',
        ],
        { label: 'Manage auto-renew', url },
      );
      sent++;
      continue;
    }
    void sendMail(
      user.email,
      `Your ${p.planSnapshot?.name ?? 'Premium'} plan ends on ${ends}`,
      [
        `Hi ${user.name},`,
        `Your ${p.planSnapshot?.name ?? 'Premium'} plan on NEXUS Estate ends on ${ends}.`,
        'Renew now to keep getting every lead and to add new listings.',
      ],
      { label: 'Renew plan', url },
    );
    if (user.whatsappEnabled !== false && user.phone)
      void sendWhatsApp(user.phone, `Your NEXUS Estate plan ends on ${ends}. Renew: ${url}`);
    sent++;
  }
  if (sent) logger.info({ sent }, 'plan reminders sent');
  return sent;
}

export async function myPayments(userId: string) {
  const rows = await Payment.find({ user: userId, status: { $ne: 'created' } })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean<PaymentLean[]>();
  return rows.map(toPayment);
}

/* ---------------- Paid Featured (₹49 / ₹99) ---------------- */

/** The Featured options with the prices admin has set in Settings. */
export async function featureAddons() {
  const { featurePrices } = await getSettings();
  return FEATURE_ADDONS.map((a) => ({
    ...a,
    price: a.days === 7 ? featurePrices.days7 : featurePrices.days30,
  }));
}

const addonFor = async (days: number) => {
  const a = (await featureAddons()).find((x) => x.days === days);
  if (!a) throw badRequest('Choose 7 days or 1 month');
  return a;
};

async function liveOwnListing(userId: string, propertyId: string) {
  const p = await Property.findOne({ _id: propertyId, postedBy: userId })
    .select('title slug status')
    .lean();
  if (!p) throw notFound('Listing not found');
  if (p.status !== 'published') throw badRequest('Only live listings can be featured');
  return p;
}

/** Features a listing for `days`, counted from today or from when its current feature ends. */
async function extendFeatured(propertyId: Types.ObjectId | string, days: number) {
  const p = await Property.findById(propertyId);
  if (!p) return null;
  const from =
    p.featured && p.featuredUntil && p.featuredUntil > new Date() ? p.featuredUntil : new Date();
  p.featured = true;
  p.featuredUntil = new Date(from.getTime() + days * DAY);
  await p.save();
  return p.featuredUntil;
}

async function markFeaturedPaid(
  payment: InstanceType<typeof Payment>,
  extra: { paymentId?: string; recordedBy?: string },
) {
  const days = payment.featureDays ?? 7;
  const until = await extendFeatured(payment.property as Types.ObjectId, days);
  payment.status = 'paid';
  payment.paidAt = new Date();
  // The paid days are the last `days` of the listing's Featured time.
  if (until) {
    payment.endsAt = until;
    payment.startsAt = new Date(until.getTime() - days * DAY);
  }
  payment.invoiceNo ??= await nextInvoiceNo(payment.paidAt);
  if (extra.paymentId) payment.paymentId = extra.paymentId;
  if (extra.recordedBy) payment.recordedBy = extra.recordedBy;
  await payment.save();
  const user = await User.findById(payment.user).select('name email').lean();
  void businessAlert('payment', {
    title: `Payment ₹${payment.amount} from ${user?.name ?? 'a user'}`,
    body: payment.planSnapshot?.name ?? 'Featured listing',
    link: '/admin/payments',
    to: 'super',
  });
  if (user && until)
    void sendMail(
      user.email,
      'Your listing is featured',
      [
        `Hi ${user.name},`,
        `We received ₹${payment.amount}. Your listing is featured until ${until.toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}.`,
      ],
      { label: 'See your listings', url: `${env.PUBLIC_SITE_URL}/dashboard/listings` },
    );
}

const featureSnapshot = (label: string, days: number) => ({
  name: `Featured listing · ${label}`,
  durationDays: days,
  listingLimit: 0,
  featuredListings: 1,
  featuredDays: days,
  leadLimit: 0,
});

/** Starts a Razorpay payment to feature one of the user's live listings for 7 or 30 days. */
export async function createFeatureCheckout(
  userId: string,
  propertyId: string,
  days: FeatureAddonDays,
): Promise<CheckoutOrder> {
  if (!razorpayEnabled)
    throw new AppError(503, 'PAYMENTS_OFF', 'Online payment is not available yet. Please call us.');
  const addon = await addonFor(days);
  const [user, prop] = await Promise.all([
    User.findById(userId).select(BUYER_FIELDS).lean<BuyerLean>(),
    liveOwnListing(userId, propertyId),
  ]);
  if (!user) throw notFound('Account not found');
  const snap = featureSnapshot(addon.label, addon.days);
  const order = await razorpayOrder(addon.price, String(user._id), { propertyId });
  await Payment.create({
    user: user._id,
    kind: 'featured',
    property: prop._id,
    featureDays: addon.days,
    planSnapshot: snap,
    amount: addon.price,
    method: 'online',
    orderId: order.id,
  });
  return {
    orderId: order.id,
    keyId: env.RAZORPAY_KEY_ID!,
    amount: addon.price * 100,
    currency: 'INR',
    planName: snap.name,
    prefill: { name: user.name, email: user.email, contact: user.phone },
    customerId: await customerOrNull(user),
  };
}

/** A Super Admin records a Featured payment taken by cash or UPI. */
export async function recordManualFeature(
  input: { propertyId: string; days: FeatureAddonDays; amount?: number; reference?: string },
  by: string,
) {
  const addon = await addonFor(input.days);
  const prop = await Property.findById(input.propertyId).select('postedBy status').lean();
  if (!prop?.postedBy) throw notFound('Listing not found');
  if (prop.status !== 'published') throw badRequest('Only live listings can be featured');
  const p = await Payment.create({
    user: prop.postedBy,
    kind: 'featured',
    property: prop._id,
    featureDays: addon.days,
    planSnapshot: featureSnapshot(addon.label, addon.days),
    amount: input.amount ?? addon.price,
    method: 'manual',
    reference: input.reference || null,
  });
  await markPaid(p, { recordedBy: by });
  return getPayment(p._id);
}

/* ---------------- Razorpay ---------------- */

/** One call to the Razorpay API. Throws a friendly 502 when Razorpay says no. */
async function rzp<T>(path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ path, status: res.status, body: text }, 'Razorpay call failed');
    throw Object.assign(
      new AppError(502, 'PAYMENT_GATEWAY', 'Could not start the payment. Please try again.'),
      { rzpStatus: res.status, rzpBody: text },
    );
  }
  return (await res.json()) as T;
}

async function razorpayOrder(rupees: number, userId: string, notes: Record<string, string>) {
  return rzp<{ id: string }>('/orders', {
    amount: rupees * 100,
    currency: 'INR',
    receipt: `nx-${userId.slice(-8)}-${Date.now().toString(36)}`,
    notes: { userId, ...notes },
  });
}

const rzpAuth = () =>
  `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

type BuyerLean = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  phone: string;
  razorpayCustomerId?: string | null;
};

/**
 * The user's Razorpay customer, made once. Saved cards and auto-renew mandates belong
 * to it; Razorpay keeps the card token, we keep only this id.
 */
async function ensureCustomer(user: BuyerLean) {
  if (user.razorpayCustomerId) return user.razorpayCustomerId;
  const c = await rzp<{ id: string }>('/customers', {
    name: user.name.slice(0, 50),
    email: user.email,
    contact: user.phone,
    // An existing customer with the same email/phone comes back instead of an error.
    fail_existing: '0',
    notes: { userId: String(user._id) },
  });
  await User.updateOne({ _id: user._id }, { $set: { razorpayCustomerId: c.id } });
  return c.id;
}

/** For one-time payments the customer is a nicety (saved cards), never a blocker. */
async function customerOrNull(user: BuyerLean) {
  try {
    return await ensureCustomer(user);
  } catch {
    return null;
  }
}

const BUYER_FIELDS = 'name email phone role razorpayCustomerId';

export async function createCheckout(userId: string, planId: string): Promise<CheckoutOrder> {
  if (!razorpayEnabled)
    throw new AppError(503, 'PAYMENTS_OFF', 'Online payment is not available yet. Please call us.');
  const [user, plan] = await Promise.all([
    User.findById(userId).select(BUYER_FIELDS).lean<BuyerLean & { role: UserRole }>(),
    Plan.findOne({ _id: planId, active: true }).lean<PlanLean>(),
  ]);
  if (!user) throw notFound('Account not found');
  if (!plan || !plan.roles.includes(user.role)) throw notFound('Plan not found');
  if (plan.price <= 0) throw badRequest('This plan is free and already on for you');

  const order = await razorpayOrder(plan.price, String(user._id), { planId: String(plan._id) });
  await Payment.create({
    user: user._id,
    plan: plan._id,
    planSnapshot: snapshotOf(plan),
    amount: plan.price,
    method: 'online',
    orderId: order.id,
  });
  return {
    orderId: order.id,
    keyId: env.RAZORPAY_KEY_ID!,
    amount: plan.price * 100,
    currency: 'INR',
    planName: plan.name,
    prefill: { name: user.name, email: user.email, contact: user.phone },
    customerId: await customerOrNull(user),
  };
}

export function razorpaySignatureValid(orderId: string, paymentId: string, signature: string) {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Called by the browser after Razorpay checkout succeeds. The signature proves it. */
export async function confirmCheckout(
  userId: string,
  input: { orderId: string; paymentId: string; signature: string },
) {
  const p = await Payment.findOne({ orderId: input.orderId, user: userId });
  if (!p) throw notFound('Payment not found');
  if (p.status === 'paid') return getPayment(p._id);
  if (!razorpaySignatureValid(input.orderId, input.paymentId, input.signature)) {
    // Only a still-open order is marked failed; the webhook may already have paid it.
    await Payment.updateOne({ _id: p._id, status: 'created' }, { $set: { status: 'failed' } });
    throw badRequest('Payment could not be verified. If money was taken, call us.');
  }
  await settleOnline(p._id, input.paymentId);
  return getPayment(p._id);
}

/**
 * Turns an open online payment into a paid one exactly once. The browser and the
 * Razorpay webhook can both arrive for the same order, at the same moment.
 */
async function settleOnline(id: Types.ObjectId, paymentId: string, startFrom?: Date | null) {
  const claimed = await Payment.findOneAndUpdate(
    { _id: id, method: 'online', status: { $in: ['created', 'failed'] } },
    { $set: { status: 'paid' } },
    { new: true },
  );
  if (!claimed) return false;
  try {
    await markPaid(claimed, { paymentId, startFrom });
  } catch (err) {
    // Not saved yet (paidAt still empty): open the order again so a retry can finish it.
    await Payment.updateOne({ _id: id, paidAt: null }, { $set: { status: 'created' } });
    throw err;
  }
  return true;
}

/* ---------------- Auto-renew (card mandate / UPI Autopay) ---------------- */

/** Auto-renews that still take money, or may again. */
const LIVE_AUTOPAY: AutopayStatus[] = ['authenticated', 'active', 'pending'];

type AutopayLean = {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  plan: Types.ObjectId;
  planSnapshot: PaymentLean['planSnapshot'];
  amount: number;
  subscriptionId: string;
  status: AutopayStatus;
  method?: 'card' | 'upi' | null;
  methodLabel?: string | null;
  nextChargeAt?: Date | null;
  graceFrom?: Date | null;
  createdAt: Date;
};

const toAutopay = (a: AutopayLean): NonNullable<MyAutopay> => ({
  id: String(a._id),
  status: a.status,
  planName: a.planSnapshot?.name ?? 'Premium',
  amount: a.amount,
  durationDays: a.planSnapshot?.durationDays ?? 30,
  method: a.method ?? null,
  methodLabel: a.methodLabel ?? null,
  nextChargeAt: iso(a.nextChargeAt),
  createdAt: a.createdAt.toISOString(),
});

/** The auto-renew shown on Plan & usage: the latest one that is on, waiting or stopped by the bank. */
export async function myAutopay(userId: string): Promise<MyAutopay> {
  const a = await Autopay.findOne({ user: userId, status: { $in: [...LIVE_AUTOPAY, 'halted'] } })
    .sort({ createdAt: -1 })
    .lean<AutopayLean>();
  return a ? toAutopay(a) : null;
}

/** Razorpay billing period that repeats exactly every `days` days (yearly when it fits). */
export function razorpayPeriod(days: number) {
  if (days % 365 === 0) return { period: 'yearly', interval: days / 365 } as const;
  return { period: 'daily', interval: days } as const;
}

/** How many debits a mandate allows: about 10 years, at most 100. */
export const autopayCycles = (days: number) => Math.max(1, Math.min(100, Math.floor(3650 / days)));

/** The Razorpay plan for this admin plan's current price and length, made when missing. */
async function ensureRazorpayPlan(
  plan: PlanLean & {
    razorpayPlan?: {
      id?: string | null;
      price?: number | null;
      durationDays?: number | null;
    } | null;
  },
) {
  const rp = plan.razorpayPlan;
  if (rp?.id && rp.price === plan.price && rp.durationDays === plan.durationDays) return rp.id;
  const made = await rzp<{ id: string }>('/plans', {
    ...razorpayPeriod(plan.durationDays),
    item: {
      name: `NEXUS ${plan.name}`.slice(0, 60),
      amount: plan.price * 100,
      currency: 'INR',
      description: `${plan.durationDays} days`,
    },
    notes: { planId: String(plan._id) },
  });
  await Plan.updateOne(
    { _id: plan._id },
    { $set: { razorpayPlan: { id: made.id, price: plan.price, durationDays: plan.durationDays } } },
  );
  return made.id;
}

/**
 * Starts a plan with auto-renew. Razorpay checkout opens on a subscription: a card
 * becomes a saved mandate, UPI becomes UPI Autopay. The first period is paid at once.
 */
export async function createAutopayCheckout(
  userId: string,
  planId: string,
): Promise<AutopayCheckout> {
  if (!razorpayEnabled)
    throw new AppError(503, 'PAYMENTS_OFF', 'Online payment is not available yet. Please call us.');
  const [user, plan] = await Promise.all([
    User.findById(userId).select(BUYER_FIELDS).lean<BuyerLean & { role: UserRole }>(),
    Plan.findOne({ _id: planId, active: true }).lean<PlanLean>(),
  ]);
  if (!user) throw notFound('Account not found');
  if (!plan || !plan.roles.includes(user.role)) throw notFound('Plan not found');
  if (plan.price <= 0) throw badRequest('This plan is free and already on for you');
  if (plan.durationDays < 7) throw badRequest('Auto-renew is not available for this plan');
  if (await Autopay.exists({ user: user._id, status: { $in: LIVE_AUTOPAY } }))
    throw badRequest('Auto-renew is already on. Turn it off first to change the plan.');

  const customerId = await ensureCustomer(user);
  const rzpPlanId = await ensureRazorpayPlan(plan);
  const sub = await rzp<{ id: string }>('/subscriptions', {
    plan_id: rzpPlanId,
    customer_id: customerId,
    total_count: autopayCycles(plan.durationDays),
    quantity: 1,
    customer_notify: 1,
    notes: { userId: String(user._id), planId: String(plan._id) },
  });
  await Autopay.create({
    user: user._id,
    plan: plan._id,
    planSnapshot: snapshotOf(plan),
    amount: plan.price,
    subscriptionId: sub.id,
  });
  return {
    subscriptionId: sub.id,
    keyId: env.RAZORPAY_KEY_ID!,
    amount: plan.price * 100,
    currency: 'INR',
    planName: plan.name,
    prefill: { name: user.name, email: user.email, contact: user.phone },
    customerId,
  };
}

/** Checkout signs `payment_id|subscription_id` for subscriptions (the reverse of orders). */
export function subscriptionSignatureValid(
  paymentId: string,
  subscriptionId: string,
  signature: string,
) {
  if (!env.RAZORPAY_KEY_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type RzpPaymentEntity = {
  id?: string;
  order_id?: string | null;
  amount?: number;
  currency?: string;
  status?: string;
  method?: string;
  vpa?: string | null;
  upi?: { vpa?: string | null } | null;
  card?: { network?: string | null; last4?: string | null } | null;
};
type RzpSubscriptionEntity = {
  id?: string;
  status?: string;
  charge_at?: number | null;
  current_end?: number | null;
};

const fromUnix = (t?: number | null) => (t ? new Date(t * 1000) : null);

/** "Visa •••• 4242" or the UPI ID; null when Razorpay did not say. */
function methodOf(pay: RzpPaymentEntity) {
  if (pay.method === 'card') {
    const label = [pay.card?.network, pay.card?.last4 ? `•••• ${pay.card.last4}` : null]
      .filter(Boolean)
      .join(' ');
    return { method: 'card' as const, methodLabel: label || 'Card' };
  }
  if (pay.method === 'upi') {
    return { method: 'upi' as const, methodLabel: pay.vpa ?? pay.upi?.vpa ?? 'UPI' };
  }
  return null;
}

const AUTOPAY_RANK: Record<AutopayStatus, number> = {
  created: 0,
  authenticated: 1,
  active: 2,
  pending: 2,
  halted: 2,
  cancelled: 3,
  completed: 3,
};

/** Moves an auto-renew to a new state; webhooks arrive out of order, so it never goes back. */
async function setAutopayStatus(
  a: AutopayLean,
  status: AutopayStatus,
  extra: Record<string, unknown> = {},
) {
  if (AUTOPAY_RANK[status] < AUTOPAY_RANK[a.status]) return;
  if (AUTOPAY_RANK[a.status] === 3 && status !== a.status) return;
  await Autopay.updateOne({ _id: a._id }, { $set: { status, ...extra } });
}

/**
 * Books one auto-renew debit as a paid plan payment (own invoice, plan carried on).
 * Safe to call twice for the same Razorpay payment: browser verify and webhook race.
 */
async function settleAutopayCharge(
  a: AutopayLean,
  pay: RzpPaymentEntity,
  sub?: RzpSubscriptionEntity,
): Promise<WebhookResult> {
  if (!pay.id) return 'ignored_event';
  if (pay.status && pay.status !== 'captured') return 'not_captured';
  if (pay.amount !== Math.round(a.amount * 100) || (pay.currency && pay.currency !== 'INR')) {
    logger.error(
      {
        subscriptionId: a.subscriptionId,
        paymentId: pay.id,
        paise: pay.amount,
        expected: a.amount * 100,
      },
      'Razorpay auto-renew amount does not match',
    );
    return 'amount_mismatch';
  }
  const fields = {
    user: a.user,
    kind: 'plan',
    plan: a.plan,
    planSnapshot: a.planSnapshot,
    amount: a.amount,
    method: 'online',
    orderId: pay.order_id ?? null,
    subscriptionId: a.subscriptionId,
    paymentId: pay.id,
  };
  let row = await Payment.findOne({ paymentId: pay.id }).select('_id status').lean();
  if (!row) {
    try {
      row = (await Payment.create({ ...fields, status: 'created' })).toObject();
    } catch (err) {
      // The other path made it a moment ago.
      if ((err as { code?: number }).code !== 11000) throw err;
      row = await Payment.findOne({
        $or: [{ paymentId: pay.id }, ...(pay.order_id ? [{ orderId: pay.order_id }] : [])],
      })
        .select('_id status')
        .lean();
      if (!row) throw err;
    }
  }
  const done = await settleOnline(row._id as Types.ObjectId, pay.id, a.graceFrom ?? null);
  const how = methodOf(pay);
  await setAutopayStatus(a, 'active', {
    ...(how ?? {}),
    graceFrom: null,
    ...(sub?.charge_at || sub?.current_end
      ? { nextChargeAt: fromUnix(sub.charge_at ?? sub.current_end) }
      : {}),
  });
  return done ? 'paid' : 'already_done';
}

/** Browser call after the auto-renew checkout succeeds. */
export async function confirmAutopay(
  userId: string,
  input: { subscriptionId: string; paymentId: string; signature: string },
) {
  const a = await Autopay.findOne({
    subscriptionId: input.subscriptionId,
    user: userId,
  }).lean<AutopayLean>();
  if (!a) throw notFound('Auto-renew not found');
  if (!subscriptionSignatureValid(input.paymentId, input.subscriptionId, input.signature))
    throw badRequest('Payment could not be verified. If money was taken, call us.');
  await setAutopayStatus(a, 'authenticated');
  const [pay, sub] = await Promise.all([
    rzp<RzpPaymentEntity>(`/payments/${encodeURIComponent(input.paymentId)}?expand[]=card`),
    rzp<RzpSubscriptionEntity>(`/subscriptions/${encodeURIComponent(input.subscriptionId)}`).catch(
      () => undefined,
    ),
  ]);
  const fresh = (await Autopay.findById(a._id).lean<AutopayLean>()) ?? a;
  const result = await settleAutopayCharge(fresh, { ...pay, id: input.paymentId }, sub);
  if (result === 'amount_mismatch')
    throw badRequest('Payment amount did not match. Please call us.');
  // 'not_captured': Razorpay is still finishing it; the webhook turns the plan on.
  return { autopay: await myAutopay(userId), pending: result === 'not_captured' };
}

/** Stops future debits. The days already paid for stay. */
export async function cancelAutopay(userId: string, by: string) {
  const a = await Autopay.findOne({ user: userId, status: { $in: [...LIVE_AUTOPAY, 'halted'] } })
    .sort({ createdAt: -1 })
    .lean<AutopayLean>();
  if (!a) throw badRequest('Auto-renew is already off');
  try {
    await rzp(`/subscriptions/${encodeURIComponent(a.subscriptionId)}/cancel`, {
      cancel_at_cycle_end: 0,
    });
  } catch (err) {
    // Razorpay answers 400 when it is already cancelled or finished there: off either way.
    if ((err as { rzpStatus?: number }).rzpStatus !== 400) throw err;
  }
  await Autopay.updateOne(
    { _id: a._id },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: by, nextChargeAt: null } },
  );
  return myAutopay(userId);
}

/** Admin: stop the auto-renew that took this payment. */
export async function cancelAutopayForPayment(paymentId: string, by: string) {
  const p = await Payment.findById(paymentId).select('user subscriptionId').lean();
  if (!p) throw notFound('Payment not found');
  if (!p.subscriptionId) throw badRequest('This payment was not an auto-renew');
  await cancelAutopay(String(p.user), by);
  return getPayment(paymentId);
}

/** A debit failed and Razorpay will retry: keep the plan on for a few days. */
async function giveGrace(a: AutopayLean) {
  if (a.graceFrom) return;
  const last = await Payment.findOne({ ...PLAN_ONLY, user: a.user, status: 'paid' })
    .sort({ endsAt: -1 })
    .select('endsAt');
  if (!last?.endsAt) return;
  const end = last.endsAt;
  // Only near the end of the paid time; a later plan already covers anything else.
  if (end.getTime() > Date.now() + AUTOPAY_GRACE_DAYS * DAY) return;
  await Autopay.updateOne({ _id: a._id, graceFrom: null }, { $set: { graceFrom: end } });
  last.endsAt = new Date(Math.max(end.getTime(), Date.now()) + AUTOPAY_GRACE_DAYS * DAY);
  await last.save();
  await syncPremium(a.user);
  await syncPlanPerksFor(String(a.user));
}

async function tellUser(userId: Types.ObjectId, subject: string, lines: string[]) {
  const user = await User.findById(userId).select('name email phone whatsappEnabled').lean();
  if (!user) return;
  const url = `${env.PUBLIC_SITE_URL}/dashboard/plans`;
  void sendMail(user.email, subject, [`Hi ${user.name},`, ...lines], {
    label: 'Open Plan & usage',
    url,
  });
  if (user.whatsappEnabled !== false && user.phone)
    void sendWhatsApp(user.phone, `${subject}. ${url}`);
}

const SUB_EVENTS: Record<string, AutopayStatus> = {
  'subscription.authenticated': 'authenticated',
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  'subscription.resumed': 'active',
  'subscription.pending': 'pending',
  'subscription.halted': 'halted',
  'subscription.cancelled': 'cancelled',
  'subscription.completed': 'completed',
};

async function handleSubscriptionEvent(kind: string, body: RzpEvent): Promise<WebhookResult> {
  const sub = body.payload?.subscription?.entity;
  if (!sub?.id || !SUB_EVENTS[kind]) return 'ignored_event';
  const a = await Autopay.findOne({ subscriptionId: sub.id }).lean<AutopayLean>();
  if (!a) {
    logger.warn(
      { subscriptionId: sub.id, event: kind },
      'Razorpay webhook for an unknown subscription',
    );
    return 'unknown_order';
  }
  const next =
    sub.charge_at || sub.current_end
      ? { nextChargeAt: fromUnix(sub.charge_at ?? sub.current_end) }
      : {};
  if (kind === 'subscription.charged') {
    const pay = body.payload?.payment?.entity;
    if (!pay?.id) return 'ignored_event';
    return settleAutopayCharge(a, pay, sub);
  }
  const status = SUB_EVENTS[kind];
  await setAutopayStatus(
    a,
    status,
    status === 'cancelled' || status === 'completed' ? { nextChargeAt: null } : next,
  );
  if (kind === 'subscription.pending') {
    await giveGrace(a);
    await tellUser(a.user, 'Your NEXUS Estate auto-renew payment did not go through', [
      `We could not take ₹${a.amount.toLocaleString('en-IN')} for your ${a.planSnapshot?.name ?? 'Premium'} plan. The bank will try again over the next few days.`,
      `Your plan stays on for ${AUTOPAY_GRACE_DAYS} more days. Please keep money in the account or renew from Plan & usage.`,
    ]);
  }
  if (kind === 'subscription.halted') {
    await tellUser(a.user, 'Your NEXUS Estate auto-renew has stopped', [
      'The bank could not take the payment after several tries, so auto-renew has stopped.',
      'Renew from Plan & usage to keep your plan.',
    ]);
  }
  return status === 'cancelled' || status === 'completed' ? 'already_done' : 'paid';
}

/* ---------------- Razorpay webhook ---------------- */

/** Razorpay signs the exact request body with the webhook secret (HMAC-SHA256, hex). */
export function webhookSignatureValid(rawBody: Buffer, signature: string | undefined) {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type RzpEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  amount_paid?: number;
  currency?: string;
  status?: string;
};
type RzpEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: RzpEntity & RzpPaymentEntity };
    order?: { entity?: RzpEntity };
    subscription?: { entity?: RzpSubscriptionEntity };
  };
};

export type WebhookResult =
  | 'paid'
  | 'already_done'
  | 'ignored_event'
  | 'unknown_order'
  | 'amount_mismatch'
  | 'not_captured';

/**
 * Safety net for online payments: if the visitor closes the tab before the site hears
 * back, Razorpay's payment.captured / order.paid still turns the plan or Featured on.
 * subscription.* events run auto-renew. The caller has already checked the signature.
 */
export async function handleRazorpayEvent(body: RzpEvent): Promise<WebhookResult> {
  const kind = body.event;
  if (kind?.startsWith('subscription.')) return handleSubscriptionEvent(kind, body);
  if (kind !== 'payment.captured' && kind !== 'order.paid') return 'ignored_event';
  const pay = body.payload?.payment?.entity;
  const order = body.payload?.order?.entity;
  const orderId = pay?.order_id ?? order?.id;
  if (!orderId || !pay?.id) return 'ignored_event';
  if (pay.status && pay.status !== 'captured') return 'not_captured';

  const p = await Payment.findOne({ orderId })
    .select('_id status amount method subscriptionId')
    .lean();
  if (!p) {
    logger.warn({ orderId, event: kind }, 'Razorpay webhook for an unknown order');
    return 'unknown_order';
  }
  // Auto-renew debits are booked by subscription.charged (it knows the grace days).
  if (p.subscriptionId && p.status !== 'paid') return 'ignored_event';
  if (p.status === 'paid' || p.status === 'refunded') return 'already_done';
  const paise = pay.amount ?? order?.amount_paid;
  if (paise !== Math.round(p.amount * 100) || (pay.currency && pay.currency !== 'INR')) {
    logger.error(
      { orderId, paymentId: pay.id, paise, expected: p.amount * 100 },
      'Razorpay webhook amount does not match the order',
    );
    return 'amount_mismatch';
  }
  return (await settleOnline(p._id, pay.id)) ? 'paid' : 'already_done';
}
