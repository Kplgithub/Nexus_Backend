import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  createAdmin,
  resetDb,
  seedJaipur,
  signIn,
  signUpUser,
  startDb,
  stopDb,
  userListing,
} from './helpers.js';
import { User } from '../src/models/user.model.js';
import { Enquiry } from '../src/models/misc.models.js';

let app: Express;

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  await seedJaipur();
});

describe('sign-up', () => {
  it.each(['individual', 'agent', 'builder'] as const)(
    'creates a %s account and signs in',
    async (role) => {
      const u = await signUpUser(app, role);
      const me = await u.get('/api/v1/me');
      expect(me.status).toBe(200);
      expect(me.body.data.user.role).toBe(role);
      expect(me.body.data.user.phone).toMatch(/^\+91/);
      expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    },
  );

  it('requires a company name for agents and builders', async () => {
    const res = await request(app).post('/api/v1/auth/signup').send({
      role: 'agent',
      name: 'No Company',
      email: 'nc@example.test',
      phone: '9829099999',
      password: 'secret123',
      acceptTerms: true,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.companyName).toBeDefined();
  });

  it('rejects duplicate email and phone', async () => {
    const first = await signUpUser(app);
    const res = await request(app).post('/api/v1/auth/signup').send({
      role: 'individual',
      name: 'Copy Cat',
      email: first.user.email,
      phone: first.user.phone,
      password: 'secret123',
      acceptTerms: true,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.email).toBeDefined();
    expect(res.body.error.details.phone).toBeDefined();
  });

  it('sends a verification code and verifies the phone', async () => {
    const u = await signUpUser(app);
    expect(u.user.phoneVerified).toBe(false);
    expect(u.devCode).toMatch(/^\d{6}$/);
    expect((await u.post('/api/v1/me/verify-phone/confirm', { code: '000000' })).status).toBe(400);
    const ok = await u.post('/api/v1/me/verify-phone/confirm', { code: u.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.data.phoneVerified).toBe(true);
  });
});

describe('sign-in', () => {
  it('signs in with email or mobile and password', async () => {
    const u = await signUpUser(app);
    for (const identifier of [u.user.email, u.user.phone.replace('+91', '')]) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ identifier, password: u.password });
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(u.user.id);
    }
    const bad = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: u.user.email, password: 'wrong123' });
    expect(bad.status).toBe(401);
  });

  it('signs in with an SMS code', async () => {
    const u = await signUpUser(app);
    const sent = await request(app)
      .post('/api/v1/auth/otp/request')
      .send({ phone: u.user.phone, purpose: 'login' });
    expect(sent.status).toBe(200);
    const res = await request(app)
      .post('/api/v1/auth/otp/login')
      .send({ phone: u.user.phone, code: sent.body.data.devCode });
    expect(res.status).toBe(200);
    expect(res.body.data.user.phoneVerified).toBe(true);
  });

  it('does not reveal whether a number is registered', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/request')
      .send({ phone: '9829011111', purpose: 'login' });
    expect(res.status).toBe(200);
    expect(res.body.data.devCode).toBeUndefined();
  });

  it('resets a password by SMS code and signs out old sessions', async () => {
    const u = await signUpUser(app);
    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ identifier: u.user.phone });
    expect(forgot.status).toBe(200);
    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ phone: u.user.phone, code: forgot.body.data.devCode, password: 'newpass456' });
    expect(reset.status).toBe(200);
    expect((await u.get('/api/v1/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: u.user.email, password: 'newpass456' });
    expect(login.status).toBe(200);
  });

  it('keeps website users out of the admin panel', async () => {
    const u = await signUpUser(app);
    expect((await u.get('/api/v1/admin/dashboard')).status).toBe(401);
  });

  it('requires the user CSRF token on writes', async () => {
    const u = await signUpUser(app);
    const res = await u.agent.patch('/api/v1/me').send({ name: 'Changed' });
    expect(res.status).toBe(403);
    expect((await u.patch('/api/v1/me', { name: 'Changed' })).status).toBe(200);
  });
});

describe('posting and moderation', () => {
  it('drafts, submits, approves and publishes a user listing', async () => {
    const owner = await signUpUser(app);
    const admin = await signIn(app);

    const draft = await owner.post('/api/v1/me/properties', userListing());
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('draft');
    const id = draft.body.data.id;

    // Not public yet
    expect((await request(app).get('/api/v1/properties?listingType=sale')).body.meta.total).toBe(0);

    const submitted = await owner.post(`/api/v1/me/properties/${id}/status`, { status: 'pending' });
    expect(submitted.body.data.status).toBe('pending');

    const queue = await admin.get('/api/v1/admin/properties?status=pending');
    expect(queue.body.data.map((p: { id: string }) => p.id)).toContain(id);
    expect(queue.body.data[0].postedBy.role).toBe('individual');

    const rejected = await admin.post(`/api/v1/admin/properties/${id}/status`, {
      status: 'rejected',
    });
    expect(rejected.status).toBe(400); // a note is required
    await admin.post(`/api/v1/admin/properties/${id}/status`, {
      status: 'rejected',
      note: 'Add a clearer cover photo',
    });
    const mine = await owner.get(`/api/v1/me/properties/${id}`);
    expect(mine.body.data.status).toBe('rejected');
    expect(mine.body.data.moderationNote).toBe('Add a clearer cover photo');

    await owner.post(`/api/v1/me/properties/${id}/status`, { status: 'pending' });
    await admin.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });

    const search = await request(app).get('/api/v1/properties?listingType=sale&city=jaipur');
    expect(search.body.meta.total).toBe(1);
    expect(search.body.data[0].posterType).toBe('owner');
    const detail = await request(app).get(`/api/v1/properties/${draft.body.data.slug}`);
    expect(detail.body.data.property.poster.type).toBe('owner');
    expect(detail.body.data.property.pricePerSqft).toBe(Math.round(5500000 / 1400));
    expect(JSON.stringify(detail.body)).not.toContain(owner.user.phone);
    expect(JSON.stringify(detail.body)).not.toContain(owner.user.email);
  });

  it('sends edits to a live listing back for review', async () => {
    const owner = await signUpUser(app, 'agent');
    const admin = await signIn(app);
    const { id } = (await owner.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await admin.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    const edited = await owner.patch(`/api/v1/me/properties/${id}`, { price: 5400000 });
    expect(edited.body.data.status).toBe('pending');
    expect((await request(app).get('/api/v1/properties')).body.meta.total).toBe(0);
  });

  it('blocks admin-only fields and other users’ listings', async () => {
    const a = await signUpUser(app);
    const b = await signUpUser(app);
    expect((await a.post('/api/v1/me/properties', userListing({ featured: true }))).status).toBe(
      422,
    );
    expect(
      (await a.post('/api/v1/me/properties', userListing({ status: 'published' }))).status,
    ).toBe(422);
    const { id } = (await a.post('/api/v1/me/properties', userListing())).body.data;
    expect((await b.get(`/api/v1/me/properties/${id}`)).status).toBe(404);
    expect((await b.patch(`/api/v1/me/properties/${id}`, { price: 1 })).status).toBe(404);
    expect((await b.del(`/api/v1/me/properties/${id}`)).status).toBe(404);
  });

  it('enforces the listing limit for individuals', async () => {
    const owner = await signUpUser(app);
    for (let i = 0; i < 5; i++) {
      expect(
        (await owner.post('/api/v1/me/properties', userListing({ status: 'pending' }))).status,
      ).toBe(201);
    }
    const sixth = await owner.post('/api/v1/me/properties', userListing({ status: 'pending' }));
    expect(sixth.status).toBe(403);
    expect(sixth.body.error.code).toBe('LISTING_LIMIT');
  });

  it('lets the poster close a live listing', async () => {
    const owner = await signUpUser(app);
    const admin = await signIn(app);
    const { id } = (await owner.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await admin.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    expect(
      (await owner.post(`/api/v1/me/properties/${id}/status`, { status: 'rented' })).status,
    ).toBeGreaterThanOrEqual(400);
    const sold = await owner.post(`/api/v1/me/properties/${id}/status`, { status: 'sold' });
    expect(sold.body.data.status).toBe('sold');
  });
});

describe('saved, leads and contact', () => {
  async function liveListing() {
    const poster = await signUpUser(app, 'agent');
    const admin = await signIn(app);
    const created = (await poster.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await admin.post(`/api/v1/admin/properties/${created.id}/status`, { status: 'published' });
    return { poster, admin, id: created.id as string, slug: created.slug as string };
  }

  it('saves and unsaves properties', async () => {
    const { id } = await liveListing();
    const buyer = await signUpUser(app);
    expect((await buyer.put(`/api/v1/me/saved/${id}`)).status).toBe(200);
    expect((await buyer.get('/api/v1/me/saved/ids')).body.data).toEqual([id]);
    expect((await buyer.get('/api/v1/me/saved')).body.data[0].id).toBe(id);
    await buyer.del(`/api/v1/me/saved/${id}`);
    expect((await buyer.get('/api/v1/me/saved/ids')).body.data).toEqual([]);
  });

  it('routes enquiries to the poster and records the sender', async () => {
    const { poster, id } = await liveListing();
    const buyer = await signUpUser(app);
    const res = await buyer.post('/api/v1/enquiries', {
      name: 'Asha Verma',
      phone: buyer.user.phone,
      message: 'Is the price negotiable?',
      propertyId: id,
      consent: true,
      elapsedMs: 9000,
    });
    expect(res.status).toBe(201);
    const leads = await poster.get('/api/v1/me/leads');
    expect(leads.body.data).toHaveLength(1);
    expect(leads.body.data[0].message).toBe('Is the price negotiable?');
    expect(leads.body.data[0].seen).toBe(false);
    const sent = await buyer.get('/api/v1/me/enquiries');
    expect(sent.body.data[0].property.id).toBe(id);
    const dash = await poster.get('/api/v1/me/dashboard');
    expect(dash.body.data.leads.unseen).toBe(1);
    await poster.post('/api/v1/me/leads/seen', {});
    expect((await poster.get('/api/v1/me/dashboard')).body.data.leads.unseen).toBe(0);
  });

  it('reveals contact details only to verified, signed-in users and logs a lead', async () => {
    const { poster, id } = await liveListing();
    expect((await request(app).post(`/api/v1/me/contact/${id}`)).status).toBe(401);
    const buyer = await signUpUser(app);
    const unverified = await buyer.post(`/api/v1/me/contact/${id}`);
    expect(unverified.status).toBe(403);
    expect(unverified.body.error.code).toBe('PHONE_NOT_VERIFIED');
    await buyer.post('/api/v1/me/verify-phone/confirm', { code: buyer.devCode });
    const shown = await buyer.post(`/api/v1/me/contact/${id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data.phone).toBe(poster.user.phone);
    expect(await Enquiry.countDocuments({ type: 'contact', listingOwner: poster.user.id })).toBe(1);
    // Repeat views don't create duplicate leads.
    await buyer.post(`/api/v1/me/contact/${id}`);
    expect(await Enquiry.countDocuments({ type: 'contact' })).toBe(1);
  });

  it('respects a poster who hides their number', async () => {
    const { poster, id } = await liveListing();
    await poster.patch('/api/v1/me', { showPhone: false });
    const buyer = await signUpUser(app);
    await buyer.post('/api/v1/me/verify-phone/confirm', { code: buyer.devCode });
    expect((await buyer.post(`/api/v1/me/contact/${id}`)).status).toBe(403);
  });
});

describe('admin user management', () => {
  it('lists, verifies and blocks users', async () => {
    const agent = await signUpUser(app, 'agent');
    const admin = await signIn(app);
    const list = await admin.get('/api/v1/admin/users?role=agent');
    expect(list.body.meta.total).toBe(1);
    const verified = await admin.patch(`/api/v1/admin/users/${agent.user.id}`, { verified: true });
    expect(verified.body.data.verified).toBe(true);
    await admin.patch(`/api/v1/admin/users/${agent.user.id}`, { status: 'blocked' });
    expect((await agent.get('/api/v1/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: agent.user.email, password: agent.password });
    expect(login.status).toBe(403);
    expect((await User.findById(agent.user.id).lean())?.status).toBe('blocked');
  });

  it('shows users in the admin dashboard', async () => {
    await signUpUser(app, 'builder');
    const admin = await signIn(app);
    const dash = await admin.get('/api/v1/admin/dashboard');
    expect(dash.body.data.users.builder).toBe(1);
  });
});
