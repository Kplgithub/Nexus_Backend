import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { OTP_PURPOSES, USER_ROLES, USER_STATUSES, VERIFICATION_STATUSES } from '@nexus/shared';
import { refreshWebsiteOnWrite } from '../lib/web-revalidate.js';

/**
 * Website users: buyers/owners/tenants ("individual"), agents and builders.
 * Kept separate from staff accounts (`Admin`) so a public sign-up can never
 * reach the admin panel.
 */
const noteSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 1000 },
    by: { type: String, required: true },
    at: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    role: { type: String, enum: USER_ROLES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 120 },
    /** E.164, e.g. +919829012345 */
    phone: { type: String, required: true, maxlength: 20 },
    phoneVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true, select: false },

    companyName: { type: String, maxlength: 120, default: null },
    reraNumber: { type: String, maxlength: 60, default: null },
    about: { type: String, maxlength: 1000, default: null },
    citySlug: { type: String, maxlength: 100, default: null },
    experienceYears: { type: Number, min: 0, max: 80, default: null },
    website: { type: String, maxlength: 200, default: null },
    logoUrl: { type: String, maxlength: 1000, default: null },
    /** Locality slugs (in citySlug) an agent works in or a builder builds in. */
    localities: { type: [String], default: [] },
    /** Public profile URL part for agents and builders, e.g. "shree-ram-realty". */
    profileSlug: { type: String, lowercase: true, maxlength: 100, default: undefined },

    /** Let signed-in visitors reveal this number on the user's listings. */
    showPhone: { type: Boolean, default: true },
    whatsappEnabled: { type: Boolean, default: true },
    /** Set by the NEXUS team after checking an agent's or builder's credentials. */
    verified: { type: Boolean, default: false },
    verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: 'unverified' },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, maxlength: 80, default: null },
    verificationNote: { type: String, maxlength: 1000, default: null },
    /** End of the user's paid plan (the latest one). Shows the Premium badge until then. */
    premiumUntil: { type: Date, default: null },
    /** Razorpay customer: saved cards and auto-renew mandates hang off it. */
    razorpayCustomerId: { type: String, default: null },
    /** Free listings used, ever. Deleting a listing does not give the slot back. */
    freePostsUsed: { type: Number, default: 0 },
    /** What they said they were when they signed up from the "view number" popup. */
    signupIntent: {
      type: String,
      enum: ['tenant', 'buyer', 'broker', 'owner', null],
      default: null,
    },

    status: { type: String, enum: USER_STATUSES, default: 'active' },
    saved: { type: [Schema.Types.ObjectId], ref: 'Property', default: [] },
    notes: { type: [noteSchema], default: [] },

    tokenVersion: { type: Number, default: 0 },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },

    resetTokenHash: { type: String, select: false, default: null },
    resetTokenExpires: { type: Date, select: false, default: null },

    termsAcceptedAt: { type: Date, required: true },
    /** Sample accounts created by `pnpm seed:demo`; removed by `pnpm demo:remove`. */
    isDemo: { type: Boolean, default: false },
    signupIpHash: { type: String, maxlength: 64 },
  },
  { timestamps: true },
);
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ phone: 1 }, { unique: true });
userSchema.index({ role: 1, status: 1, createdAt: -1 });
userSchema.index({ role: 1, verificationStatus: 1, createdAt: -1 });
userSchema.index({ profileSlug: 1 }, { unique: true, sparse: true });

// Removing a poster (e.g. demo agents) must drop their public profile right away.
refreshWebsiteOnWrite(userSchema, ['profiles', 'properties'], { deletesOnly: true });

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;
export const User = model('User', userSchema);

/**
 * One-time passwords. Only a keyed hash of the code is stored; documents expire
 * automatically via a TTL index.
 */
const otpSchema = new Schema(
  {
    phone: { type: String, required: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    codeHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    ipHash: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
otpSchema.index({ phone: 1, purpose: 1, createdAt: -1 });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const Otp = model('Otp', otpSchema);

/**
 * One row per code actually sent, kept for a day so hourly and daily limits per
 * number and per network can be counted. (Otp rows are deleted about an hour
 * after they expire, which is too soon for a daily count.)
 */
const otpSendSchema = new Schema({
  phone: { type: String, required: true },
  ipHash: { type: String },
  createdAt: { type: Date, default: () => new Date() },
});
otpSendSchema.index({ phone: 1, createdAt: -1 });
otpSendSchema.index({ ipHash: 1, createdAt: -1 });
otpSendSchema.index({ createdAt: 1 }, { expireAfterSeconds: 25 * 60 * 60 });

export const OtpSend = model('OtpSend', otpSendSchema);
