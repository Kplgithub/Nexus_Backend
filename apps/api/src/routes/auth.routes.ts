import { Router, type Router as RouterType } from 'express';
import {
  forgotPasswordSchema,
  otpLoginSchema,
  otpRequestSchema,
  resetPasswordSchema,
  signupSchema,
  userLoginSchema,
  type AuthConfig,
} from '@nexus/shared';
import { mailEnabled, otpEnabled } from '../config/env.js';
import { limiters } from '../middleware/security.js';
import { parseBody } from '../middleware/validate.js';
import { clearUserSession, issueUserSession } from '../middleware/user-auth.js';
import { created, ok } from '../lib/respond.js';
import { badRequest } from '../lib/errors.js';
import { hashIp } from '../lib/crypto.js';
import * as users from '../services/user.service.js';

/** Public sign-up and sign-in for website users. */
export const authRouter: RouterType = Router();

authRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const sessionFor = (u: { _id: unknown; role: string; tokenVersion: number }) => ({
  id: String(u._id),
  role: u.role as 'individual' | 'agent' | 'builder',
  tokenVersion: u.tokenVersion,
});

authRouter.get('/config', (_req, res) => {
  const config: AuthConfig = { otpEnabled, emailResetEnabled: mailEnabled };
  ok(res, config);
});

authRouter.post('/signup', limiters.signup, async (req, res) => {
  const input = parseBody(signupSchema, req);
  if (input.website) throw badRequest('Sign-up failed'); // honeypot
  const user = await users.signup(input, hashIp(req.ip));
  issueUserSession(res, sessionFor(user));
  // Start phone verification straight away when SMS is available.
  let otp: Awaited<ReturnType<typeof users.requestPhoneVerification>> | null = null;
  if (otpEnabled) {
    otp = await users.requestPhoneVerification(String(user._id), hashIp(req.ip)).catch(() => null);
  }
  created(res, {
    user: await users.getMe(String(user._id)),
    verification:
      otp && 'expiresIn' in otp ? { sent: true, devCode: otp.devCode } : { sent: false },
  });
});

authRouter.post('/login', limiters.userLogin, async (req, res) => {
  const { identifier, password } = parseBody(userLoginSchema, req);
  const user = await users.login(identifier, password);
  issueUserSession(res, sessionFor(user));
  ok(res, { user: await users.getMe(String(user._id)) });
});

authRouter.post('/otp/request', limiters.otp, async (req, res) => {
  const { phone, purpose } = parseBody(otpRequestSchema, req);
  if (purpose !== 'login') throw badRequest('Use the matching endpoint for this purpose');
  const sent = await users.requestLoginOtp(phone, hashIp(req.ip));
  ok(res, {
    sent: true,
    expiresIn: sent.expiresIn,
    resendIn: sent.resendIn,
    devCode: sent.devCode,
  });
});

authRouter.post('/otp/login', limiters.userLogin, async (req, res) => {
  const { phone, code } = parseBody(otpLoginSchema, req);
  const user = await users.loginWithOtp(phone, code);
  issueUserSession(res, sessionFor(user));
  ok(res, { user: await users.getMe(String(user._id)) });
});

authRouter.post('/forgot-password', limiters.otp, async (req, res) => {
  const { identifier } = parseBody(forgotPasswordSchema, req);
  const result = await users.forgotPassword(identifier, hashIp(req.ip));
  ok(res, {
    channel: result.channel,
    devCode: 'devCode' in result ? result.devCode : undefined,
    message:
      result.channel === 'email'
        ? 'If an account exists for this email, we have sent a reset link.'
        : 'If an account exists for this number, we have sent a reset code.',
  });
});

authRouter.post('/reset-password', limiters.userLogin, async (req, res) => {
  const input = parseBody(resetPasswordSchema, req);
  const user = await users.resetPassword(input);
  issueUserSession(res, sessionFor(user));
  ok(res, { user: await users.getMe(String(user._id)) });
});

authRouter.post('/logout', (_req, res) => {
  clearUserSession(res);
  ok(res, { signedOut: true });
});
