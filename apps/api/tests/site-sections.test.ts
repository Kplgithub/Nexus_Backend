import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  commercial,
  createAdmin,
  resetDb,
  residential,
  seedJaipur,
  signIn,
  signUpUser,
  startDb,
  stopDb,
  userListing,
} from './helpers.js';
import { hiddenListingConditions, listingSectionOff } from '@nexus/shared';

let app: Express;
let s: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  await seedJaipur();
  s = await signIn(app);
});

const publish = async (body: object) => {
  const res = await s.post('/api/v1/admin/properties', { ...body, status: 'published' });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data as { id: string; slug: string };
};
const slugs = async (qs = '') =>
  ((await request(app).get(`/api/v1/properties${qs}`)).body.data as { slug: string }[])
    .map((p) => p.slug)
    .sort();
const turn = (sections: Record<string, boolean>) =>
  s.patch('/api/v1/admin/settings', { sections }).expect(200);

describe('site section helpers', () => {
  it('maps listings to their switches', () => {
    const pg = { category: 'residential', listingType: 'rent', propertyType: 'pg' };
    expect(listingSectionOff(pg, { rent: true, pg: true })).toBeNull();
    expect(listingSectionOff(pg, { pg: false })).toBe('pg');
    expect(listingSectionOff(pg, { rent: false })).toBe('rent');
    expect(
      listingSectionOff(
        { category: 'commercial', listingType: 'sale', propertyType: 'shop' },
        { buy: false },
      ),
    ).toBeNull();
    expect(hiddenListingConditions({ buy: true, rent: true })).toEqual([]);
  });
});

describe('site section switches', () => {
  it('are all on by default and keep other switches when one is sent', async () => {
    const before = (await request(app).get('/api/v1/settings')).body.data;
    expect(before.sections).toEqual({
      buy: true,
      rent: true,
      projects: true,
      pg: true,
      plot: true,
      commercial: true,
    });
    expect(before.sectionOffAction).toBe('redirect');
    await turn({ pg: false });
    await turn({ plot: false });
    const after = (await request(app).get('/api/v1/settings')).body.data;
    expect(after.sections).toMatchObject({ pg: false, plot: false, rent: true, buy: true });
    await s.patch('/api/v1/admin/settings', { sectionOffAction: 'not-found' }).expect(200);
    expect((await request(app).get('/api/v1/settings')).body.data.sectionOffAction).toBe(
      'not-found',
    );
  });

  it('hide listings of an off section from search, home and sitemap, and bring them back', async () => {
    const flat = await publish(residential());
    const pg = await publish(
      residential({
        title: 'Girls PG near Vaishali',
        propertyType: 'pg',
        bedrooms: undefined,
        bathrooms: undefined,
        pgGender: 'female',
      }),
    );
    const office = await publish(commercial());
    expect(await slugs()).toEqual([flat.slug, office.slug, pg.slug].sort());

    await turn({ pg: false });
    expect(await slugs()).toEqual([flat.slug, office.slug].sort());
    expect(await slugs('?propertyType=pg')).toEqual([]);
    const sitemap = (await request(app).get('/api/v1/sitemap/properties')).body.data as {
      slug: string;
    }[];
    expect(sitemap.map((r) => r.slug)).not.toContain(pg.slug);
    const detail = (await request(app).get(`/api/v1/properties/${pg.slug}`)).body.data;
    expect(detail).toEqual({ sectionOff: 'pg' });

    await turn({ commercial: false, rent: false });
    expect(await slugs()).toEqual([]);
    const home = (await request(app).get('/api/v1/home')).body.data;
    expect(home.counts).toEqual({ sale: 0, rent: 0 });

    await turn({ pg: true, commercial: true, rent: true });
    expect(await slugs()).toEqual([flat.slug, office.slug, pg.slug].sort());
    const back = (await request(app).get(`/api/v1/properties/${pg.slug}`)).body.data;
    expect(back.property.slug).toBe(pg.slug);
  });

  it('turns off buy without touching commercial for sale', async () => {
    const flat = await publish(userListing());
    const shop = await publish(
      commercial({ listingType: 'sale', propertyType: 'shop', price: 4500000 }),
    );
    await turn({ buy: false });
    expect(await slugs('?listingType=sale')).toEqual([shop.slug]);
    expect((await request(app).get(`/api/v1/properties/${flat.slug}`)).body.data).toEqual({
      sectionOff: 'buy',
    });
  });

  it('stops new posts in an off section but keeps the member listing, marked', async () => {
    const owner = await signUpUser(app, 'agent');
    const made = await owner.post('/api/v1/me/properties', userListing());
    expect(made.status).toBe(201);
    await turn({ buy: false });
    const blocked = await owner.post('/api/v1/me/properties', userListing());
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.message).toMatch(/Buy listings are paused/);
    const rentOk = await owner.post(
      '/api/v1/me/properties',
      userListing({ listingType: 'rent', price: 20000, possessionStatus: undefined }),
    );
    expect(rentOk.status).toBe(201);
    const mine = (await owner.get('/api/v1/me/properties')).body.data as {
      id: string;
      sectionOff?: string;
    }[];
    expect(mine.find((l) => l.id === made.body.data.id)?.sectionOff).toBe('buy');
    expect(mine.find((l) => l.id === rentOk.body.data.id)?.sectionOff).toBeUndefined();
  });

  it('counts what each switch would hide, for the admin panel', async () => {
    await publish(residential());
    await publish(userListing());
    await publish(commercial());
    await turn({ rent: false });
    const counts = (await s.get('/api/v1/admin/settings/section-counts').expect(200)).body.data;
    expect(counts).toEqual({ buy: 1, rent: 1, projects: 0, pg: 0, plot: 0, commercial: 1 });
  });

  it('hides new projects everywhere when projects is off', async () => {
    await turn({ projects: false });
    const list = await request(app).get('/api/v1/projects').expect(200);
    expect(list.body.data).toEqual([]);
    await request(app).get('/api/v1/projects/anything').expect(404);
    expect((await request(app).get('/api/v1/home')).body.data.projects).toEqual([]);
    expect((await request(app).get('/api/v1/sitemap/projects')).body.data).toEqual([]);
  });
});
