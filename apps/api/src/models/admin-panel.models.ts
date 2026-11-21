import { Schema, model } from 'mongoose';
import { PAYMENT_METHODS, PAYMENT_STATUSES, SITE_VISIT_STATUSES, USER_ROLES } from '@nexus/shared';

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
    price: { type: Number, required: true, min: 1 },
    durationDays: { type: Number, required: true, min: 1 },
    listingLimit: { type: Number, required: true, min: 1 },
    featuredListings: { type: Number, default: 0 },
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
    plan: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    planSnapshot: {
      name: String,
      durationDays: Number,
      listingLimit: Number,
      featuredListings: Number,
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
  },
  { timestamps: true },
);
paymentSchema.index({ user: 1, status: 1, endsAt: -1 });
paymentSchema.index({ status: 1, createdAt: -1 });
paymentSchema.index({ orderId: 1 }, { unique: true, sparse: true });
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
