import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Optional Redis, used only to make the site faster and to share state between
 * server processes. It is never required: with REDIS_URL unset, or while Redis
 * is down or slow, every helper here silently does nothing and the caller falls
 * back to the database / in-memory behaviour. Commands fail fast (200 ms) so a
 * sick Redis can never make the site slow.
 */
const PREFIX = 'nx:';
const COMMAND_TIMEOUT_MS = 200;

let client: Redis | null | undefined;
let lastWarn = 0;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  if (!env.REDIS_URL) {
    client = null;
    return client;
  }
  client = new Redis(env.REDIS_URL, {
    keyPrefix: PREFIX,
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: COMMAND_TIMEOUT_MS,
    retryStrategy: (n) => Math.min(n * 200, 5_000),
  });
  client.on('error', (err: Error) => {
    // One line a minute at most, so a Redis outage does not flood the logs.
    if (Date.now() - lastWarn > 60_000) {
      lastWarn = Date.now();
      logger.warn({ err: err.message }, 'redis unavailable, using fallback');
    }
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  const c = client;
  client = undefined;
  if (c) await c.quit().catch(() => c.disconnect());
}

/** Test helper: forget the client so the next call re-reads REDIS_URL. */
export function resetRedisForTests() {
  client = undefined;
}

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 20);

/** A namespace's current generation. Bumping it makes every old key of that namespace unreachable. */
async function generation(ns: string): Promise<string | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get(`gen:${ns}`)) ?? '0';
  } catch {
    return null;
  }
}

/** Drops every cached value of a namespace at once (they expire on their own shortly after). */
export function bumpCache(ns: 'public' | 'user'): void {
  const r = getRedis();
  if (!r) return;
  r.incr(`gen:${ns}`).catch(() => undefined);
}

/**
 * Returns the cached JSON for (ns, key) or runs `load`, stores the result for
 * `ttlSeconds`, and returns it. If Redis is off or erroring, just runs `load`.
 */
export async function cached<T>(
  ns: 'public' | 'user',
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<T> {
  const r = getRedis();
  const gen = await generation(ns);
  if (!r || gen === null) return load();
  const k = `c:${ns}:${gen}:${hash(key)}`;
  try {
    const hit = await r.get(k);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return load();
  }
  const value = await load();
  if (value !== undefined) {
    r.set(k, JSON.stringify(value), 'EX', ttlSeconds).catch(() => undefined);
  }
  return value;
}

/** Runs `fn` only on one process at a time (e.g. background sweeps). With no Redis, always runs. */
export async function withLock(name: string, ttlSeconds: number, fn: () => Promise<void>) {
  const r = getRedis();
  if (r) {
    try {
      const got = await r.set(`lock:${name}`, '1', 'EX', ttlSeconds, 'NX');
      if (got !== 'OK') return;
    } catch {
      // Redis down: run anyway; the sweeps are safe to repeat.
    }
  }
  await fn();
}
