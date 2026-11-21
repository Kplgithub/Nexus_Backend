import { env, isTest } from '../config/env.js';

/**
 * Temporary launch-testing OTP (requested by the owner on 2026-11-21).
 *
 * While active, EVERY phone number gets the fixed code TEST_OTP_CODE and no SMS
 * is sent. Anyone who knows the code can sign in as any number, so this must
 * never stay on once real users arrive. It switches itself off automatically
 * at TEST_OTP_UNTIL (UTC) so it can't be forgotten.
 *
 * Off sooner: set TEST_OTP_UNTIL to a past date in the API .env and restart,
 * or change BUILT_IN_UNTIL below to a past date and deploy.
 */
const BUILT_IN_UNTIL = '2026-11-23T00:00:00Z';

export const TEST_OTP_CODE = '123456';

export function isTestOtpActive(now = new Date()): boolean {
  // Automated tests use real random codes unless they opt in explicitly.
  if (isTest && !env.TEST_OTP_UNTIL) return false;
  const until = new Date(env.TEST_OTP_UNTIL || BUILT_IN_UNTIL);
  return !Number.isNaN(until.getTime()) && now < until;
}
