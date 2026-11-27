import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REAL = process.env.REDIS_URL;

describe('redis helpers: Redis down or unset', () => {
  it('runs the loader every time and never throws', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { cached, closeRedis, resetRedisForTests, bumpCache, withLock } =
      await import('../src/lib/redis.js');
    const { env } = await import('../src/config/env.js');
    (env as { REDIS_URL?: string }).REDIS_URL = 'redis://127.0.0.1:1';
    resetRedisForTests();
    let n = 0;
    const load = async () => ++n;
    expect(await cached('public', 'k', 60, load)).toBe(1);
    expect(await cached('public', 'k', 60, load)).toBe(2);
    expect(() => bumpCache('public')).not.toThrow();
    let ran = false;
    await withLock('x', 5, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    await closeRedis();
    (env as { REDIS_URL?: string }).REDIS_URL = REAL;
    resetRedisForTests();
  });

  it('rate limit store keeps counting in memory when Redis is down', async () => {
    const { env } = await import('../src/config/env.js');
    (env as { REDIS_URL?: string }).REDIS_URL = 'redis://127.0.0.1:1';
    const { resetRedisForTests, closeRedis } = await import('../src/lib/redis.js');
    resetRedisForTests();
    const { RedisFallbackStore } = await import('../src/lib/rate-limit-store.js');
    const store = new RedisFallbackStore('t');
    store.init({ windowMs: 60_000 } as never);
    expect((await store.increment('ip')).totalHits).toBe(1);
    expect((await store.increment('ip')).totalHits).toBe(2);
    store.shutdown();
    await closeRedis();
    (env as { REDIS_URL?: string }).REDIS_URL = REAL;
    resetRedisForTests();
  });
});

describe.skipIf(!REAL)('redis helpers: real Redis', () => {
  let redis: typeof import('../src/lib/redis.js');
  beforeAll(async () => {
    redis = await import('../src/lib/redis.js');
    redis.resetRedisForTests();
    const r = redis.getRedis()!;
    if (r.status !== 'ready') await new Promise((ok) => r.once('ready', ok));
    await r.flushdb();
  });
  afterAll(() => redis.closeRedis());

  it('serves the second call from Redis and drops it when the cache is bumped', async () => {
    let n = 0;
    const load = async () => ({ v: ++n });
    expect(await redis.cached('public', 'a', 60, load)).toEqual({ v: 1 });
    expect(await redis.cached('public', 'a', 60, load)).toEqual({ v: 1 });
    redis.bumpCache('public');
    await new Promise((r) => setTimeout(r, 50));
    expect(await redis.cached('public', 'a', 60, load)).toEqual({ v: 2 });
  });

  it('counts rate-limit hits in Redis and shares them between stores', async () => {
    const { RedisFallbackStore } = await import('../src/lib/rate-limit-store.js');
    const a = new RedisFallbackStore('shared');
    const b = new RedisFallbackStore('shared');
    a.init({ windowMs: 60_000 } as never);
    b.init({ windowMs: 60_000 } as never);
    expect((await a.increment('1.2.3.4')).totalHits).toBe(1);
    expect((await b.increment('1.2.3.4')).totalHits).toBe(2);
    await a.resetKey('1.2.3.4');
    expect((await b.increment('1.2.3.4')).totalHits).toBe(1);
    a.shutdown();
    b.shutdown();
  });

  it('lets only one process take the sweep lock', async () => {
    let runs = 0;
    const job = async () => {
      runs++;
    };
    await Promise.all([redis.withLock('t', 5, job), redis.withLock('t', 5, job)]);
    expect(runs).toBe(1);
  });
});
