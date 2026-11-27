import {
  MemoryStore,
  type ClientRateLimitInfo,
  type Options,
  type Store,
} from 'express-rate-limit';
import { getRedis } from './redis.js';

/**
 * Rate-limit counters kept in Redis so they are shared by every server process
 * and survive deploys. If Redis is missing or fails, the same request is counted
 * in memory instead, so limits (OTP, login) never switch off.
 */
export class RedisFallbackStore implements Store {
  localKeys = false;
  prefix: string;
  private windowMs = 60_000;
  private memory = new MemoryStore();

  constructor(name: string) {
    this.prefix = `rl:${name}:`;
  }

  init(options: Options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const r = getRedis();
    if (r) {
      try {
        const k = this.prefix + key;
        const res = await r.multi().incr(k).pttl(k).exec();
        const hits = Number(res?.[0]?.[1]);
        let ttl = Number(res?.[1]?.[1]);
        if (!Number.isFinite(hits)) throw new Error('bad reply');
        if (!(ttl > 0)) {
          await r.pexpire(k, this.windowMs);
          ttl = this.windowMs;
        }
        return { totalHits: hits, resetTime: new Date(Date.now() + ttl) };
      } catch {
        // fall through to memory
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key: string) {
    const r = getRedis();
    if (r) await r.decr(this.prefix + key).catch(() => undefined);
    await this.memory.decrement(key);
  }

  async resetKey(key: string) {
    const r = getRedis();
    if (r) await r.del(this.prefix + key).catch(() => undefined);
    await this.memory.resetKey(key);
  }

  shutdown() {
    this.memory.shutdown();
  }
}
