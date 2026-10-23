import { createHmac, randomInt } from 'node:crypto';
import {
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  type OtpPurpose,
} from '@nexus/shared';
import { env, isProd, otpEnabled } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/crypto.js';
import { Otp } from '../models/user.model.js';

const hashCode = (phone: string, purpose: string, code: string) =>
  createHmac('sha256', env.JWT_SECRET).update(`otp:${phone}:${purpose}:${code}`).digest('hex');

/** Sends the code by SMS. Returns the code itself only for the development console driver. */
async function deliver(phone: string, code: string): Promise<string | undefined> {
  if (env.SMS_DRIVER === 'console') {
    logger.warn({ phone }, `DEV OTP for ${phone}: ${code}`);
    return isProd ? undefined : code;
  }
  if (env.SMS_DRIVER === 'msg91') {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', env.MSG91_TEMPLATE_ID!);
    url.searchParams.set('mobile', phone.replace(/^\+/, ''));
    url.searchParams.set('otp', code);
    url.searchParams.set('otp_expiry', String(Math.round(OTP_TTL_SECONDS / 60)));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authkey: env.MSG91_AUTH_KEY!, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
      if (!res.ok || body.type === 'error') {
        logger.error({ status: res.status, body }, 'MSG91 OTP send failed');
        throw new Error('sms failed');
      }
    } catch (err) {
      logger.error({ err }, 'SMS delivery failed');
      throw new AppError(502, 'SMS_FAILED', 'We could not send the SMS. Please try again shortly.');
    }
    return undefined;
  }
  throw new AppError(503, 'OTP_DISABLED', 'Sign-in by SMS code is not available yet.');
}

export async function sendOtp(phone: string, purpose: OtpPurpose, ipHash?: string) {
  if (!otpEnabled)
    throw new AppError(503, 'OTP_DISABLED', 'Sign-in by SMS code is not available yet.');

  const last = await Otp.findOne({ phone, purpose }).sort({ createdAt: -1 }).lean();
  if (last && Date.now() - new Date(last.createdAt as Date).getTime() < OTP_RESEND_SECONDS * 1000) {
    throw new AppError(
      429,
      'OTP_TOO_SOON',
      `Please wait ${OTP_RESEND_SECONDS} seconds before requesting another code.`,
    );
  }
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if ((await Otp.countDocuments({ phone, createdAt: { $gte: hourAgo } })) >= 6) {
    throw new AppError(429, 'OTP_LIMIT', 'Too many codes requested. Try again in an hour.');
  }

  const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  await Otp.create({
    phone,
    purpose,
    codeHash: hashCode(phone, purpose, code),
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    ipHash,
  });
  const devCode = await deliver(phone, code);
  return { expiresIn: OTP_TTL_SECONDS, resendIn: OTP_RESEND_SECONDS, devCode };
}

/** Checks and consumes the latest code for this phone and purpose. */
export async function verifyOtp(phone: string, purpose: OtpPurpose, code: string) {
  const otp = await Otp.findOne({ phone, purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!otp || otp.expiresAt < new Date()) {
    throw badRequest('This code has expired. Request a new one.', {
      code: ['This code has expired. Request a new one.'],
    });
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    throw badRequest('Too many wrong attempts. Request a new code.', {
      code: ['Too many wrong attempts. Request a new code.'],
    });
  }
  if (!safeEqual(otp.codeHash, hashCode(phone, purpose, code))) {
    otp.attempts += 1;
    await otp.save();
    throw badRequest('Incorrect code', { code: ['Incorrect code'] });
  }
  otp.consumedAt = new Date();
  await otp.save();
}
