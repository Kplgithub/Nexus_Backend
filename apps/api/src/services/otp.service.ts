import { createHmac, randomInt } from 'node:crypto';
import {
  OTP_LENGTH,
  OTP_IP_PER_DAY,
  OTP_MAX_ATTEMPTS,
  OTP_PHONE_PER_DAY,
  OTP_PHONE_PER_HOUR,
  OTP_RESEND_SECONDS,
  OTP_TTL_SECONDS,
  type OtpPurpose,
} from '@nexus/shared';
import { env, isProd, otpEnabled } from '../config/env.js';
import { AppError, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { safeEqual } from '../lib/crypto.js';
import { Otp, OtpSend } from '../models/user.model.js';
import { isTestOtpActive, TEST_OTP_CODE } from '../lib/test-otp.js';

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
  const sinceLast = last ? Date.now() - new Date(last.createdAt as Date).getTime() : Infinity;
  if (sinceLast < OTP_RESEND_SECONDS * 1000) {
    const wait = Math.max(1, Math.ceil(OTP_RESEND_SECONDS - sinceLast / 1000));
    throw new AppError(
      429,
      'OTP_TOO_SOON',
      `We just sent you a code. You can ask for a new one in ${wait} seconds.`,
    );
  }

  // Launch testing: fixed code and no SMS until it expires (see lib/test-otp.ts).
  const testPhone = isTestOtpActive();
  // No SMS is sent in test mode, so the hourly and daily caps (which protect SMS cost) are skipped.
  if (!testPhone) await checkSendLimits(phone, ipHash);

  const code = testPhone
    ? TEST_OTP_CODE
    : String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
  await Otp.create({
    phone,
    purpose,
    codeHash: hashCode(phone, purpose, code),
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    ipHash,
  });
  await OtpSend.create({ phone, ipHash });
  if (testPhone) {
    logger.warn({ phone }, 'Launch-test OTP active: fixed code, no SMS sent');
    return { expiresIn: OTP_TTL_SECONDS, resendIn: OTP_RESEND_SECONDS, devCode: undefined };
  }
  const devCode = await deliver(phone, code);
  return { expiresIn: OTP_TTL_SECONDS, resendIn: OTP_RESEND_SECONDS, devCode };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** "about 12 minutes" / "about 3 hours" until the oldest counted code leaves the window. */
function waitText(oldest: Date | undefined, windowMs: number) {
  const ms = oldest ? oldest.getTime() + windowMs - Date.now() : windowMs;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `about ${hours} hour${hours === 1 ? '' : 's'}`;
}

async function oldestIn(filter: Record<string, unknown>, since: Date, skip: number) {
  const row = await OtpSend.find({ ...filter, createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .skip(skip)
    .limit(1)
    .select('createdAt')
    .lean();
  return row[0]?.createdAt as Date | undefined;
}

/** Per-number hourly/daily and per-network daily caps on codes sent by SMS. */
async function checkSendLimits(phone: string, ipHash?: string) {
  const hourAgo = new Date(Date.now() - HOUR);
  const dayAgo = new Date(Date.now() - DAY);
  const [perHour, perDay, perIp] = await Promise.all([
    OtpSend.countDocuments({ phone, createdAt: { $gte: hourAgo } }),
    OtpSend.countDocuments({ phone, createdAt: { $gte: dayAgo } }),
    ipHash ? OtpSend.countDocuments({ ipHash, createdAt: { $gte: dayAgo } }) : 0,
  ]);
  if (perDay >= OTP_PHONE_PER_DAY) {
    const at = await oldestIn({ phone }, dayAgo, perDay - OTP_PHONE_PER_DAY);
    throw new AppError(
      429,
      'OTP_LIMIT',
      `You've asked for a lot of codes on this number today. Please use the last code we sent, log in with your password, or try again in ${waitText(at, DAY)}.`,
    );
  }
  if (perHour >= OTP_PHONE_PER_HOUR) {
    const at = await oldestIn({ phone }, hourAgo, perHour - OTP_PHONE_PER_HOUR);
    throw new AppError(
      429,
      'OTP_LIMIT',
      `You've asked for a few codes already. Please use the last code we sent, or try again in ${waitText(at, HOUR)}.`,
    );
  }
  if (ipHash && perIp >= OTP_IP_PER_DAY) {
    throw new AppError(
      429,
      'OTP_LIMIT',
      'We could not send a code right now. Please log in with your password, or try again later.',
    );
  }
}

/** Checks and consumes the latest code for this phone and purpose. */
export async function verifyOtp(phone: string, purpose: OtpPurpose, code: string) {
  const otp = await Otp.findOne({ phone, purpose, consumedAt: null }).sort({ createdAt: -1 });
  if (!otp || otp.expiresAt < new Date()) {
    const msg = 'This code has expired. Please tap "Resend code" for a new one.';
    throw badRequest(msg, { code: [msg] });
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    const msg =
      'This code was entered wrong too many times. Please tap "Resend code" for a new one.';
    throw badRequest(msg, { code: [msg] });
  }
  if (!safeEqual(otp.codeHash, hashCode(phone, purpose, code))) {
    otp.attempts += 1;
    await otp.save();
    throw badRequest('Incorrect code', { code: ['Incorrect code'] });
  }
  otp.consumedAt = new Date();
  await otp.save();
}
