import type { z } from 'zod';
import {
  isBusinessRole,
  normalizePhone,
  slugify,
  type SessionUser,
  type UserRole,
  type profileUpdateSchema,
  type quickStartSchema,
  type quickVerifySchema,
  type signupSchema,
} from '@nexus/shared';
import { businessAlert } from './notification.service.js';
import { env, mailEnabled, otpEnabled } from '../config/env.js';
import { AppError, badRequest, conflict, notFound, unauthorized } from '../lib/errors.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { User, type UserAttrs } from '../models/user.model.js';
import { City } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { burnTime, hashPassword, passwordNeedsRehash, verifyPassword } from './auth.service.js';
import { sendOtp, verifyOtp } from './otp.service.js';
import { sendMail } from './mail.service.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;

type UserLean = UserAttrs & { _id: unknown; createdAt: Date };

export function toSessionUser(u: UserLean): SessionUser {
  return {
    id: String(u._id),
    role: u.role as UserRole,
    name: u.name,
    email: u.email,
    phone: u.phone,
    phoneVerified: u.phoneVerified,
    companyName: u.companyName ?? null,
    reraNumber: u.reraNumber ?? null,
    about: u.about ?? null,
    citySlug: u.citySlug ?? null,
    showPhone: u.showPhone,
    whatsappEnabled: u.whatsappEnabled,
    verified: u.verified,
    createdAt: new Date(u.createdAt).toISOString(),
    experienceYears: u.experienceYears ?? null,
    website: u.website ?? null,
    logoUrl: u.logoUrl ?? null,
    localities: u.localities ?? [],
    profileSlug: u.profileSlug ?? null,
  };
}

/** A free profile slug for an agent or builder, from their business name. */
export async function uniqueProfileSlug(base: string, excludeId?: unknown): Promise<string> {
  const root = slugify(base).slice(0, 80) || 'profile';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await User.exists({
      profileSlug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!taken) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

/** Indian mobile numbers only for accounts. */
export function requireMobile(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) {
    throw badRequest('Invalid mobile number', {
      phone: ['Enter a valid 10-digit Indian mobile number'],
    });
  }
  return phone;
}

const looksLikeEmail = (s: string) => s.includes('@');

function identifierFilter(identifier: string) {
  if (looksLikeEmail(identifier)) return { email: identifier.trim().toLowerCase() };
  const phone = normalizePhone(identifier);
  return phone ? { phone } : null;
}

async function findByIdentifier(identifier: string) {
  const filter = identifierFilter(identifier);
  return filter ? User.findOne(filter) : null;
}

export async function signup(input: z.output<typeof signupSchema>, ipHash?: string) {
  const phone = requireMobile(input.phone);
  const [emailTaken, phoneTaken] = await Promise.all([
    User.exists({ email: input.email }),
    User.exists({ phone }),
  ]);
  const details: Record<string, string[]> = {};
  if (emailTaken) details.email = ['An account with this email already exists. Sign in instead.'];
  if (phoneTaken) details.phone = ['An account with this mobile number already exists.'];
  if (Object.keys(details).length)
    throw new AppError(409, 'ACCOUNT_EXISTS', 'Account already exists', details);

  let citySlug: string | null = null;
  if (input.citySlug && (await City.exists({ slug: input.citySlug, active: true }))) {
    citySlug = input.citySlug;
  }

  const user = await User.create({
    role: input.role,
    name: input.name,
    email: input.email,
    phone,
    passwordHash: await hashPassword(input.password),
    companyName: isBusinessRole(input.role) ? input.companyName?.trim() || null : null,
    reraNumber: input.reraNumber?.trim() || null,
    citySlug,
    profileSlug: isBusinessRole(input.role)
      ? await uniqueProfileSlug(input.companyName?.trim() || input.name)
      : undefined,
    termsAcceptedAt: new Date(),
    signupIpHash: ipHash,
    verificationStatus: isBusinessRole(input.role) ? 'pending' : 'unverified',
  });
  if (isBusinessRole(input.role)) {
    void businessAlert('signup', {
      title: `New ${input.role} signed up: ${input.companyName?.trim() || input.name}`,
      body: 'Check their details and verify the profile.',
      link: '/admin/verification',
    });
  }
  return user;
}

export async function login(identifier: string, password: string) {
  const filter = identifierFilter(identifier);
  const withHash = filter ? await User.findOne(filter).select('+passwordHash') : null;
  if (!withHash) {
    await burnTime(password);
    throw unauthorized('Incorrect email/mobile or password');
  }
  if (withHash.status !== 'active') {
    throw new AppError(403, 'BLOCKED', 'This account has been suspended. Contact NEXUS Estate.');
  }
  if (withHash.lockedUntil && withHash.lockedUntil > new Date()) {
    throw new AppError(423, 'LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
  }
  if (!(await verifyPassword(withHash.passwordHash, password))) {
    withHash.failedLogins += 1;
    if (withHash.failedLogins >= MAX_FAILED) {
      withHash.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      withHash.failedLogins = 0;
    }
    await withHash.save();
    throw unauthorized('Incorrect email/mobile or password');
  }
  withHash.failedLogins = 0;
  withHash.lockedUntil = null;
  withHash.lastLoginAt = new Date();
  if (passwordNeedsRehash(withHash.passwordHash)) {
    withHash.passwordHash = await hashPassword(password);
  }
  await withHash.save();
  return withHash;
}

export async function requestLoginOtp(rawPhone: string, ipHash?: string) {
  const phone = requireMobile(rawPhone);
  const user = await User.findOne({ phone }).select('status').lean();
  // Don't reveal whether the number is registered: behave the same, but only send to members.
  if (!user || user.status !== 'active') {
    return { expiresIn: 600, resendIn: 30, devCode: undefined as string | undefined };
  }
  return sendOtp(phone, 'login', ipHash);
}

export async function loginWithOtp(rawPhone: string, code: string) {
  const phone = requireMobile(rawPhone);
  const user = await User.findOne({ phone });
  if (!user) throw badRequest('Incorrect code', { code: ['Incorrect code'] });
  await verifyOtp(phone, 'login', code);
  if (user.status !== 'active') {
    throw new AppError(403, 'BLOCKED', 'This account has been suspended. Contact NEXUS Estate.');
  }
  user.phoneVerified = true; // receiving the SMS proves ownership
  user.lastLoginAt = new Date();
  await user.save();
  return user;
}

export async function requestPhoneVerification(userId: string, ipHash?: string) {
  const user = await User.findById(userId).select('phone phoneVerified').lean();
  if (!user) throw unauthorized();
  if (user.phoneVerified) return { alreadyVerified: true as const };
  return sendOtp(user.phone, 'verify', ipHash);
}

export async function confirmPhoneVerification(userId: string, code: string) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  await verifyOtp(user.phone, 'verify', code);
  user.phoneVerified = true;
  await user.save();
  return user;
}

/**
 * Starts a password reset. Phone → SMS code; email → link (when SMTP is set up).
 * The response is identical whether or not an account exists.
 */
export async function forgotPassword(identifier: string, ipHash?: string) {
  const user = await findByIdentifier(identifier);
  if (looksLikeEmail(identifier)) {
    if (!mailEnabled) {
      throw new AppError(
        503,
        'EMAIL_RESET_DISABLED',
        otpEnabled
          ? 'Reset by email is not available. Use your mobile number instead.'
          : 'Password reset is not available yet. Please contact NEXUS Estate.',
      );
    }
    if (user && user.status === 'active') {
      const token = randomToken(32);
      await User.updateOne(
        { _id: user._id },
        {
          resetTokenHash: sha256(token),
          resetTokenExpires: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
        },
      );
      await sendMail(
        user.email,
        'Reset your NEXUS Estate password',
        [
          `Hi ${user.name},`,
          `Use the link below to choose a new password. It expires in ${RESET_TTL_MINUTES} minutes.`,
          'If you did not ask for this, you can ignore this email.',
        ],
        { label: 'Reset password', url: `${env.PUBLIC_SITE_URL}/reset-password?token=${token}` },
      );
    }
    return { channel: 'email' as const };
  }
  const phone = requireMobile(identifier);
  if (!otpEnabled) {
    throw new AppError(
      503,
      'OTP_DISABLED',
      mailEnabled
        ? 'Reset by SMS is not available. Use your email address instead.'
        : 'Password reset is not available yet. Please contact NEXUS Estate.',
    );
  }
  if (user && user.status === 'active') {
    const sent = await sendOtp(phone, 'reset', ipHash);
    return { channel: 'sms' as const, devCode: sent.devCode };
  }
  return { channel: 'sms' as const };
}

export async function resetPassword(input: {
  phone?: string;
  code?: string;
  token?: string;
  password: string;
}) {
  let user;
  if (input.token) {
    user = await User.findOne({
      resetTokenHash: sha256(input.token),
      resetTokenExpires: { $gt: new Date() },
    });
    if (!user) throw badRequest('This reset link has expired. Request a new one.');
  } else {
    const phone = requireMobile(input.phone!);
    user = await User.findOne({ phone });
    if (!user) throw badRequest('Incorrect code', { code: ['Incorrect code'] });
    await verifyOtp(phone, 'reset', input.code!);
    user.phoneVerified = true;
  }
  user.passwordHash = await hashPassword(input.password);
  user.set({ resetTokenHash: null, resetTokenExpires: null });
  user.tokenVersion += 1;
  user.failedLogins = 0;
  user.lockedUntil = null;
  await user.save();
  return user;
}

export async function getMe(userId: string) {
  const u = await User.findById(userId).lean<UserLean>();
  if (!u) throw notFound('Account not found');
  return toSessionUser(u);
}

export async function updateProfile(userId: string, patch: z.output<typeof profileUpdateSchema>) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  if (patch.email && patch.email !== user.email) {
    if (await User.exists({ email: patch.email, _id: { $ne: user._id } })) {
      throw conflict('Another account uses this email');
    }
    user.email = patch.email;
  }
  if (patch.phone) {
    const phone = requireMobile(patch.phone);
    if (phone !== user.phone) {
      if (await User.exists({ phone, _id: { $ne: user._id } })) {
        throw conflict('Another account uses this mobile number');
      }
      user.phone = phone;
      user.phoneVerified = false;
    }
  }
  if (patch.citySlug !== undefined) {
    user.citySlug =
      patch.citySlug && (await City.exists({ slug: patch.citySlug })) ? patch.citySlug : null;
  }
  if (patch.name) user.name = patch.name;
  if (patch.companyName !== undefined && isBusinessRole(user.role as UserRole)) {
    if (!patch.companyName.trim()) {
      throw badRequest('Company name is required', { companyName: ['This field is required'] });
    }
    user.companyName = patch.companyName.trim();
  }
  if (patch.reraNumber !== undefined) user.reraNumber = patch.reraNumber.trim() || null;
  if (patch.about !== undefined) user.about = patch.about.trim() || null;
  if (patch.showPhone !== undefined) user.showPhone = patch.showPhone;
  if (patch.whatsappEnabled !== undefined) user.whatsappEnabled = patch.whatsappEnabled;
  if (isBusinessRole(user.role as UserRole)) {
    if (patch.experienceYears !== undefined) user.experienceYears = patch.experienceYears;
    if (patch.website !== undefined) user.website = patch.website || null;
    if (patch.logoUrl !== undefined) user.logoUrl = patch.logoUrl || null;
    if (patch.localities !== undefined) {
      const city = user.citySlug ? await City.findOne({ slug: user.citySlug }).lean() : null;
      const known = new Set((city?.localities ?? []).map((l) => l.slug));
      user.localities = [...new Set(patch.localities)].filter((l) => known.has(l));
    }
    if (!user.profileSlug) {
      user.profileSlug = await uniqueProfileSlug(user.companyName || user.name, user._id);
    }
  }
  await user.save();
  return toSessionUser(user.toObject() as unknown as UserLean);
}

export async function changeUserPassword(userId: string, current: string, next: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw unauthorized();
  if (!(await verifyPassword(user.passwordHash, current))) {
    throw badRequest('Current password is incorrect', { currentPassword: ['Incorrect password'] });
  }
  user.passwordHash = await hashPassword(next);
  user.tokenVersion += 1;
  await user.save();
  return user;
}

export async function signOutUserEverywhere(userId: string) {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

/* ---------------- Quick sign-up from the "view number" popup ---------------- */

/** Broker → agent, owner → owner account, buyer or tenant → seeker (never sees plans). */
const intentRole = (intent: string): UserRole =>
  intent === 'broker' ? 'agent' : intent === 'owner' ? 'individual' : 'seeker';

/** A buyer or tenant switches to an owner account so they can list a property. */
export async function becomeOwner(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  if (user.role === 'seeker') {
    user.role = 'individual';
    await user.save();
  }
  return { id: String(user._id), role: user.role as UserRole, tokenVersion: user.tokenVersion };
}

/**
 * One-off, safe to repeat: accounts made from the number popup as a buyer or tenant
 * become seekers, unless they already posted a listing.
 */
export async function migrateSeekers() {
  const candidates = await User.find({
    role: 'individual',
    signupIntent: { $in: ['tenant', 'buyer'] },
  })
    .select('_id')
    .lean();
  if (!candidates.length) return 0;
  const posters = new Set(
    (await Property.distinct('postedBy', { postedBy: { $in: candidates.map((c) => c._id) } })).map(
      String,
    ),
  );
  const ids = candidates.filter((c) => !posters.has(String(c._id))).map((c) => c._id);
  if (!ids.length) return 0;
  const r = await User.updateMany({ _id: { $in: ids }, role: 'individual' }, { role: 'seeker' });
  return r.modifiedCount;
}

/**
 * Step 1: sends an OTP to the visitor's mobile. A known number signs in with it; a new
 * number gets an account once the code is checked. The email must not belong to someone else.
 */
export async function quickStart(input: z.output<typeof quickStartSchema>, ipHash?: string) {
  const phone = requireMobile(input.phone);
  const existing = await User.findOne({ phone }).select('status email').lean();
  if (existing && existing.status !== 'active')
    throw new AppError(403, 'BLOCKED', 'This account has been suspended. Contact NEXUS Estate.');
  if (!existing && (await User.exists({ email: input.email })))
    throw new AppError(409, 'ACCOUNT_EXISTS', 'This email is already used by another account.', {
      email: ['This email is already used by another account. Log in instead.'],
    });
  return sendOtp(phone, existing ? 'login' : 'verify', ipHash);
}

/** Step 2: checks the code, signs the visitor in, and creates the account if it is new. */
export async function quickVerify(input: z.output<typeof quickVerifySchema>, ipHash?: string) {
  const phone = requireMobile(input.phone);
  const existing = await User.findOne({ phone });
  if (existing) {
    await verifyOtp(phone, 'login', input.code);
    if (existing.status !== 'active')
      throw new AppError(403, 'BLOCKED', 'This account has been suspended. Contact NEXUS Estate.');
    existing.phoneVerified = true;
    existing.lastLoginAt = new Date();
    await existing.save();
    return { user: existing, created: false };
  }
  await verifyOtp(phone, 'verify', input.code);
  if (await User.exists({ email: input.email }))
    throw new AppError(409, 'ACCOUNT_EXISTS', 'This email is already used by another account.', {
      email: ['This email is already used by another account. Log in instead.'],
    });
  const role = intentRole(input.intent);
  const user = await User.create({
    role,
    name: input.name,
    email: input.email,
    phone,
    phoneVerified: true,
    // No password yet: they sign in with an OTP, or set one with "Forgot password".
    passwordHash: await hashPassword(randomToken()),
    profileSlug: role === 'agent' ? await uniqueProfileSlug(input.name) : undefined,
    signupIntent: input.intent,
    termsAcceptedAt: new Date(),
    signupIpHash: ipHash,
    verificationStatus: role === 'agent' ? 'pending' : 'unverified',
    lastLoginAt: new Date(),
  });
  if (role === 'agent')
    void businessAlert('signup', {
      title: `New agent signed up: ${input.name}`,
      body: 'Signed up while viewing a number. Check their details and verify the profile.',
      link: '/admin/verification',
    });
  return { user, created: true };
}
