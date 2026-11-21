import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createAdmin, resetDb, residential, signIn, startDb, stopDb } from './helpers.js';
import { City } from '../src/models/misc.models.js';
import { SearchLog } from '../src/models/search-log.model.js';
import { parseQuery, type PlaceRef } from '../src/services/smart-search/parse.js';
import { clearSmartSearchCache } from '../src/services/smart-search/smart-search.service.js';
import { phoneticKey, toLatin } from '../src/services/smart-search/text.js';

const PLACES: PlaceRef[] = [
  ['Vaishali Nagar', 26.911, 75.743],
  ['Malviya Nagar', 26.855, 75.815],
  ['Jagatpura', 26.825, 75.865],
  ['C-Scheme', 26.905, 75.8],
  ['Mansarovar', 26.87, 75.76],
  ['Raja Park', 26.898, 75.83],
  ['Ajmer Road', 26.89, 75.73],
  ['Tonk Road', 26.84, 75.8],
].map(([name, lat, lng]) => ({
  name: name as string,
  slug: (name as string).toLowerCase().replace(/[^a-z]+/g, '-'),
  center: { lat: lat as number, lng: lng as number },
}));
const parse = (q: string, deal: 'rent' | 'sale' = 'rent') =>
  parseQuery(q, { localities: PLACES, deal });

describe('understanding what people type', () => {
  it('reads a Hinglish rental search', () => {
    const i = parse('2bhk furnished flat vaishali nagar me 15000 tak, parking chahiye');
    expect(i.bedrooms).toEqual([2]);
    expect(i.furnishing).toBe('furnished');
    expect(i.localities.map((l) => l.slug)).toEqual(['vaishali-nagar']);
    expect(i.maxPrice).toBe(15000);
    expect(i.parking).toBe(true);
    expect(i.hinglish).toBe(true);
  });

  it('reads Hindi in Devanagari', () => {
    const i = parse('वैशाली नगर में 2 बीएचके फ्लैट 15 हजार तक');
    expect(i.localities[0]?.slug).toBe('vaishali-nagar');
    expect(i.bedrooms).toEqual([2]);
    expect(i.maxPrice).toBe(15000);
    expect(i.typeLabel).toBe('Flat');
    expect(parse('मानसरोवर में 1 बीएचके किराये पर').localities[0]?.slug).toBe('mansarovar');
  });

  it('forgives spelling mistakes in places and words', () => {
    const i = parse('2 bhk aparment furnised in mansrovar 12k');
    expect(i.localities[0]?.slug).toBe('mansarovar');
    expect(i.typeLabel).toBe('Flat');
    expect(i.furnishing).toBe('furnished');
    expect(i.maxPrice).toBe(12000);
    expect(parse('3 bhk villa in vaishaali ngr').localities[0]?.slug).toBe('vaishali-nagar');
    expect(parse('malviya 2bhk').localities[0]?.slug).toBe('malviya-nagar');
  });

  it('knows Jaipur landmarks', () => {
    const i = parse('girls PG with food near WTP');
    expect(i.near?.name).toBe('World Trade Park');
    expect(i.types).toEqual(['pg']);
    expect(i.pgGender).toBe('female');
    expect(i.pgFood).toBe(true);
    expect(parse('22 godam ke paas office').near?.name).toBe('22 Godam');
  });

  it('reads budgets, ranges and areas without mixing them up', () => {
    expect(parse('office c scheme between 50k and 1 lakh')).toMatchObject({
      minPrice: 50000,
      maxPrice: 100000,
    });
    expect(parse('malviya 2bhk 15-20k')).toMatchObject({ minPrice: 15000, maxPrice: 20000 });
    const s = parse('1200 sqft flat on sale tonk road 60 lakh');
    expect(s).toMatchObject({ listingType: 'sale', areaSqft: 1200, maxPrice: 6_000_000 });
    expect(s.near).toBeUndefined();
    expect(parse('JDA plot ajmer road 40 lakh')).toMatchObject({
      listingType: 'sale',
      maxPrice: 4_000_000,
      plotApproval: 'jda',
    });
    expect(parse('2/3 bhk lift gym').bedrooms).toEqual([2, 3]);
  });

  it('understands nothing in small talk', () => {
    const i = parse('hello');
    expect(i.localities).toEqual([]);
    expect(i.types).toBeUndefined();
  });

  it('builds the same key for spelling variants', () => {
    expect(phoneticKey('vaishaali nagar')).toBe(phoneticKey('vaishali nagar'));
    expect(toLatin('जयपुर')).toContain('jaipur');
  });
});

/* ------------------------------------------------------------------ */

let app: Express;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);

describe('GET /smart-search', () => {
  beforeEach(async () => {
    await resetDb();
    clearSmartSearchCache();
    await createAdmin();
    await City.create({
      name: 'Jaipur',
      slug: 'jaipur',
      state: 'Rajasthan',
      localities: [
        { name: 'Vaishali Nagar', slug: 'vaishali-nagar', center: { lat: 26.911, lng: 75.743 } },
        { name: 'Malviya Nagar', slug: 'malviya-nagar', center: { lat: 26.855, lng: 75.815 } },
        { name: 'Nirman Nagar', slug: 'nirman-nagar', center: { lat: 26.885, lng: 75.755 } },
      ],
    });
    const s = await signIn(app);
    const add = async (o: object) => {
      const res = await s.post(
        '/api/v1/admin/properties',
        residential({ status: 'published', ...o }),
      );
      if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    };
    await add({ title: 'Perfect furnished 2 BHK', price: 14000, furnishingStatus: 'furnished' });
    await add({
      title: 'Slightly pricey furnished 2 BHK',
      price: 16500,
      furnishingStatus: 'furnished',
    });
    await add({
      title: 'Nearby furnished 2 BHK',
      price: 14500,
      furnishingStatus: 'furnished',
      localitySlug: 'nirman-nagar',
    });
    await add({
      title: 'Far away 2 BHK',
      price: 12000,
      furnishingStatus: 'furnished',
      localitySlug: 'malviya-nagar',
    });
    await add({ title: 'Way too costly 2 BHK', price: 60000, furnishingStatus: 'furnished' });
  });

  const get = (qs: Record<string, string>) => request(app).get('/api/v1/smart-search').query(qs);

  it('puts the exact match first, then the closest ones, with reasons', async () => {
    const res = await get({ q: '2bhk furnished vaishali nagar 15000 tak', deal: 'rent' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.exactCount).toBe(1);
    const titles = d.items.map((i: { title: string }) => i.title);
    expect(titles[0]).toBe('Perfect furnished 2 BHK');
    expect(titles).toContain('Nearby furnished 2 BHK');
    expect(titles).toContain('Slightly pricey furnished 2 BHK');
    expect(titles).not.toContain('Way too costly 2 BHK');
    expect(d.items[0].match.exact).toBe(true);
    expect(d.items[0].match.reasons.map((r: { label: string }) => r.label)).toContain(
      'Vaishali Nagar',
    );
    expect(d.summary).toMatch(/mile/);
    expect(d.chips.map((c: { key: string }) => c.key)).toEqual(
      expect.arrayContaining([
        'deal',
        'bedrooms',
        'furnishing',
        'locality:vaishali-nagar',
        'budget',
      ]),
    );
    expect(d.budgetSuggestion).toMatchObject({ maxPrice: 17000, extra: 1 });
  });

  it('lets visitors drop a chip or raise the budget', async () => {
    const dropped = await get({
      q: '2bhk furnished vaishali nagar 15000 tak',
      drop: 'locality:vaishali-nagar',
    });
    expect(dropped.body.data.exactCount).toBe(3);
    const raised = await get({ q: '2bhk furnished vaishali nagar 15000 tak', maxPrice: '17000' });
    expect(raised.body.data.exactCount).toBe(2);
  });

  it('logs searches for the team, and lists what was not understood', async () => {
    await get({ q: 'hello there' });
    await get({ q: '2bhk vaishali' });
    await new Promise((r) => setTimeout(r, 50));
    expect(await SearchLog.countDocuments()).toBe(2);
    const s = await signIn(app);
    const res = await s.get('/api/v1/admin/search-insights');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.notUnderstoodQueries[0].text).toBe('hello there');
  });

  it('rejects empty or very long text', async () => {
    expect((await get({ q: '' })).status).toBe(422);
    expect((await get({ q: 'x'.repeat(201) })).status).toBe(422);
  });
});
