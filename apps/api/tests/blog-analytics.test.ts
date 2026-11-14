import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createAdmin, resetDb, signIn, startDb, stopDb } from './helpers.js';
import { deviceOf, sourceOf } from '../src/services/blog-analytics.service.js';

let app: Express;
let s: Awaited<ReturnType<typeof signIn>>;

const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PHONE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  s = await signIn(app);
});

async function publishedPost(status = 'published') {
  const res = await s.post('/api/v1/admin/blog', {
    title: 'Renting in Vaishali Nagar: a complete guide',
    content: '## Rents\n\nRents in Vaishali Nagar start around ₹12,000 for a 2 BHK flat.',
    category: 'renting',
    status,
  });
  return res.body.data as { id: string; slug: string };
}

const beacon = (id: string, body: Record<string, unknown>, ua = BROWSER) =>
  request(app).post(`/api/v1/blog/${id}/read`).set('User-Agent', ua).send(body);

describe('blog reader analytics', () => {
  it('records sessions, keeps the furthest progress and reports it to admins', async () => {
    const p = await publishedPost();
    const a = { sessionId: 'sess-aaaaaaaa', visitorId: 'visitor-1111' };
    expect(
      (await beacon(p.id, { ...a, seconds: 0, scroll: 5, referrer: 'https://www.google.com/' }))
        .body.data,
    ).toEqual({ counted: true });
    await beacon(p.id, { ...a, seconds: 95, scroll: 100 });
    // A late, older beacon never lowers the numbers.
    await beacon(p.id, { ...a, seconds: 40, scroll: 60 });
    // Same browser, second visit; and a new phone reader who leaves quickly.
    await beacon(p.id, {
      sessionId: 'sess-bbbbbbbb',
      visitorId: 'visitor-1111',
      seconds: 25,
      scroll: 50,
    });
    await beacon(
      p.id,
      { sessionId: 'sess-cccccccc', visitorId: 'visitor-2222', seconds: 4, scroll: 10 },
      PHONE,
    );
    // Crawlers are ignored.
    expect(
      (
        await beacon(
          p.id,
          { sessionId: 'sess-dddddddd', visitorId: 'visitor-3333', seconds: 9, scroll: 9 },
          'Googlebot/2.1',
        )
      ).body.data,
    ).toEqual({ counted: false });

    const r = await s.get(`/api/v1/admin/blog/${p.id}/analytics?days=7`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.totals).toMatchObject({
      views: 3,
      readers: 2,
      totalSeconds: 124,
      avgSeconds: 41,
      completed: 1,
      completionRate: 33,
      engaged: 1,
      quickExits: 1,
      returningReaders: 1,
    });
    expect(d.allTime.views).toBe(3);
    expect(d.daily).toHaveLength(7);
    expect(d.daily.at(-1)).toMatchObject({ views: 3, readers: 2 });
    expect(d.scrollDepth).toEqual([
      { label: '25%', count: 2 },
      { label: '50%', count: 2 },
      { label: '75%', count: 1 },
      { label: 'End', count: 1 },
    ]);
    expect(d.timeBuckets.find((b: { label: string }) => b.label === 'Under 10 sec').count).toBe(1);
    expect(d.timeBuckets.find((b: { label: string }) => b.label === '1–3 min').count).toBe(1);
    expect(d.devices).toEqual(
      expect.arrayContaining([
        { label: 'desktop', count: 2 },
        { label: 'mobile', count: 1 },
      ]),
    );
    expect(d.sources).toEqual(expect.arrayContaining([{ label: 'google.com', count: 1 }]));
    expect(d.recent).toHaveLength(3);

    const list = await s.get('/api/v1/admin/blog');
    expect(list.body.data[0].stats).toMatchObject({ views: 3, readers: 2, avgSeconds: 41 });

    const all = await s.get('/api/v1/admin/blog/analytics?days=30');
    expect(all.status).toBe(200);
    expect(all.body.data.totals.views).toBe(3);
    expect(all.body.data.posts[0]).toMatchObject({ id: p.id, views: 3, readers: 2 });

    // Deleting the article removes its reading history.
    await s.del(`/api/v1/admin/blog/${p.id}`);
    expect((await s.get('/api/v1/admin/blog/analytics')).body.data.totals.views).toBe(0);
  });

  it('ignores drafts, rejects bad input and keeps reports admin-only', async () => {
    const draft = await publishedPost('draft');
    const ok = { sessionId: 'sess-aaaaaaaa', visitorId: 'visitor-1111', seconds: 5, scroll: 5 };
    expect((await beacon(draft.id, ok)).body.data).toEqual({ counted: false });
    expect((await beacon(draft.id, { ...ok, sessionId: 'x' })).status).toBe(422);
    expect((await beacon(draft.id, { ...ok, scroll: 400 })).status).toBe(422);
    expect((await request(app).get('/api/v1/admin/blog/analytics')).status).toBe(401);
  });

  it('caps very long sessions at an hour', async () => {
    const p = await publishedPost();
    await beacon(p.id, {
      sessionId: 'sess-aaaaaaaa',
      visitorId: 'visitor-1111',
      seconds: 20_000,
      scroll: 100,
    });
    const d = (await s.get(`/api/v1/admin/blog/${p.id}/analytics`)).body.data;
    expect(d.totals.totalSeconds).toBe(3600);
  });

  it('classifies devices and sources', () => {
    expect(deviceOf(PHONE)).toBe('mobile');
    expect(deviceOf(BROWSER)).toBe('desktop');
    expect(deviceOf('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(sourceOf('')).toBe('');
    expect(sourceOf('https://www.google.co.in/search?q=x')).toBe('google.co.in');
    expect(sourceOf('not a url')).toBe('');
  });
});
