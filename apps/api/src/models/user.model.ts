import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { OTP_PURPOSES, USER_ROLES, USER_STATUSES } from '@nexus/shared';

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

    /** Let signed-in visitors reveal this number on the user's listings. */
    showPhone: { type: Boolean, default: true },
    whatsappEnabled: { type: Boolean, default: true },
    /** Set by the NEXUS team after checking an agent's or builder's credentials. */
    verified: { type: Boolean, default: false },

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
