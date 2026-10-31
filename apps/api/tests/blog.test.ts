import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createAdmin, resetDb, signIn, startDb, stopDb } from './helpers.js';
import { readingMinutes } from '../src/services/blog.service.js';

let app: Express;
let s: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  s = await signIn(app);
});

const post = (o: Record<string, unknown> = {}) => ({
  title: 'How to check RERA registration in Jaipur',
  excerpt: 'A step-by-step guide for home buyers.',
  content: '## Why it matters\n\nAlways check the RERA number before you book. > Quotes work too.',
  category: 'legal',
  tags: ['RERA', 'rera', 'Buying'],
  authorName: 'NEXUS Team',
  coverImage: {
    url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
    publicId: 'demo/sample',
    alt: 'Documents on a desk',
  },
  ...o,
});

describe('blog', () => {
  it('keeps drafts private and publishes on request', async () => {
    const created = await s.post('/api/v1/admin/blog', post());
    expect(created.status).toBe(201);
    const p = created.body.data;
    expect(p.slug).toBe('how-to-check-rera-registration-in-jaipur');
    expect(p.status).toBe('draft');
    expect(p.publishedAt).toBeNull();
    expect(p.tags).toEqual(['rera', 'buying']);
    // Markdown keeps angle brackets (blockquotes); the website never renders raw HTML.
    expect(p.content).toContain('> Quotes');

    expect((await request(app).get('/api/v1/blog')).body.data).toHaveLength(0);
    expect((await request(app).get(`/api/v1/blog/${p.slug}`)).status).toBe(404);

    const pub = await s.patch(`/api/v1/admin/blog/${p.id}`, { status: 'published' });
    expect(pub.status).toBe(200);
    expect(pub.body.data.publishedAt).toBeTruthy();

    const list = await request(app).get('/api/v1/blog');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].content).toBeUndefined();
    expect(list.body.meta.total).toBe(1);

    const detail = await request(app).get(`/api/v1/blog/${p.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.post.title).toBe(p.title);
    expect(detail.body.data.post.status).toBeUndefined();

    const tagged = await request(app).get('/api/v1/blog?tag=rera&category=legal');
    expect(tagged.body.data).toHaveLength(1);
    const other = await request(app).get('/api/v1/blog?category=renting');
    expect(other.body.data).toHaveLength(0);

    const sitemap = await request(app).get('/api/v1/sitemap/blog');
    expect(sitemap.body.data[0].slug).toBe(p.slug);

    // Unpublishing hides it again but keeps the original publish date.
    const un = await s.patch(`/api/v1/admin/blog/${p.id}`, { status: 'draft' });
    expect(un.body.data.publishedAt).toBe(pub.body.data.publishedAt);
    expect((await request(app).get(`/api/v1/blog/${p.slug}`)).status).toBe(404);
  });

  it('gives unique slugs and redirects old slugs of published posts', async () => {
    const a = (await s.post('/api/v1/admin/blog', post({ status: 'published' }))).body.data;
    const b = (await s.post('/api/v1/admin/blog', post())).body.data;
    expect(b.slug).toBe(`${a.slug}-2`);

    const taken = await s.patch(`/api/v1/admin/blog/${b.id}`, { slug: a.slug });
    expect(taken.status).toBe(409);
    const reserved = await s.post('/api/v1/admin/blog', post({ slug: 'category' }));
    expect(reserved.status).toBe(409);

    const moved = await s.patch(`/api/v1/admin/blog/${a.id}`, { slug: 'rera-check-guide' });
    expect(moved.status).toBe(200);
    const old = await request(app).get(`/api/v1/blog/${a.slug}`);
    expect(old.body.data.redirectTo).toBe('rera-check-guide');
    // The old slug stays reserved for the redirect.
    expect((await s.patch(`/api/v1/admin/blog/${b.id}`, { slug: a.slug })).status).toBe(409);
  });

  it('requires staff for writes and admin for deletes', async () => {
    expect((await request(app).post('/api/v1/admin/blog').send(post())).status).toBe(401);
    await createAdmin('editor', 'editor@example.test');
    const editor = await signIn(app, 'editor@example.test');
    const p = (await editor.post('/api/v1/admin/blog', post())).body.data;
    expect((await editor.del(`/api/v1/admin/blog/${p.id}`)).status).toBe(403);
    expect((await s.del(`/api/v1/admin/blog/${p.id}`)).status).toBe(200);
    expect((await s.get(`/api/v1/admin/blog/${p.id}`)).status).toBe(404);
  });

  it('validates input', async () => {
    const bad = await s.post('/api/v1/admin/blog', post({ title: 'Hi', content: '' }));
    expect(bad.status).toBe(422);
    const badCover = await s.post(
      '/api/v1/admin/blog',
      post({ coverImage: { url: 'javascript:alert(1)', alt: '' } }),
    );
    expect(badCover.status).toBe(422);
  });

  it('estimates reading time', () => {
    expect(readingMinutes('word '.repeat(50))).toBe(1);
    expect(readingMinutes('word '.repeat(1000))).toBe(5);
  });
});
