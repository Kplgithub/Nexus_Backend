import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';
import { ADMIN_ROLES, ENQUIRY_STATUSES, ENQUIRY_TYPES, FAQ_CATEGORIES } from '@nexus/shared';

/* ---------------- Admin ---------------- */
const adminSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ADMIN_ROLES, default: 'admin' },
    active: { type: Boolean, default: true },
    /** Incremented on password change or "sign out everywhere" — invalidates existing sessions. */
    tokenVersion: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: Date,
  },
  { timestamps: true },
);
adminSchema.index({ email: 1 }, { unique: true });
export type AdminDoc = HydratedDocument<InferSchemaType<typeof adminSchema>>;
export const Admin = model('Admin', adminSchema);

/* ---------------- Notes (shared sub-doc) ---------------- */
const noteSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 2000 },
    by: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

/* ---------------- Enquiry ---------------- */
const enquirySchema = new Schema(
  {
    leadId: { type: String, required: true },
    type: { type: String, enum: ENQUIRY_TYPES, default: 'general' },
    name: { type: String, required: true, maxlength: 80 },
    phone: { type: String, required: true, maxlength: 20 },
    email: { type: String, maxlength: 120, default: null },
    message: { type: String, default: '', maxlength: 2000 },
    property: { type: Schema.Types.ObjectId, ref: 'Property', default: null },
    /** Snapshot so the lead still makes sense if the listing is later deleted. */
    propertySnapshot: {
      title: String,
      slug: String,
    },
    sourcePage: { type: String, maxlength: 300, default: null },
    preferredContactTime: { type: String, maxlength: 60, default: null },
    status: { type: String, enum: ENQUIRY_STATUSES, default: 'new' },
    followUpAt: { type: Date, default: null },
    assignedTo: { type: String, maxlength: 80, default: null },
    notes: { type: [noteSchema], default: [] },
    consentAt: { type: Date, required: true },
    consentText: { type: String, maxlength: 300 },
    /** Hashed client IP (never the raw IP) for abuse investigation. */
    ipHash: { type: String, maxlength: 64 },
    userAgent: { type: String, maxlength: 300 },
    spamScore: { type: Number, default: 0 },
    /** The signed-in visitor who sent it, if any. */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** The user who posted the listing, if any — they see this lead in their dashboard. */
    listingOwner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    seenByOwner: { type: Boolean, default: false },
  },
  { timestamps: true },
);
enquirySchema.index({ leadId: 1 }, { unique: true });
enquirySchema.index({ status: 1, createdAt: -1 });
enquirySchema.index({ property: 1, createdAt: -1 });
enquirySchema.index({ followUpAt: 1, status: 1 });
enquirySchema.index({ phone: 1, createdAt: -1 });
enquirySchema.index({ listingOwner: 1, createdAt: -1 });
enquirySchema.index({ user: 1, createdAt: -1 });
export const Enquiry = model('Enquiry', enquirySchema);

/* ---------------- Locations ---------------- */
const localitySchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    slug: { type: String, required: true, lowercase: true, maxlength: 100 },
    active: { type: Boolean, default: true },
    intro: { type: String, default: '', maxlength: 3000 },
    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },
  },
  { _id: false },
);

const citySchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 60 },
    slug: { type: String, required: true, lowercase: true, maxlength: 100 },
    state: { type: String, required: true, maxlength: 60 },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    intro: { type: String, default: '', maxlength: 4000 },
    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },
    localities: { type: [localitySchema], default: [] },
  },
  { timestamps: true },
);
citySchema.index({ slug: 1 }, { unique: true });
citySchema.index({ active: 1, sortOrder: 1 });
export const City = model('City', citySchema);

/* ---------------- FAQ ---------------- */
const faqSchema = new Schema(
  {
    question: { type: String, required: true, maxlength: 200 },
    answer: { type: String, required: true, maxlength: 3000 },
    category: { type: String, enum: FAQ_CATEGORIES, default: 'general' },
    sortOrder: { type: Number, default: 0 },
    published: { type: Boolean, default: true },
    showOnHome: { type: Boolean, default: false },
  },
  { timestamps: true },
);
faqSchema.index({ published: 1, category: 1, sortOrder: 1 });
export const Faq = model('Faq', faqSchema);

/* ---------------- Site settings (singleton) ---------------- */
const siteSettingsSchema = new Schema(
  {
    key: { type: String, default: 'site', immutable: true },
    data: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, minimize: false },
);
siteSettingsSchema.index({ key: 1 }, { unique: true });
export const SiteSettings = model('SiteSettings', siteSettingsSchema);

/* ---------------- Slug redirects ---------------- */
const slugRedirectSchema = new Schema(
  {
    fromSlug: { type: String, required: true },
    property: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
  },
  { timestamps: true },
);
slugRedirectSchema.index({ fromSlug: 1 }, { unique: true });
export const SlugRedirect = model('SlugRedirect', slugRedirectSchema);

/* ---------------- Audit log ---------------- */
const auditSchema = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    actorEmail: { type: String },
    action: { type: String, required: true },
    entity: { type: String, required: true },
    entityId: { type: String },
    summary: { type: String, maxlength: 500 },
    ipHash: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
auditSchema.index({ createdAt: -1 });
auditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
export const AuditLog = model('AuditLog', auditSchema);

/* ---------------- Counters (for human-readable lead IDs) ---------------- */
const counterSchema = new Schema({ _id: { type: String }, seq: { type: Number, default: 0 } });
export const Counter = model('Counter', counterSchema);
