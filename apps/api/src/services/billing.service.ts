import crypto from 'node:crypto';
import { Types, type FilterQuery } from 'mongoose';
import type { z } from 'zod';
import {
  DEFAULT_PLAN,
  FREE_LEADS_PER_MONTH,
  LISTING_LIMITS,
  PLAN_REMINDER_DAYS,
  type CheckoutOrder,
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
  await Plan.create({ ...DEFAULT_PLAN, roles: [...DEFAULT_PLAN.roles], active: true, sortOrder: 0 });
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
  plan: Types.ObjectId;
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
  id: String(p.plan),
  name: p.planSnapshot.name,
  durationDays: p.planSnapshot.durationDays,
  listingLimit: p.planSnapshot.listingLimit,
  featuredListings: p.planSnapshot.featuredListings ?? 0,
  featuredDays: p.planSnapshot.featuredDays ?? 7,
  leadLimit: p.planSnapshot.leadLimit ?? 0,
});

const toPayment = (p: PaymentLean): PaymentDto => ({
  id: String(p._id),
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
  const p = await Payment.findById(id).populate('user', 'name role phone').lean<PaymentLean>();
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
      .lean<PaymentLean[]>(),
    Payment.countDocuments(f),
  ]);
  return { items: rows.map(toPayment), meta: paginate(q.page, q.limit, total) };
}

export async function paymentSummary(): Promise<PaymentSummary> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const [rows, active] = await Promise.all([
    Payment.aggregate<{ _id: boolean; total: number }>([
      { $match: { status: 'paid', paidAt: { $gte: lastMonthStart } } },
      { $group: { _id: { $gte: ['$paidAt', monthStart] }, total: { $sum: '$amount' } } },
    ]),
    Payment.distinct('user', { status: 'paid', endsAt: { $gt: now } }),
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
  await syncPremium(p.user as Types.ObjectId);
  return getPayment(p._id);
}

export async function activeSubscription(userId: string): Promise<MySubscription> {
  const now = new Date();
  const p = await Payment.findOne({
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

/** Base limit for the account type, raised by an active plan. */
export async function listingLimitFor(userId: string, role: UserRole) {
  const sub = await activeSubscription(userId);
  return Math.max(LISTING_LIMITS[role], sub?.plan.listingLimit ?? 0);
}

/** Keeps user.premiumUntil (the Premium badge) in step with their paid payments. */
async function syncPremium(userId: Types.ObjectId) {
  const last = await Payment.findOne({ user: userId, status: 'paid', endsAt: { $gt: new Date() } })
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

const ACTIVE_LISTING = ['pending', 'published'];

/** Listings saved while waiting for a plan go to review once the plan is on, up to the limit. */
export async function releaseAwaitingListings(userId: string) {
  const user = await User.findById(userId).select('role').lean();
  if (!user) return 0;
  const [limit, active, waiting] = await Promise.all([
    listingLimitFor(userId, user.role as UserRole),
    Property.countDocuments({ postedBy: userId, status: { $in: ACTIVE_LISTING } }),
    Property.find({ postedBy: userId, awaitingPlan: true, status: 'draft' })
      .sort({ updatedAt: 1 })
      .select('_id title')
      .lean(),
  ]);
  const room = Math.max(0, limit - active);
  const go = waiting.slice(0, room);
  if (!go.length) return 0;
  await Property.updateMany(
    { _id: { $in: go.map((p) => p._id) } },
    { $set: { status: 'pending', awaitingPlan: false, submittedAt: new Date() } },
  );
  for (const p of go)
    void businessAlert('listing', {
      title: `Listing waiting for review: ${p.title}`,
      link: '/admin/review',
    });
  return go.length;
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
  const [listings, listingLimit, leadsUsed, locked, featured, awaiting] = await Promise.all([
    Property.countDocuments({ postedBy: uid, status: { $in: ACTIVE_LISTING } }),
    listingLimitFor(userId, role),
    Enquiry.countDocuments({
      listingOwner: uid,
      status: { $ne: 'spam' },
      lockedForOwner: { $ne: true },
      createdAt: { $gte: since },
    }),
    Enquiry.countDocuments({ listingOwner: uid, status: { $ne: 'spam' }, lockedForOwner: true }),
    sub
      ? Property.countDocuments({ postedBy: uid, selfFeaturedAt: { $gte: new Date(sub.startsAt) } })
      : 0,
    Property.countDocuments({ postedBy: uid, awaitingPlan: true, status: 'draft' }),
  ]);
  return {
    listings: { used: listings, limit: listingLimit },
    leads: { used: leadsUsed, limit: leadLimit, locked, periodStart: since.toISOString() },
    featured: {
      used: featured,
      limit: sub?.plan.featuredListings ?? 0,
      days: sub?.plan.featuredDays ?? 7,
    },
    awaitingPlan: awaiting,
    premium: Boolean(sub),
  };
}

/** Features one of the user's live listings using their plan's featured allowance. */
export async function featureMine(userId: string, propertyId: string) {
  const sub = await activeSubscription(userId);
  if (!sub) throw new AppError(403, 'PLAN_REQUIRED', 'Take Premium to feature your listings.');
  const p = await Property.findOne({ _id: propertyId, postedBy: userId });
  if (!p) throw notFound('Listing not found');
  if (p.status !== 'published') throw badRequest('Only live listings can be featured');
  if (p.featured && p.featuredUntil && p.featuredUntil > new Date())
    throw badRequest('This listing is already featured');
  const used = await Property.countDocuments({
    postedBy: userId,
    selfFeaturedAt: { $gte: new Date(sub.startsAt) },
  });
  if (used >= sub.plan.featuredListings)
    throw new AppError(
      403,
      'FEATURED_LIMIT',
      `You have used all ${sub.plan.featuredListings} featured listings in this plan.`,
    );
  p.featured = true;
  p.featuredUntil = new Date(Date.now() + sub.plan.featuredDays * DAY);
  p.selfFeaturedAt = new Date();
  await p.save();
  return { featuredUntil: p.featuredUntil.toISOString() };
}

/** Emails and WhatsApps users whose plan ends within PLAN_REMINDER_DAYS and who have not renewed. */
export async function sendPlanReminders(now = new Date()) {
  const due = await Payment.find({
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
    const later = await Payment.exists({ user: p.user, status: 'paid', endsAt: { $gt: p.endsAt } });
    if (later) continue;
    const user = await User.findById(p.user).select('name email phone whatsappEnabled').lean();
    if (!user) continue;
    const ends = p.endsAt!.toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' });
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

/* ---------------- Razorpay ---------------- */

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

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: rzpAuth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: plan.price * 100,
      currency: 'INR',
      receipt: `nx-${String(user._id).slice(-8)}-${Date.now().toString(36)}`,
      notes: { userId: String(user._id), planId: String(plan._id) },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    logger.error({ status: res.status, body: await res.text() }, 'Razorpay order failed');
    throw new AppError(502, 'PAYMENT_GATEWAY', 'Could not start the payment. Please try again.');
  }
  const order = (await res.json()) as { id: string };
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
