import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  createAdmin,
  resetDb,
  residential,
  seedJaipur,
  signIn,
  startDb,
  stopDb,
} from './helpers.js';
import { Property } from '../src/models/property.model.js';
import { parseQuery } from '../src/services/smart-search/parse.js';
import { clearSmartSearchCache } from '../src/services/smart-search/smart-search.service.js';

let app: Express;
let s: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  clearSmartSearchCache();
  await createAdmin();
  await seedJaipur();
  s = await signIn(app);
});

const farmhouse = (o: Record<string, unknown> = {}) =>
  residential({
    listingType: 'sale',
    title: 'Farmhouse with 2 bigha land on Ajmer Road',
    description:
      'A farmhouse with a lawn, borewell and boundary wall on two bigha of converted land.',
    propertyType: 'farmhouse',
    price: 12_500_000,
    securityDeposit: undefined,
    areaValue: 2,
    areaUnit: 'bigha',
    bedrooms: undefined,
    bathrooms: undefined,
    furnishingStatus: 'unfurnished',
    amenities: [],
    parking: 'none',
    farmLandUse: 'converted',
    farmWaterSource: 'borewell',
    farmElectricity: 'domestic',
    farmFeatures: ['lawn', 'main-gate'],
    farmhouseAreaSqft: 1800,
    boundaryWall: true,
    roadWidthFt: 30,
    status: 'published',
    ...o,
  });

const create = async (body: object) => {
  const res = await s.post('/api/v1/admin/properties', body);
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data as { id: string; slug: string };
};

describe('farm listings', () => {
  it('stores bigha land, converts to sq ft and keeps farm fields', async () => {
    const p = await create(farmhouse());
    const doc = await Property.findById(p.id).lean();
    expect(doc?.areaSqft).toBe(54_450);
    const res = await request(app).get(`/api/v1/properties/${p.slug}`);
    expect(res.status).toBe(200);
    const d = res.body.data.property ?? res.body.data;
    expect(d.farmLandUse).toBe('converted');
    expect(d.farmWaterSource).toBe('borewell');
    expect(d.farmFeatures).toEqual(['lawn', 'main-gate']);
    expect(d.farmhouseAreaSqft).toBe(1800);
    expect(d.boundaryWall).toBe(true);
  });

  it('refuses a farm for rent', async () => {
    const res = await s.post('/api/v1/admin/properties', farmhouse({ listingType: 'rent' }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.listingType).toBeDefined();
  });

  it('clears farm fields on other types', async () => {
    const p = await create(residential({ farmLandUse: 'converted', farmFeatures: ['lawn'] }));
    const doc = await Property.findById(p.id).lean();
    expect(doc?.farmLandUse).toBeNull();
    expect(doc?.farmFeatures).toEqual([]);
  });

  it('filters by farm type, land use and water', async () => {
    await create(farmhouse());
    await create(
      farmhouse({
        propertyType: 'farm-land',
        farmLandUse: 'agricultural',
        farmWaterSource: 'canal',
      }),
    );
    await create(residential({ status: 'published' }));
    const get = (qs: string) => request(app).get(`/api/v1/properties?${qs}`);
    expect((await get('propertyType=farmhouse,farm-land')).body.data).toHaveLength(2);
    expect((await get('propertyType=farm-land')).body.data).toHaveLength(1);
    expect((await get('farmLandUse=converted')).body.data).toHaveLength(1);
    expect((await get('farmWater=canal')).body.data[0].propertyType).toBe('farm-land');
  });

  it('hides farm listings while switched off, without deleting them', async () => {
    const p = await create(farmhouse());
    await create(residential({ status: 'published' }));
    const off = await s.patch('/api/v1/admin/settings', { farms: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.body.data.farms.enabled).toBe(false);
    // Other switches keep their values.
    expect(off.body.data.farms.homepage).toBe(true);
    expect((await request(app).get('/api/v1/properties')).body.data).toHaveLength(1);
    expect(
      (await request(app).get('/api/v1/properties?propertyType=farmhouse')).body.data,
    ).toHaveLength(0);
    expect((await request(app).get(`/api/v1/properties/${p.slug}`)).status).toBe(404);
    expect(await Property.exists({ _id: p.id })).toBeTruthy();

    await s.patch('/api/v1/admin/settings', { farms: { enabled: true } });
    expect((await request(app).get('/api/v1/properties')).body.data).toHaveLength(2);
    expect((await request(app).get(`/api/v1/properties/${p.slug}`)).status).toBe(200);
  });

  it('defaults every farm switch to on and shows them publicly', async () => {
    const pub = await request(app).get('/api/v1/settings');
    expect(pub.body.data.farms).toEqual({
      enabled: true,
      homepage: true,
      menu: true,
      popularSearches: true,
      filters: true,
      postProperty: true,
      listings: true,
    });
  });
});

describe('smart search understands farms', () => {
  const parse = (q: string) => parseQuery(q, { localities: [], deal: 'rent' });
  it('reads farmhouse, farm land and kheti words', () => {
    expect(parse('farmhouse ajmer road').types).toEqual(['farmhouse']);
    expect(parse('farm house chahiye').types).toEqual(['farmhouse']);
    expect(parse('kheti ki zameen 5 bigha').types).toEqual(['farm-land']);
    expect(parse('फार्म हाउस जयपुर').types).toEqual(['farmhouse']);
    expect(parse('खेत चाहिए').types).toEqual(['farm-land']);
    expect(parse('farm in jaipur').types).toEqual(['farmhouse', 'farm-land']);
    expect(parse('zameen chahiye').types).toEqual(['plot', 'farm-land']);
  });
  it('always treats farms as a purchase', () => {
    expect(parse('farmhouse').listingType).toBe('sale');
  });
});
