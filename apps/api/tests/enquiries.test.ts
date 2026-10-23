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
import { Enquiry } from '../src/models/misc.models.js';

let app: Express;
let s: Awaited<ReturnType<typeof signIn>>;
let property: { id: string; slug: string; title: string };

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  await seedJaipur();
  s = await signIn(app);
  property = (await s.post('/api/v1/admin/properties', residential({ status: 'published' }))).body
    .data;
});

const enquiry = (o: Record<string, unknown> = {}) => ({
  name: 'Asha Verma',
  phone: '98290 12345',
  email: 'asha@example.test',
  message: 'Is this available from next month?',
  consent: true,
  elapsedMs: 15_000,
  sourcePage: '/properties/test',
  ...o,
});

describe('public enquiries', () => {
  it('saves a valid enquiry and returns a lead id', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.leadId).toMatch(/^NX-E-\d{4}-\d{5}$/);
    const saved = await Enquiry.findOne({ leadId: res.body.data.leadId }).lean();
    expect(saved?.phone).toBe('+919829012345');
    expect(saved?.status).toBe('new');
    expect(saved?.type).toBe('property');
    expect(String(saved?.property)).toBe(property.id);
    expect(saved?.propertySnapshot?.title).toBe(property.title);
    expect(saved?.consentAt).toBeInstanceOf(Date);
    expect(saved?.sourcePage).toBe('/properties/test');
  });

  it('rejects invalid Indian numbers', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ phone: '12345' }));
    expect([400, 422]).toContain(res.status);
    expect(await Enquiry.countDocuments()).toBe(0);
  });

  it('accepts international numbers only when enabled', async () => {
    const intl = enquiry({ phone: '+44 7911 123456' });
    expect((await request(app).post('/api/v1/enquiries').send(intl)).status).toBe(400);
    await s.patch('/api/v1/admin/settings', { allowInternationalEnquiries: true });
    expect((await request(app).post('/api/v1/enquiries').send(intl)).status).toBe(201);
  });

  it('requires consent', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ consent: false }));
    expect(res.status).toBe(422);
    expect(res.body.error.details.consent).toBeDefined();
  });

  it('strips markup from messages', async () => {
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ message: '<img src=x onerror=alert(1)>hello' }));
    const saved = await Enquiry.findOne().lean();
    expect(saved?.message).not.toMatch(/[<>]/);
  });

  it('marks honeypot and too-fast submissions as spam (still saved, hidden from inbox)', async () => {
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ website: 'http://spam.example' }));
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ phone: '9829011111', elapsedMs: 300 }));
    expect(await Enquiry.countDocuments({ status: 'spam' })).toBe(2);
    const inbox = await s.get('/api/v1/admin/enquiries');
    expect(inbox.body.meta.total).toBe(0);
  });

  it('de-duplicates rapid repeat submissions', async () => {
    const a = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    const b = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    expect(a.body.data.leadId).toBe(b.body.data.leadId);
    expect(await Enquiry.countDocuments()).toBe(1);
  });

  it('strips $ operators from bodies', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send({ ...enquiry(), name: { $gt: '' } });
    expect(res.status).toBe(422);
  });
});

describe('admin enquiry management', () => {
  it('lists, filters, updates and exports enquiries', async () => {
    const created = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    const leadId = created.body.data.leadId;

    const list = await s.get('/api/v1/admin/enquiries?status=new');
    expect(list.body.meta.total).toBe(1);
    const id = list.body.data[0].id;
    expect(list.body.data[0].property.slug).toBe(property.slug);

    const search = await s.get(`/api/v1/admin/enquiries?q=${leadId}`);
    expect(search.body.meta.total).toBe(1);

    const followUp = new Date(Date.now() - 60_000).toISOString();
    const upd = await s.patch(`/api/v1/admin/enquiries/${id}`, {
      status: 'contacted',
      note: 'Called, visit on Sunday',
      followUpAt: followUp,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.data.status).toBe('contacted');
    expect(upd.body.data.notes[0].text).toBe('Called, visit on Sunday');

    const due = await s.get('/api/v1/admin/enquiries?followUpDue=true');
    expect(due.body.meta.total).toBe(1);

    const csv = await s.get('/api/v1/admin/enquiries/export.csv?status=contacted');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain(leadId);

    const dash = await s.get('/api/v1/admin/dashboard');
    expect(dash.body.data.enquiries.contacted).toBe(1);
    expect(dash.body.data.properties.published).toBe(1);
  });

  it('protects CSV exports from formula injection', async () => {
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ name: '=HYPERLINK("x")' }));
    const csv = await s.get('/api/v1/admin/enquiries/export.csv');
    expect(csv.text).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
