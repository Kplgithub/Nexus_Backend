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

describe('home loan enquiries', () => {
  beforeEach(async () => {
    await s.patch('/api/v1/admin/settings', { homeLoan: { enabled: true } });
  });

  it('refuses loan leads while the feature is switched off', async () => {
    await s.patch('/api/v1/admin/settings', { homeLoan: { enabled: false } });
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send(
        enquiry({
          type: 'home-loan',
          loan: { amount: 3_500_000, employment: 'salaried', purpose: 'looking' },
        }),
      );
    expect(res.status).toBe(403);
  });

  const loan = (o: Record<string, unknown> = {}) =>
    enquiry({
      type: 'home-loan',
      sourcePage: '/home-loan',
      loan: {
        amount: 3_500_000,
        monthlyIncome: 90_000,
        employment: 'salaried',
        purpose: 'looking',
      },
      ...o,
    });

  it('saves a loan lead with its own id and keeps it away from the listing owner', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .send(
        loan({
          propertyId: property.id,
          loan: { amount: 4_000_000, employment: 'business', purpose: 'found', lender: 'Bank 2' },
        }),
      );
    expect(res.status).toBe(201);
    expect(res.body.data.leadId).toMatch(/^NX-H-\d{4}-\d{5}$/);
    const saved = await Enquiry.findOne({ leadId: res.body.data.leadId }).lean();
    expect(saved?.type).toBe('home-loan');
    expect(saved?.loan?.amount).toBe(4_000_000);
    expect(saved?.loan?.stage).toBe('new');
    expect(saved?.loan?.lender).toBe('Bank 2');
    expect(String(saved?.property)).toBe(property.id);
    expect(saved?.listingOwner).toBeNull();
  });

  it('needs loan details and a sensible amount', async () => {
    expect(
      (
        await request(app)
          .post('/api/v1/enquiries')
          .send(loan({ loan: undefined }))
      ).status,
    ).toBe(422);
    expect(
      (
        await request(app)
          .post('/api/v1/enquiries')
          .send(loan({ loan: { amount: 500, employment: 'salaried', purpose: 'looking' } }))
      ).status,
    ).toBe(422);
  });

  it('does not merge a loan lead into a property enquiry from the same phone', async () => {
    const a = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    const b = await request(app)
      .post('/api/v1/enquiries')
      .send(loan({ propertyId: property.id }));
    expect(a.body.data.leadId).not.toBe(b.body.data.leadId);
  });

  it('lets the team filter loan leads and move them to a bank', async () => {
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: property.id }));
    await request(app).post('/api/v1/enquiries').send(loan());
    const list = await s.get('/api/v1/admin/enquiries?type=home-loan');
    expect(list.body.data).toHaveLength(1);
    const id = list.body.data[0].id;
    expect(list.body.data[0].loan.employment).toBe('salaried');

    // Needs a bank name before it can be marked as sent.
    expect(
      (await s.patch(`/api/v1/admin/enquiries/${id}`, { loanStage: 'sent-to-bank' })).status,
    ).toBe(400);
    const sent = await s.patch(`/api/v1/admin/enquiries/${id}`, {
      loanBank: 'Some Bank',
      loanStage: 'sent-to-bank',
    });
    expect(sent.status).toBe(200);
    expect(sent.body.data.loan.stage).toBe('sent-to-bank');
    expect(sent.body.data.loan.bank).toBe('Some Bank');
    expect(sent.body.data.loan.sentToBankAt).toBeTruthy();
    expect(sent.body.data.notes.at(-1).text).toContain('Sent to bank');

    const normal = (await s.get('/api/v1/admin/enquiries?type=property')).body.data[0].id;
    expect(
      (await s.patch(`/api/v1/admin/enquiries/${normal}`, { loanStage: 'called' })).status,
    ).toBe(400);
  });

  it('stores lender rates in settings and shows them publicly', async () => {
    const before = await request(app).get('/api/v1/settings');
    expect(before.body.data.homeLoan.lenders).toEqual([]);
    expect(before.body.data.homeLoan.enabled).toBe(true);
    const checked = new Date().toISOString();
    const res = await s.patch('/api/v1/admin/settings', {
      homeLoan: {
        enabled: true,
        lenders: [
          {
            name: 'Bank One',
            kind: 'bank',
            rateFrom: 7.4,
            maxTenureYears: 30,
            processingFee: '0.35%',
            active: true,
          },
        ],
        ratesCheckedAt: checked,
        exampleRate: 8.25,
      },
    });
    expect(res.status).toBe(200);
    // Saving another part of settings keeps the rates.
    await s.patch('/api/v1/admin/settings', { featurePrices: { days7: 49, days30: 99 } });
    const pub = await request(app).get('/api/v1/settings');
    expect(pub.body.data.homeLoan.lenders[0].name).toBe('Bank One');
    expect(pub.body.data.homeLoan.ratesCheckedAt).toBe(checked);
    expect(pub.body.data.homeLoan.exampleRate).toBe(8.25);
    // Flipping only the switch keeps the rates.
    await s.patch('/api/v1/admin/settings', { homeLoan: { enabled: false } });
    const off = await request(app).get('/api/v1/settings');
    expect(off.body.data.homeLoan.enabled).toBe(false);
    expect(off.body.data.homeLoan.lenders).toHaveLength(1);
  });
});
