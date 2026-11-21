import crypto from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import {
  DEFAULT_PLAN,
  FEATURE_ADDONS,
  FREE_LEADS_PER_MONTH,
  LISTING_LIMITS,
  PLAN_REMINDER_DAYS,
  type CheckoutOrder,
  type FeatureAddonDays,
  type PlanUsage,
  type MySubscription,
  type Payment as PaymentDto,
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
import { Payment, Plan } from '../models/admin-panel.models.js';
import { User } from '../models/user.model.js';
import { Property } from '../models/property.model.js';
import { Enquiry } from '../models/misc.models.js';
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
});

export async function createPlan(input: z.output<typeof planSchema>) {
  const p = await Plan.create(input);
  return toPlan(p.toObject() as unknown as PlanLean);
}

export async function updatePlan(id: string, patch: z.output<typeof planUpdateSchema>) {
  const p = await Plan.findByIdAndUpdate(id, { $set: patch }, { new: true }).lean<PlanLean>();
  if (!p) throw notFound('Plan not found');
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

/** A new plan starts when the current one ends, so renewing early never loses days. */
async function periodFor(userId: Types.ObjectId, durationDays: number) {
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
  extra: { paymentId?: string; recordedBy?: string },
) {
  if (payment.kind === 'featured') return markFeaturedPaid(payment, extra);
  const { startsAt, endsAt } = await periodFor(
    payment.user as Types.ObjectId,
    payment.planSnapshot!.durationDays!,
  );
  payment.status = 'paid';
  payment.paidAt = new Date();
  payment.startsAt = startsAt;
  payment.endsAt = endsAt;
  if (extra.paymentId) payment.paymentId = extra.paymentId;
  if (extra.recordedBy) payment.recordedBy = extra.recordedBy;
  await payment.save();
  await syncPremium(payment.user as Types.ObjectId);
  await unlockLeads(payment.user as Types.ObjectId);
  await releaseAwaitingListings(String(payment.user));
  const user = await User.findById(payment.user).select('name email').lean();
  void businessAlert('payment', {
    title: `Payment ₹${payment.amount.toLocaleString('en-IN')} from ${user?.name ?? 'a user'}`,
    body: `${payment.planSnapshot!.name} plan · ${payment.method === 'online' ? 'online' : 'recorded by hand'}`,
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
  const until = await extendFeatured(payment.property as Types.ObjectId, payment.featureDays ?? 7);
  payment.status = 'paid';
  payment.paidAt = new Date();
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
    User.findById(userId).select('name email phone').lean(),
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

async function razorpayOrder(rupees: number, userId: string, notes: Record<string, string>) {
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: rupees * 100,
      currency: 'INR',
      receipt: `nx-${userId.slice(-8)}-${Date.now().toString(36)}`,
      notes: { userId, ...notes },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, 'Razorpay order failed');
    throw new AppError(502, 'PAYMENT_GATEWAY', 'Could not start the payment. Please try again.');
  }
  return (await res.json()) as { id: string };
}

const rzpAuth = () =>
  `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

export async function createCheckout(userId: string, planId: string): Promise<CheckoutOrder> {
  if (!razorpayEnabled)
    throw new AppError(503, 'PAYMENTS_OFF', 'Online payment is not available yet. Please call us.');
  const [user, plan] = await Promise.all([
    User.findById(userId).select('name email phone role').lean(),
    Plan.findOne({ _id: planId, active: true }).lean<PlanLean>(),
  ]);
  if (!user) throw notFound('Account not found');
  if (!plan || !plan.roles.includes(user.role)) throw notFound('Plan not found');

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
    p.status = 'failed';
    await p.save();
    throw badRequest('Payment could not be verified. If money was taken, call us.');
  }
  await markPaid(p, { paymentId: input.paymentId });
  return getPayment(p._id);
}
