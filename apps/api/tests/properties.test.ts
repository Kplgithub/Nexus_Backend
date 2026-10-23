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
  startDb,
  stopDb,
} from './helpers.js';
import { Property } from '../src/models/property.model.js';
import { openApiDocument } from '../src/docs/openapi.js';

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

const create = async (body: object) => {
  const res = await s.post('/api/v1/admin/properties', body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data as { id: string; slug: string; status: string };
};

describe('property creation and validation', () => {
  it('creates a draft by default with a readable slug', async () => {
    const p = await create(residential());
    expect(p.status).toBe('draft');
    expect(p.slug).toBe('2-bhk-apartment-near-gandhi-path-vaishali-nagar');
  });

  it('requires bedrooms for apartments but not offices', async () => {
    const bad = await s.post('/api/v1/admin/properties', residential({ bedrooms: undefined }));
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.bedrooms).toBeDefined();
    const ok = await s.post('/api/v1/admin/properties', commercial());
    expect(ok.status).toBe(201);
  });

  it('rejects negative or fractional rent', async () => {
    expect((await s.post('/api/v1/admin/properties', residential({ price: -5 }))).status).toBe(422);
    expect((await s.post('/api/v1/admin/properties', residential({ price: 1000.5 }))).status).toBe(
      422,
    );
  });

  it('rejects unknown localities', async () => {
    const res = await s.post('/api/v1/admin/properties', residential({ localitySlug: 'atlantis' }));
    expect(res.status).toBe(400);
  });

  it('keeps slugs unique', async () => {
    const a = await create(residential());
    const b = await create(residential());
    expect(a.slug).not.toBe(b.slug);
    const clash = await s.post('/api/v1/admin/properties', residential({ slug: a.slug }));
    expect(clash.status).toBe(409);
  });

  it('refuses to publish without photos', async () => {
    const p = await create(residential({ images: [] }));
    const res = await s.post(`/api/v1/admin/properties/${p.id}/status`, { status: 'published' });
    expect(res.status).toBe(422);
  });

  it('PATCH does not reset fields that were not sent', async () => {
    const p = await create(residential({ status: 'published', featured: true }));
    const res = await s.patch(`/api/v1/admin/properties/${p.id}`, { price: 19000 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('published');
    expect(res.body.data.featured).toBe(true);
    expect(res.body.data.price).toBe(19000);
  });

  it('normalises area to sq ft', async () => {
    const p = await create(residential({ areaValue: 200, areaUnit: 'sqyd' }));
    const doc = await Property.findById(p.id).lean();
    expect(doc?.areaSqft).toBe(1800);
  });
});

describe('publishing workflow and public visibility', () => {
  it('only shows published listings publicly', async () => {
    const draft = await create(residential());
    expect((await request(app).get(`/api/v1/properties/${draft.slug}`)).status).toBe(404);
    let list = await request(app).get('/api/v1/properties');
    expect(list.body.meta.total).toBe(0);

    await s.post(`/api/v1/admin/properties/${draft.id}/status`, { status: 'published' });
    list = await request(app).get('/api/v1/properties');
    expect(list.body.meta.total).toBe(1);

    await s.post(`/api/v1/admin/properties/${draft.id}/status`, { status: 'inactive' });
    list = await request(app).get('/api/v1/properties');
    expect(list.body.meta.total).toBe(0);
  });

  it('rented listings keep their page but leave search results', async () => {
    const p = await create(residential({ status: 'published' }));
    await s.post(`/api/v1/admin/properties/${p.id}/status`, { status: 'rented' });
    const detail = await request(app).get(`/api/v1/properties/${p.slug}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.property.status).toBe('rented');
    expect((await request(app).get('/api/v1/properties')).body.meta.total).toBe(0);
  });

  it('unlisted listings are reachable by link only', async () => {
    const p = await create(residential({ status: 'published', listingVisibility: 'unlisted' }));
    expect((await request(app).get(`/api/v1/properties/${p.slug}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/properties')).body.meta.total).toBe(0);
    expect((await request(app).get('/api/v1/sitemap/properties')).body.data).toHaveLength(0);
  });

  it('never exposes private fields publicly', async () => {
    const p = await create(residential({ status: 'published' }));
    const detail = await request(app).get(`/api/v1/properties/${p.slug}`);
    const body = JSON.stringify(detail.body);
    expect(body).not.toContain('PRIVATE');
    expect(body).not.toContain('ownerReference');
    expect(body).not.toContain('internalNotes');
    const list = await request(app).get('/api/v1/properties');
    expect(JSON.stringify(list.body)).not.toContain('PRIVATE');
  });

  it('redirects old slugs after a slug change', async () => {
    const p = await create(residential({ status: 'published' }));
    await s.patch(`/api/v1/admin/properties/${p.id}`, { slug: 'renamed-2-bhk-vaishali' });
    const old = await request(app).get(`/api/v1/properties/${p.slug}`);
    expect(old.status).toBe(200);
    expect(old.body.data.redirectTo).toBe('renamed-2-bhk-vaishali');
    // A new property cannot take over the redirected slug.
    const clash = await s.post('/api/v1/admin/properties', residential({ slug: p.slug }));
    expect(clash.status).toBe(409);
  });

  it('deletes a property', async () => {
    const p = await create(residential());
    expect((await s.del(`/api/v1/admin/properties/${p.id}`)).status).toBe(200);
    expect(await Property.countDocuments()).toBe(0);
  });
});

describe('public search and filtering', () => {
  beforeEach(async () => {
    await create(
      residential({
        status: 'published',
        title: 'Budget 1 BHK flat',
        price: 9000,
        bedrooms: 1,
        bathrooms: 1,
      }),
    );
    await create(
      residential({
        status: 'published',
        title: 'Family 3 BHK flat',
        price: 30000,
        bedrooms: 3,
        bathrooms: 2,
        furnishingStatus: 'furnished',
      }),
    );
    await create(
      residential({
        status: 'published',
        title: 'Two bedroom flat',
        localitySlug: 'malviya-nagar',
        price: 18000,
        amenities: ['gym'],
      }),
    );
    await create(commercial({ status: 'published' }));
    await create(
      commercial({
        status: 'published',
        title: 'Retail shop on main road',
        propertyType: 'shop',
        price: 40000,
        parking: 'none',
      }),
    );
  });

  const search = (qs: string) => request(app).get(`/api/v1/properties?${qs}`);

  it('filters by category', async () => {
    expect((await search('category=residential')).body.meta.total).toBe(3);
    expect((await search('category=commercial')).body.meta.total).toBe(2);
  });

  it('filters by rent range', async () => {
    const r = await search('category=residential&minPrice=10000&maxPrice=25000');
    expect(r.body.data.map((p: { price: number }) => p.price)).toEqual([18000]);
  });

  it('filters by city and locality', async () => {
    expect((await search('city=jaipur&locality=malviya-nagar')).body.meta.total).toBe(1);
    expect((await search('city=jaipur')).body.meta.total).toBe(5);
    expect((await search('city=delhi')).body.meta.total).toBe(0);
  });

  it('treats bedrooms as a minimum', async () => {
    expect((await search('bedrooms=2')).body.meta.total).toBe(2);
  });

  it('filters by type, furnishing, amenities and parking', async () => {
    expect((await search('propertyType=shop')).body.meta.total).toBe(1);
    expect((await search('furnishing=furnished&category=residential')).body.meta.total).toBe(1);
    expect((await search('amenities=gym')).body.meta.total).toBe(1);
    expect((await search('category=commercial&parking=true')).body.meta.total).toBe(1);
  });

  it('sorts by rent', async () => {
    const asc = (await search('sort=price_asc')).body.data.map((p: { price: number }) => p.price);
    expect(asc).toEqual([...asc].sort((a: number, b: number) => a - b));
    const desc = (await search('sort=price_desc')).body.data.map((p: { price: number }) => p.price);
    expect(desc[0]).toBe(85000);
  });

  it('paginates on the server', async () => {
    const p1 = await search('limit=2&page=1&sort=price_asc');
    const p2 = await search('limit=2&page=2&sort=price_asc');
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.meta.totalPages).toBe(3);
    expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
  });

  it('handles invalid filters gracefully', async () => {
    const r = await search('category=castle&minPrice=abc&page=-3&sort=random&limit=9999');
    expect(r.status).toBe(200);
    expect(r.body.meta.limit).toBe(48);
  });

  it('ignores operator injection in query strings', async () => {
    const r = await request(app).get('/api/v1/properties?city[$ne]=x');
    expect(r.status).toBe(200);
    expect(r.body.meta.total).toBe(5);
  });

  it('returns similar properties on the detail page', async () => {
    const list = await search('category=residential&sort=price_asc');
    const detail = await request(app).get(`/api/v1/properties/${list.body.data[1].slug}`);
    expect(detail.body.data.similar.length).toBeGreaterThan(0);
    expect(
      detail.body.data.similar.every((p: { category: string }) => p.category === 'residential'),
    ).toBe(true);
  });

  it('exposes location counts', async () => {
    const r = await request(app).get('/api/v1/locations');
    const jaipur = r.body.data[0];
    expect(jaipur.publishedCount).toBe(5);
    expect(
      jaipur.localities.find((l: { slug: string }) => l.slug === 'malviya-nagar').publishedCount,
    ).toBe(1);
  });
});

describe('api docs', () => {
  it('documents every route family', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    for (const path of [
      '/properties',
      '/enquiries',
      '/admin/properties',
      '/admin/enquiries',
      '/admin/uploads',
    ]) {
      expect(Object.keys(openApiDocument.paths)).toContain(path);
    }
  });
});
