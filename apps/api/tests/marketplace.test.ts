import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  IMG,
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
import { Property } from '../src/models/property.model.js';

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
  const res = await s.post('/api/v1/admin/properties', { status: 'published', ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data as { id: string; slug: string; location: unknown };
};

const search = async (qs: string) =>
  (await request(app).get(`/api/v1/properties?${qs}`)).body.data as { slug: string }[];

const project = (overrides: Record<string, unknown> = {}) => ({
  name: 'Aravali Heights',
  description: 'A gated community of two and three bedroom apartments with a clubhouse and pool.',
  citySlug: 'jaipur',
  localitySlug: 'malviya-nagar',
  stage: 'under-construction',
  possessionDate: '2028-06-30',
  reraId: 'RAJ/P/2025/1234',
  configurations: [
    {
      unitType: 'apartment',
      bedrooms: 2,
      minAreaSqft: 1000,
      maxAreaSqft: 1150,
      minPrice: 4200000,
      maxPrice: 4800000,
    },
    {
      unitType: 'apartment',
      bedrooms: 3,
      minAreaSqft: 1400,
      maxAreaSqft: 1650,
      minPrice: 6000000,
      maxPrice: 7100000,
    },
  ],
  amenities: ['gym', 'swimming-pool'],
  images: [IMG],
  location: { lat: 26.855, lng: 75.815 },
  ...overrides,
});

describe('map pins, plots and PG', () => {
  it('stores a pin and returns it as lat/lng on detail and cards', async () => {
    const p = await publish(residential({ location: { lat: 26.91, lng: 75.74 } }));
    expect(p.location).toEqual({ lat: 26.91, lng: 75.74 });
    const doc = await Property.findById(p.id).lean();
    expect(doc!.geo!.coordinates).toEqual([75.74, 26.91]);
    const cards = (await request(app).get('/api/v1/properties')).body.data;
    expect(cards[0].location).toEqual({ lat: 26.91, lng: 75.74 });
  });

  it('rejects a pin outside India (swapped lat/lng)', async () => {
    const res = await s.post(
      '/api/v1/admin/properties',
      residential({ location: { lat: 75.74, lng: 26.91 } }),
    );
    expect(res.status).toBe(422);
  });

  it('keeps plot fields only on plots and filters by JDA approval', async () => {
    await publish(
      residential({
        listingType: 'sale',
        title: 'JDA approved plot on Ajmer Road',
        propertyType: 'plot',
        bedrooms: undefined,
        bathrooms: undefined,
        securityDeposit: undefined,
        price: 5400000,
        areaValue: 200,
        areaUnit: 'sqyd',
        plotApproval: 'jda',
        cornerPlot: true,
        roadWidthFt: 40,
      }),
    );
    const flat = await publish(residential({ plotApproval: 'jda', cornerPlot: true }));
    const stored = await Property.findById(flat.id).lean();
    expect(stored!.plotApproval).toBeNull();
    expect(stored!.cornerPlot).toBe(false);
    const found = await search('plotApproval=jda');
    expect(found).toHaveLength(1);
    expect(found[0]!.slug).toContain('plot');
  });

  it('only allows PGs for rent and filters by gender and food', async () => {
    const bad = await s.post(
      '/api/v1/admin/properties',
      residential({
        listingType: 'sale',
        propertyType: 'pg',
        price: 900000,
        securityDeposit: undefined,
      }),
    );
    expect(bad.status).toBe(422);
    await publish(
      residential({
        title: 'Girls PG with meals',
        propertyType: 'pg',
        bedrooms: 1,
        bathrooms: 1,
        price: 9000,
        pgGender: 'female',
        pgFoodIncluded: true,
        pgSharing: ['double'],
      }),
    );
    expect(await search('pgGender=female')).toHaveLength(1);
    expect(await search('pgGender=male')).toHaveLength(0);
    expect(await search('pgFood=true')).toHaveLength(1);
  });
});

describe('new search filters', () => {
  it('filters by photos, RERA, posting date and sorts by area', async () => {
    await publish(residential({ title: 'Small flat with photos', areaValue: 600 }));
    await publish(
      residential({
        listingType: 'sale',
        title: 'Large flat with RERA number',
        price: 9000000,
        securityDeposit: undefined,
        areaValue: 2400,
        reraId: 'RAJ/P/2024/999',
      }),
    );
    const old = await publish(residential({ title: 'Old flat posted long ago', areaValue: 900 }));
    await Property.updateOne({ _id: old.id }, { $set: { publishedAt: new Date('2020-01-01') } });

    expect(await search('rera=true')).toHaveLength(1);
    expect((await search('postedWithin=7')).map((p) => p.slug)).not.toContain(old.slug);
    const bySize = await search('sort=area_desc');
    expect(bySize[0]!.slug).toContain('large-flat');
    await Property.updateOne({ _id: old.id }, { $set: { images: [] } });
    expect((await search('withPhotos=true')).map((p) => p.slug)).not.toContain(old.slug);
  });

  it('counts views from the beacon only for live listings', async () => {
    const p = await publish(residential());
    await request(app).post(`/api/v1/properties/${p.id}/view`).expect(200);
    await request(app).post(`/api/v1/properties/${p.id}/view`).expect(200);
    const detail = await request(app).get(`/api/v1/properties/${p.slug}`);
    expect(detail.body.data.property.views).toBe(2);
  });
});

describe('agent and builder profiles', () => {
  it('gives agents a public profile with their live listings, and none to owners', async () => {
    const agent = await signUpUser(app, 'agent');
    const me = (await agent.get('/api/v1/me')).body.data.user;
    expect(me.profileSlug).toBe('mehta-realty');
    await agent
      .patch('/api/v1/me', {
        citySlug: 'jaipur',
        experienceYears: 12,
        localities: ['vaishali-nagar', 'atlantis'],
      })
      .expect(200);
    const created = await agent.post('/api/v1/me/properties', userListing({ status: 'pending' }));
    await s.post(`/api/v1/admin/properties/${created.body.data.id}/status`, {
      status: 'published',
    });

    const profile = (await request(app).get('/api/v1/agents/mehta-realty')).body.data;
    expect(profile).toMatchObject({
      role: 'agent',
      experienceYears: 12,
      counts: { sale: 1, rent: 0 },
    });
    expect(profile.localities).toEqual([{ slug: 'vaishali-nagar', name: 'Vaishali Nagar' }]);
    expect(profile).not.toHaveProperty('phone');
    expect(profile).not.toHaveProperty('email');

    const listed = await search(`poster=${profile.id}`);
    expect(listed).toHaveLength(1);
    const detail = await request(app).get(`/api/v1/properties/${listed[0]!.slug}`);
    expect(detail.body.data.property.poster.profilePath).toBe('/agents/mehta-realty');

    const directory = (await request(app).get('/api/v1/agents')).body.data;
    expect(directory.map((d: { slug: string }) => d.slug)).toEqual(['mehta-realty']);
    await request(app).get('/api/v1/builders/mehta-realty').expect(404);

    const sitemap = (await request(app).get('/api/v1/sitemap/profiles')).body.data;
    expect(sitemap.map((r: { path: string }) => r.path)).toEqual(['/agents/mehta-realty']);

    const owner = await signUpUser(app, 'individual');
    expect((await owner.get('/api/v1/me')).body.data.user.profileSlug).toBeNull();
  });
});

describe('locality insights', () => {
  it('works out median rate per sq ft and rent by BHK from live listings', async () => {
    for (const [price, area] of [
      [5000000, 1000],
      [6000000, 1000],
      [8000000, 1000],
    ] as const) {
      await publish(
        residential({ listingType: 'sale', price, areaValue: area, securityDeposit: undefined }),
      );
    }
    await publish(residential({ price: 15000, bedrooms: 2 }));
    await publish(residential({ price: 21000, bedrooms: 2 }));
    await publish(residential({ price: 30000, bedrooms: 3 }));
    const res = await request(app).get('/api/v1/locations/jaipur/vaishali-nagar/insights');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.sale).toMatchObject({ count: 3, medianPricePerSqft: 6000, minPrice: 5000000 });
    expect(d.rent.medianRentByBhk).toEqual([
      { bedrooms: 2, rent: 18000 },
      { bedrooms: 3, rent: 30000 },
    ]);
    await request(app).get('/api/v1/locations/jaipur/atlantis/insights').expect(404);
  });
});

describe('new projects', () => {
  it('runs a builder project through review to a public page with leads', async () => {
    const builder = await signUpUser(app, 'builder');
    const agent = await signUpUser(app, 'agent');
    expect((await agent.post('/api/v1/me/projects', project())).status).toBe(403);

    const draft = await builder.post('/api/v1/me/projects', project());
    expect(draft.status).toBe(201);
    expect(draft.body.data).toMatchObject({
      status: 'draft',
      priceRange: { min: 4200000, max: 7100000 },
    });
    const id = draft.body.data.id as string;
    const slug = draft.body.data.slug as string;
    await request(app).get(`/api/v1/projects/${slug}`).expect(404);

    await builder.post(`/api/v1/me/projects/${id}/status`, { status: 'pending' }).expect(200);
    const queue = (await s.get('/api/v1/admin/projects?status=pending')).body.data;
    expect(queue).toHaveLength(1);
    const rejected = await s.post(`/api/v1/admin/projects/${id}/status`, { status: 'rejected' });
    expect(rejected.status).toBe(400);
    await s.post(`/api/v1/admin/projects/${id}/status`, { status: 'published' }).expect(200);

    const page = (await request(app).get(`/api/v1/projects/${slug}`)).body.data;
    expect(page.configurations.map((c: { label: string }) => c.label)).toEqual([
      '2 BHK Apartment / Flat',
      '3 BHK Apartment / Flat',
    ]);
    expect(page.builder.profilePath).toBe('/builders/mehta-builders');
    expect(page.builder).not.toHaveProperty('email');

    const list = (await request(app).get('/api/v1/projects?bedrooms=3&maxPrice=6500000')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].unitSummary).toBe('2, 3 BHK Apartment / Flat');
    expect((await request(app).get('/api/v1/projects?bedrooms=4')).body.data).toHaveLength(0);
    expect((await request(app).get('/api/v1/home')).body.data.projects).toHaveLength(1);

    // A resale listing can belong to the project, and search by project finds it.
    const listing = await agent.post(
      '/api/v1/me/properties',
      userListing({ status: 'pending', projectId: id, localitySlug: 'malviya-nagar' }),
    );
    expect(listing.status).toBe(201);
    await s.post(`/api/v1/admin/properties/${listing.body.data.id}/status`, {
      status: 'published',
    });
    expect(await search(`project=${slug}`)).toHaveLength(1);

    // The home page can be limited to one city; an unknown city is simply empty.
    const homeIn = async (qs: string) => (await request(app).get(`/api/v1/home${qs}`)).body.data;
    const jaipur = await homeIn('?city=jaipur');
    expect(jaipur.projects).toHaveLength(1);
    expect(jaipur.counts.sale + jaipur.counts.rent).toBeGreaterThan(0);
    const udaipur = await homeIn('?city=udaipur');
    expect(udaipur.projects).toHaveLength(0);
    expect(udaipur.counts).toEqual({ sale: 0, rent: 0 });
    expect([...udaipur.recentSale, ...udaipur.recentRent]).toHaveLength(0);
    // A bad value is ignored, not an error.
    expect((await homeIn('?city=%3Cx%3E')).projects).toHaveLength(1);
    const detail = await request(app).get(`/api/v1/properties/${listing.body.data.slug}`);
    expect(detail.body.data.property.project).toMatchObject({ slug, name: 'Aravali Heights' });

    // Enquiries on the project go to the builder.
    await request(app)
      .post('/api/v1/enquiries')
      .send({ name: 'Kiran', phone: '9829012345', projectId: id, consent: true, elapsedMs: 5000 })
      .expect(201);
    const leads = (await builder.get('/api/v1/me/leads')).body.data;
    expect(leads[0].project).toMatchObject({ slug, name: 'Aravali Heights' });

    // Editing a live project sends it back for review.
    const edited = await builder.patch(`/api/v1/me/projects/${id}`, { totalUnits: 300 });
    expect(edited.body.data.status).toBe('pending');
    await request(app).get(`/api/v1/projects/${slug}`).expect(404);
  });

  it('rejects inconsistent configurations', async () => {
    const builder = await signUpUser(app, 'builder');
    const res = await builder.post(
      '/api/v1/me/projects',
      project({
        configurations: [
          {
            unitType: 'apartment',
            bedrooms: 2,
            minAreaSqft: 1200,
            maxAreaSqft: 1000,
            minPrice: 1,
            maxPrice: 2,
          },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe('listing reports', () => {
  it('accepts one report per visitor per day and lets staff resolve it', async () => {
    const p = await publish(residential());
    const body = {
      propertyId: p.id,
      reason: 'already-rented-or-sold',
      details: 'Called, owner says rented',
    };
    await request(app).post('/api/v1/reports').send(body).expect(201);
    await request(app).post('/api/v1/reports').send(body).expect(201);
    const list = (await s.get('/api/v1/admin/reports?status=open')).body.data;
    expect(list).toHaveLength(1);
    expect(list[0].property.slug).toBe(p.slug);
    const done = await s.patch(`/api/v1/admin/reports/${list[0].id}`, {
      status: 'resolved',
      note: 'Marked rented',
    });
    expect(done.body.data.status).toBe('resolved');
  });
});
