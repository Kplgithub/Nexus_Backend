import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OTP_PHONE_PER_DAY, OTP_PHONE_PER_HOUR } from '@nexus/shared';
import { resetDb, startDb, stopDb } from './helpers.js';
import { env } from '../src/config/env.js';
import { Otp, OtpSend } from '../src/models/user.model.js';
import { sendOtp } from '../src/services/otp.service.js';

const PHONE = '+919829099001';
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

/** Pretend codes were sent at these times (minutes ago). */
async function history(minutes: number[], phone = PHONE, ipHash?: string) {
  await OtpSend.insertMany(minutes.map((m) => ({ phone, ipHash, createdAt: minsAgo(m) })));
}

beforeAll(async () => {
  await startDb();
});
afterAll(stopDb);
beforeEach(resetDb);
afterEach(() => {
  env.TEST_OTP_UNTIL = undefined;
});

describe('OTP send limits', () => {
  it('sends a first code and records it', async () => {
    await expect(sendOtp(PHONE, 'login')).resolves.toMatchObject({ resendIn: 30 });
    expect(await OtpSend.countDocuments({ phone: PHONE })).toBe(1);
  });

  it('asks to wait between two codes, with the seconds left', async () => {
    await sendOtp(PHONE, 'login');
    await expect(sendOtp(PHONE, 'login')).rejects.toMatchObject({
      code: 'OTP_TOO_SOON',
      message: expect.stringMatching(/new one in \d+ seconds/),
    });
  });

  it(`allows ${OTP_PHONE_PER_HOUR} codes an hour, then says how many minutes to wait`, async () => {
    await history(Array.from({ length: OTP_PHONE_PER_HOUR - 1 }, (_, i) => 50 - i));
    await expect(sendOtp(PHONE, 'login')).resolves.toBeDefined();
    await Otp.deleteMany({});
    const err = await sendOtp(PHONE, 'login').catch((e) => e);
    expect(err.code).toBe('OTP_LIMIT');
    expect(err.message).toMatch(/use the last code we sent, or try again in about 1\d minutes/);
    expect(err.message).not.toMatch(/Too many/);
  });

  it('does not count codes older than an hour toward the hourly limit', async () => {
    await history(Array.from({ length: OTP_PHONE_PER_HOUR }, () => 61));
    await expect(sendOtp(PHONE, 'login')).resolves.toBeDefined();
  });

  it(`caps a number at ${OTP_PHONE_PER_DAY} codes a day`, async () => {
    await history(Array.from({ length: OTP_PHONE_PER_DAY }, (_, i) => 120 + i * 30));
    const err = await sendOtp(PHONE, 'login').catch((e) => e);
    expect(err.code).toBe('OTP_LIMIT');
    expect(err.message).toMatch(/today/);
  });

  it('caps one network at 100 codes a day across numbers', async () => {
    await OtpSend.insertMany(
      Array.from({ length: 100 }, (_, i) => ({
        phone: `+9198290${String(10000 + i)}`,
        ipHash: 'ip1',
        createdAt: minsAgo(100),
      })),
    );
    await expect(sendOtp(PHONE, 'login', 'ip1')).rejects.toMatchObject({ code: 'OTP_LIMIT' });
    await expect(sendOtp(PHONE, 'login', 'ip2')).resolves.toBeDefined();
  });

  it('skips the hourly and daily caps while the test code is on (no SMS is sent)', async () => {
    env.TEST_OTP_UNTIL = new Date(Date.now() + 60 * 60_000).toISOString();
    await history(Array.from({ length: OTP_PHONE_PER_DAY }, (_, i) => 5 + i));
    await expect(sendOtp(PHONE, 'login')).resolves.toBeDefined();
  });
});
