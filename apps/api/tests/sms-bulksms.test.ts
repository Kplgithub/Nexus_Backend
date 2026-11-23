import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, startDb, stopDb } from './helpers.js';
import { env } from '../src/config/env.js';
import { bulkSmsOtpText, sendOtp } from '../src/services/otp.service.js';

const PHONE = '+919829099002';

beforeAll(async () => {
  await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  env.SMS_DRIVER = 'bulksms';
  env.BULKSMS_AUTH_KEY = 'test-key';
});
afterEach(() => {
  env.SMS_DRIVER = 'console';
  env.BULKSMS_AUTH_KEY = undefined;
  vi.restoreAllMocks();
});

describe('BulkSMS OTP gateway', () => {
  it('sends the DLT template text with the code to 91XXXXXXXXXX', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ status: 'Success' }), { status: 200 }));
    const r = await sendOtp(PHONE, 'login');
    expect(r.devCode).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://sms.bulksmsserviceproviders.com/api/send/sms');
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      auth_key: 'test-key',
      receivers: '919829099002',
      sender: 'DNHIRE',
      route: 'TR',
      message: { Template_ID: '1107175679254991157', coding: 1 },
    });
    const code = body.message.msgdata.match(/otp is (\d{6})\./)![1];
    expect(body.message.msgdata).toBe(bulkSmsOtpText(code));
  });

  it('fails loudly when the gateway does not answer "Success"', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'Failed', message: 'Invalid template' }), {
        status: 200,
      }),
    );
    await expect(sendOtp(PHONE, 'login')).rejects.toMatchObject({ code: 'SMS_FAILED' });
  });

  it('fails loudly when the gateway is down', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    await expect(sendOtp(PHONE, 'login')).rejects.toMatchObject({ code: 'SMS_FAILED' });
  });
});
