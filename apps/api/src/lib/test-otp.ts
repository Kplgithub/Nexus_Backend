import { env, isTest } from '../config/env.js';

/**
 * Temporary launch-testing OTP (requested by the owner on 2026-11-21).
 *
 * While TEST_OTP_ON is true, EVERY phone number gets the fixed code
 * TEST_OTP_CODE and no SMS is sent. Anyone who knows the code can sign in as
 * any number.
 *
 * Turned OFF on 2026-11-23 at the owner's request: every code now goes by SMS (MSG91).
 * For a short test window again, set TEST_OTP_UNTIL to a future date in the API .env
 * and restart the API.
 */
const TEST_OTP_ON = false;

export const TEST_OTP_CODE = '123456';

export function isTestOtpActive(now = new Date()): boolean {
  // Automated tests use real random codes unless they opt in explicitly.
  if (isTest && !env.TEST_OTP_UNTIL) return false;
  if (env.TEST_OTP_UNTIL) {
    const until = new Date(env.TEST_OTP_UNTIL);
    return !Number.isNaN(until.getTime()) && now < until;
  }
  return TEST_OTP_ON;
}
