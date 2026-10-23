import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/** One-way hash of an IP so we can rate-limit/investigate abuse without storing raw IPs. */
export function hashIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHmac('sha256', env.JWT_SECRET).update(`ip:${ip}`).digest('hex').slice(0, 32);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
