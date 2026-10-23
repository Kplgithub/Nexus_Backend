import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createAdmin, resetDb, seedJaipur, signIn, startDb, stopDb } from './helpers.js';
import { Enquiry } from '../src/models/misc.models.js';
import { detectImageType } from '../src/services/upload.service.js';

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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

const upload = (files: { buf: Buffer; name: string; type: string }[]) => {
  let req = s.agent.post('/api/v1/admin/uploads').set('X-CSRF-Token', s.csrf);
  for (const f of files)
    req = req.attach('files', f.buf, { filename: f.name, contentType: f.type });
  return req;
};

describe('image uploads', () => {
  it('detects types from file content', () => {
    expect(detectImageType(PNG)?.mime).toBe('image/png');
    expect(detectImageType(Buffer.from('<?php echo 1; ?> padding'))).toBeNull();
  });

  it('accepts real images and rejects disguised files, per file', async () => {
    const res = await upload([
      { buf: PNG, name: 'room.png', type: 'image/png' },
      {
        buf: Buffer.from('<svg onload=alert(1)></svg> padding'),
        name: 'evil.jpg',
        type: 'image/jpeg',
      },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.data[0].ok).toBe(true);
    expect(res.body.data[0].image.url).toMatch(/\.png$/);
    expect(res.body.data[1].ok).toBe(false);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/v1/admin/uploads').attach('files', PNG, 'a.png');
    expect(res.status).toBe(401);
  });

  it('rejects oversized files', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    const res = await upload([{ buf: big, name: 'big.png', type: 'image/png' }]);
    expect(res.status).toBe(400);
  });
});

describe('end-to-end journey (API level)', () => {
  it.each([
    [
      'residential',
      {
        category: 'residential',
        propertyType: 'apartment',
        bedrooms: 2,
        bathrooms: 2,
        localitySlug: 'vaishali-nagar',
      },
      'category=residential&city=jaipur&minPrice=10000&maxPrice=25000&bedrooms=2',
    ],
    [
      'commercial',
      { category: 'commercial', propertyType: 'office', localitySlug: 'c-scheme' },
      'category=commercial&city=jaipur&locality=c-scheme&propertyType=office&maxPrice=25000',
    ],
  ])(
    '%s: create → upload → publish → search → view → enquire → manage',
    async (_label, typeFields, qs) => {
      // 1–2. Admin is signed in (beforeEach) and creates a property.
      const created = await s.post('/api/v1/admin/properties', {
        title: 'Journey test listing for verification',
        description:
          'A listing created during the automated journey test to verify the full workflow end to end.',
        listingType: 'rent',
        citySlug: 'jaipur',
        price: 20000,
        areaValue: 900,
        areaUnit: 'sqft',
        furnishingStatus: 'semi-furnished',
        ...typeFields,
      });
      expect(created.status).toBe(201);
      const id = created.body.data.id;

      // 3. Upload images, attach them, publish.
      const up = await upload([{ buf: PNG, name: 'front.png', type: 'image/png' }]);
      const image = up.body.data[0].image;
      expect(
        (
          await s.patch(`/api/v1/admin/properties/${id}`, {
            images: [{ ...image, alt: 'Front view' }],
          })
        ).status,
      ).toBe(200);
      expect(
        (await s.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' })).status,
      ).toBe(200);

      // 4–5. Visible publicly and found by search.
      const results = await request(app).get(`/api/v1/properties?${qs}`);
      expect(results.body.data.map((p: { id: string }) => p.id)).toContain(id);

      // 6. Details page data.
      const slug = created.body.data.slug;
      const detail = await request(app).get(`/api/v1/properties/${slug}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.property.images[0].alt).toBe('Front view');

      // 7–8. Visitor enquiry is saved.
      const enq = await request(app).post('/api/v1/enquiries').send({
        name: 'Visitor',
        phone: '9829044444',
        consent: true,
        propertyId: id,
        elapsedMs: 9000,
        message: 'Please call me',
      });
      expect(enq.status).toBe(201);
      expect(await Enquiry.countDocuments({ property: id })).toBe(1);

      // 9. Admin views and updates it.
      const list = await s.get(`/api/v1/admin/enquiries?propertyId=${id}`);
      expect(list.body.data[0].leadId).toBe(enq.body.data.leadId);
      const upd = await s.patch(`/api/v1/admin/enquiries/${list.body.data[0].id}`, {
        status: 'qualified',
      });
      expect(upd.body.data.status).toBe('qualified');
    },
  );
});
