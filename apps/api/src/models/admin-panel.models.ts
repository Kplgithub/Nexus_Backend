import { Schema, model } from 'mongoose';
import {
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  SITE_VISIT_STATUSES,
  SUPPORT_STATUSES,
  SUPPORT_TOPICS,
  USER_ROLES,
} from '@nexus/shared';

const noteSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 1000 },
    by: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/* ---------------- Site visits ---------------- */
const siteVisitSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    phone: { type: String, required: true, maxlength: 20 },
    scheduledAt: { type: Date, required: true },
    status: { type: String, enum: SITE_VISIT_STATUSES, default: 'scheduled' },
    enquiry: { type: Schema.Types.ObjectId, ref: 'Enquiry', default: null },
    leadId: { type: String, default: null },
    property: { type: Schema.Types.ObjectId, ref: 'Property', default: null },
    propertySnapshot: { title: String, slug: String },
    assignedAdmin: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    outcome: { type: String, maxlength: 1000, default: null },
    notes: { type: [noteSchema], default: [] },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);
siteVisitSchema.index({ scheduledAt: 1, status: 1 });
siteVisitSchema.index({ assignedAdmin: 1, scheduledAt: 1 });
siteVisitSchema.index({ enquiry: 1 });
export const SiteVisit = model('SiteVisit', siteVisitSchema);

/* ---------------- Paid plans ---------------- */
const planSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 60 },
    description: { type: String, maxlength: 300, default: '' },
    /** 0 = the free plan, on by itself for users without a paid plan. */
    price: { type: Number, required: true, min: 0 },
    durationDays: { type: Number, required: true, min: 1 },
    listingLimit: { type: Number, required: true, min: 1 },
    featuredListings: { type: Number, default: 0 },
    featuredDays: { type: Number, default: 7 },
    /** Leads with contact details per plan period; 0 means no limit. */
    leadLimit: { type: Number, default: 0 },
    /** Cut price shown struck through; 0 means none. */
    mrp: { type: Number, default: 0 },
    /** Position on search: 0 Normal, 1 High, 2 Higher, 3 Top. */
    searchRank: { type: Number, min: 0, max: 3, default: 0 },
    /** Premium Partner badge on the poster's listings and profile. */
    partnerBadge: { type: Boolean, default: false },
    /** Listings move back to the top every N days; 0 is off. */
    autoRefreshDays: { type: Number, default: 0 },
    /** "Most chosen" in the plans popup. */
    recommended: { type: Boolean, default: false },
    roles: { type: [String], enum: USER_ROLES, default: [] },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true },
);
planSchema.index({ active: 1, sortOrder: 1 });
export const Plan = model('Plan', planSchema);

/** One purchase of a plan. A paid payment is also the subscription (startsAt..endsAt). */
const paymentSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** "plan" buys a subscription; "featured" features one listing for featureDays. */
    kind: { type: String, enum: PAYMENT_KINDS, default: 'plan' },
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', default: null },
    property: { type: Schema.Types.ObjectId, ref: 'Property', default: null },
    featureDays: { type: Number, default: null },
    /** Listings posted in this plan period (deleting one does not give the slot back). */
    postsUsed: { type: Number, default: 0 },
    planSnapshot: {
      name: String,
      durationDays: Number,
      listingLimit: Number,
      featuredListings: Number,
      featuredDays: Number,
      leadLimit: Number,
      searchRank: Number,
      partnerBadge: Boolean,
      autoRefreshDays: Number,
    },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: 'INR' },
    status: { type: String, enum: PAYMENT_STATUSES, default: 'created' },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    orderId: { type: String, default: null },
    paymentId: { type: String, default: null },
    reference: { type: String, maxlength: 120, default: null },
    note: { type: String, maxlength: 500, default: null },
    recordedBy: { type: String, default: null },
    paidAt: { type: Date, default: null },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    /** Invoice number given when the payment is paid, e.g. NX/2026-27/0001. */
    invoiceNo: { type: String, default: null },
    /** Set once the "your plan ends soon" reminder went out. */
    reminderSentAt: { type: Date, default: null },
  },
  { timestamps: true },
);
paymentSchema.index({ user: 1, status: 1, endsAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
// Manual payments have no order id (null), so only real ids must be unique.
paymentSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: 'string' } } },
);
paymentSchema.index(
  { invoiceNo: 1 },
  { unique: true, partialFilterExpression: { invoiceNo: { $type: 'string' } } },
);
export const Payment = model('Payment', paymentSchema);

/* ---------------- Admin notifications (the bell) ---------------- */
const notificationSchema = new Schema(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'Admin', required: true },
    kind: { type: String, required: true },
    title: { type: String, required: true, maxlength: 160 },
    body: { type: String, maxlength: 500, default: '' },
    link: { type: String, maxlength: 300, default: null },
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
notificationSchema.index({ admin: 1, read: 1, createdAt: -1 });
// Old notifications clear themselves after 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });
export const AdminNotification = model('AdminNotification', notificationSchema);

/* ---------------- Help & support tickets ---------------- */
const supportMessageSchema = new Schema(
  {
    from: { type: String, enum: ['user', 'admin'], required: true },
    by: { type: String, required: true, maxlength: 120 },
    admin: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    text: { type: String, maxlength: 2000, default: '' },
    images: { type: [String], default: [] },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const supportTicketSchema = new Schema(
  {
    ticketId: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** Role at the time the ticket was raised; drives the admin role tabs. */
    role: { type: String, enum: USER_ROLES, required: true },
    userSnapshot: {
      name: String,
      phone: String,
      companyName: { type: String, default: null },
    },
    topic: { type: String, enum: [...SUPPORT_TOPICS, null], default: null },
    subject: { type: String, required: true, maxlength: 160 },
    property: { type: Schema.Types.ObjectId, ref: 'Property', default: null },
    propertySnapshot: { title: String, slug: String },
    status: { type: String, enum: SUPPORT_STATUSES, default: 'open' },
    messages: { type: [supportMessageSchema], default: [] },
    lastMessageAt: { type: Date, default: () => new Date() },
    firstReplyAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    /** A team reply the user has not opened yet. */
    userUnread: { type: Boolean, default: false },
    /** A user message the team has not opened yet. */
    adminUnread: { type: Boolean, default: true },
  },
  { timestamps: true },
);
supportTicketSchema.index({ user: 1, lastMessageAt: -1 });
supportTicketSchema.index({ status: 1, role: 1, lastMessageAt: -1 });
export const SupportTicket = model('SupportTicket', supportTicketSchema);
