import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createAdmin, resetDb, seedJaipur, signIn, startDb, stopDb } from './helpers.js';
import { Property } from '../src/models/property.model.js';
import { parseCsv } from '../src/lib/csv.js';
import {
  importTemplateCsv,
  mapImportRow,
  parseMoney,
  type CityLookup,
} from '../src/services/property-import.service.js';

const cities: CityLookup[] = [
  {
    name: 'Jaipur',
    slug: 'jaipur',
    localities: [
      { name: 'Vaishali Nagar', slug: 'vaishali-nagar' },
      { name: 'Malviya Nagar', slug: 'malviya-nagar' },
    ],
  },
];

describe('CSV parsing', () => {
  it('reads quotes, commas inside cells, CRLF and the Excel BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['1', '2'],
    ]);
  });

  it('reads its own template back', () => {
    const rows = parseCsv(importTemplateCsv());
    expect(rows[0]).toContain('locality');
    expect(rows).toHaveLength(3);
  });
});

describe('row mapping', () => {
  it('understands Indian amounts', () => {
    expect(parseMoney('₹25,000')).toBe(25000);
    expect(parseMoney('35k')).toBe(35000);
    expect(parseMoney('1.2 lakh')).toBe(120000);
    expect(parseMoney('1.5 cr')).toBe(15000000);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('call')).toBeNaN();
  });

  it('maps a broker row and writes a title and description', () => {
    const { input, errors } = mapImportRow(
      {
        property_type: 'Flat',
        bhk: '2',
        bathrooms: '2',
        locality: 'vaishali nagar',
        rent_or_price: '18,000',
        area: '1100',
        area_unit: 'sq ft',
        furnishing: 'semi',
        tenants: 'family; bachelors',
        amenities: 'lift, power backup',
        available_from: '15-11-2026',
        owner_contact: 'Ramesh 9800000000',
      },
      cities,
    );
    expect(errors).toEqual([]);
    expect(input).toMatchObject({
      listingType: 'rent',
      category: 'residential',
      propertyType: 'apartment',
      citySlug: 'jaipur',
      localitySlug: 'vaishali-nagar',
      price: 18000,
      bedrooms: 2,
      areaUnit: 'sqft',
      furnishingStatus: 'semi-furnished',
      preferredTenants: ['family', 'bachelors'],
      amenities: ['lift', 'power-backup'],
      ownerReference: 'Ramesh 9800000000',
      status: 'draft',
      title: '2 BHK Apartment / Flat for Rent in Vaishali Nagar',
    });
    expect(String(input.description).length).toBeGreaterThanOrEqual(30);
    expect((input.availableFrom as Date).toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('reports every problem in a row', () => {
    const { errors } = mapImportRow(
      { locality: 'Nowhere', rent_or_price: 'call', area: '', furnishing: 'maybe' },
      cities,
    );
    expect(errors.join('\n')).toMatch(/locality/);
    expect(errors.join('\n')).toMatch(/rent_or_price/);
    expect(errors.join('\n')).toMatch(/area: required/);
    expect(errors.join('\n')).toMatch(/furnishing/);
  });
});

describe('POST /admin/properties/import', () => {
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

  const csv = [
    'Property Type,BHK,Bathrooms,Locality,Rent,Area,Furnishing',
    'apartment,2,2,Vaishali Nagar,18000,1100,semi',
    'apartment,3,2,C-Scheme,32k,1500,furnished',
    'apartment,2,2,Unknown Place,15000,900,semi',
  ].join('\n');

  const send = (dryRun: boolean) =>
    s.agent
      .post(`/api/v1/admin/properties/import${dryRun ? '?dryRun=1' : ''}`)
      .set('X-CSRF-Token', s.csrf)
      .attach('file', Buffer.from(csv), { filename: 'stock.csv', contentType: 'text/csv' });

  it('dry run checks rows without saving', async () => {
    const res = await send(true);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 3, valid: 2, created: 0 });
    expect(res.body.data.results[2]).toMatchObject({ row: 4, ok: false });
    expect(await Property.countDocuments()).toBe(0);
  });

  it('creates valid rows as drafts and skips bad ones', async () => {
    const res = await send(false);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 3, valid: 2, created: 2 });
    const saved = await Property.find().lean();
    expect(saved).toHaveLength(2);
    expect(saved.every((p) => p.status === 'draft' && p.images.length === 0)).toBe(true);
  });

  it('serves the template', async () => {
    const res = await s.get('/api/v1/admin/properties/import/template');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
  });
});
