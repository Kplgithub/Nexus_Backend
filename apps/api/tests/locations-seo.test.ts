import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { cityCreateSchema } from '@nexus/shared';
import { createAdmin, resetDb, seedJaipur, signIn, startDb, stopDb } from './helpers.js';
import { applySeoCopy, SEO_COPY } from '../src/scripts/seo-copy.js';

let app: Express;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
});

const jaipur = async () => {
  const r = await request(app).get('/api/v1/locations');
  return r.body.data.find((c: { slug: string }) => c.slug === 'jaipur');
};

describe('buy and rent page copy', () => {
  it('ships copy that passes the admin validation limits', () => {
    for (const e of SEO_COPY) {
      expect(() =>
        cityCreateSchema.parse({
          name: 'Jaipur',
          state: 'Rajasthan',
          ...e.copy,
          localities: Object.entries(e.localities).map(([slug, c]) => ({ name: slug, ...c })),
        }),
      ).not.toThrow();
    }
  });

  it('fills empty pages once and never overwrites admin edits', async () => {
    await seedJaipur();
    const filled = await applySeoCopy();
    expect(filled.sort()).toEqual(
      [
        'buy/jaipur',
        'rent/jaipur',
        'buy/jaipur/vaishali-nagar',
        'rent/jaipur/vaishali-nagar',
      ].sort(),
    );

    let c = await jaipur();
    expect(c.buySeo.h1).toBe('Property for Sale in Jaipur');
    expect(c.rentSeo.title).toContain('for Rent in Jaipur');
    const vn = c.localities.find((l: { slug: string }) => l.slug === 'vaishali-nagar');
    expect(vn.buySeo.title).toContain('for Sale in Vaishali Nagar');
    expect(vn.rentSeo.h1).toContain('for Rent in Vaishali Nagar');
    // Other localities and the shared fields are untouched.
    expect(
      c.localities.find((l: { slug: string }) => l.slug === 'c-scheme').buySeo,
    ).toBeUndefined();
    expect(vn.intro).toBe('Test intro');

    // An admin edits the rent title and clears the buy copy; a later run keeps both.
    const s = await signIn(app);
    const res = await s.patch(`/api/v1/admin/locations/${c.id}`, {
      buySeo: { title: '', description: '', h1: '', intro: '' },
      rentSeo: { title: 'Custom rent title', description: '', h1: '', intro: '' },
      localities: c.localities.map((l: Record<string, unknown>) => ({
        name: l.name,
        slug: l.slug,
        active: l.active,
        intro: l.intro,
        buySeo: l.buySeo,
        rentSeo: l.rentSeo,
      })),
    });
    expect(res.status).toBe(200);
    expect(await applySeoCopy()).toEqual([]);
    c = await jaipur();
    expect(c.rentSeo).toEqual({ title: 'Custom rent title' });
    expect(c.buySeo).toEqual({});
    expect(c.localities.find((l: { slug: string }) => l.slug === 'vaishali-nagar').buySeo.h1).toBe(
      vn.buySeo.h1,
    );
  });

  it('skips cities and localities that do not exist', async () => {
    expect(await applySeoCopy()).toEqual([]);
  });
});
