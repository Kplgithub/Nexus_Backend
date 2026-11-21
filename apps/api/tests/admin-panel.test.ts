import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  ADMIN,
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
import { AdminNotification, Payment } from '../src/models/admin-panel.models.js';
import { Property } from '../src/models/property.model.js';
import { expireFeatured } from '../src/services/featured.service.js';
import { ensureDefaultPlan, razorpaySignatureValid } from '../src/services/billing.service.js';
import { istDayStart } from '../src/services/charts.service.js';

let app: Express;
let boss: Awaited<ReturnType<typeof signIn>>;

const SUB = { email: 'pooja@example.test', name: 'Pooja Sharma' };

async function addSubAdmin() {
  const res = await boss.post('/api/v1/admin/team', {
    name: SUB.name,
    email: SUB.email,
    password: ADMIN.password,
    role: 'editor',
  });
  expect(res.status).toBe(201);
  return { member: res.body.data, s: await signIn(app, SUB.email) };
}

const enquiry = (o: Record<string, unknown> = {}) => ({
  name: 'Rohit Sharma',
  phone: '98290 12345',
  message: 'Is this available?',
  consent: true,
  elapsedMs: 15_000,
  ...o,
});

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
  await seedJaipur();
  boss = await signIn(app);
});

describe('team: Super Admin and Sub-admin', () => {
  it('lets a Super Admin add a Sub-admin who can work but not manage', async () => {
    const { member, s } = await addSubAdmin();
    expect(member).toMatchObject({ role: 'editor', active: true, name: SUB.name });

    // Sub-admin can create and edit listings and website users' details…
    const p = await s.post('/api/v1/admin/properties', residential({ status: 'published' }));
    expect(p.status).toBe(201);
    const user = await signUpUser(app, 'agent');
    expect(
      (await s.patch(`/api/v1/admin/users/${user.user.id}`, { note: 'Called, looks fine' })).status,
    ).toBe(200);

    // …but cannot delete, export, change passwords or open Super Admin pages.
    expect((await s.del(`/api/v1/admin/properties/${p.body.data.id}`)).status).toBe(403);
    expect((await s.get('/api/v1/admin/enquiries/export.csv')).status).toBe(403);
    expect(
      (await s.post(`/api/v1/admin/users/${user.user.id}/password`, { password: 'newpass123' }))
        .status,
    ).toBe(403);
    for (const url of ['/api/v1/admin/team', '/api/v1/admin/activity', '/api/v1/admin/payments'])
      expect((await s.get(url)).status).toBe(403);
    expect((await s.patch('/api/v1/admin/settings', { tagline: 'x' })).status).toBe(403);

    // The Super Admin sees what the Sub-admin did.
    const log = await boss.get('/api/v1/admin/activity');
    expect(log.status).toBe(200);
    const mine = log.body.data.filter(
      (a: { actor: { name: string } | null }) => a.actor?.name === SUB.name,
    );
    expect(mine.map((a: { entity: string }) => a.entity)).toEqual(
      expect.arrayContaining(['property', 'user']),
    );
  });

  it('only Super Admins change passwords; the old session ends', async () => {
    const { member, s } = await addSubAdmin();
    const res = await boss.post(`/api/v1/admin/team/${member.id}/password`, {
      password: 'Another-Strong-Pass-7',
    });
    expect(res.status).toBe(200);
    expect((await s.get('/api/v1/admin/auth/me')).status).toBe(401);
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: SUB.email, password: 'Another-Strong-Pass-7' });
    expect(login.status).toBe(200);

    const user = await signUpUser(app);
    expect(
      (await boss.post(`/api/v1/admin/users/${user.user.id}/password`, { password: 'fresh1234' }))
        .status,
    ).toBe(200);
    const userLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ identifier: user.user.email, password: 'fresh1234' });
    expect(userLogin.status).toBe(200);
  });

  it('keeps at least one Super Admin and stops self-lockout', async () => {
    const me = (await boss.get('/api/v1/admin/auth/me')).body.data.admin;
    expect((await boss.patch(`/api/v1/admin/team/${me.id}`, { active: false })).status).toBe(400);
    const { member } = await addSubAdmin();
    // Turning a Sub-admin off ends their access at once.
    const off = await boss.patch(`/api/v1/admin/team/${member.id}`, { active: false });
    expect(off.body.data.active).toBe(false);
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: SUB.email, password: ADMIN.password });
    expect(login.status).toBe(401);
  });

  it('locks sign-in for 15 minutes after 5 wrong passwords', async () => {
    for (let i = 0; i < 5; i++)
      await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ email: ADMIN.email, password: 'nope' });
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(res.status).toBe(423);
  });
});

describe('leads: assignment, site visits, bell', () => {
  it('assigns a lead, books and completes a visit, and moves the lead forward', async () => {
    const { member, s } = await addSubAdmin();
    const prop = (await boss.post('/api/v1/admin/properties', residential({ status: 'published' })))
      .body.data;
    const sent = await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: prop.id }));
    expect(sent.status).toBe(201);

    // New lead rings everyone's bell.
    const bell = await s.get('/api/v1/admin/notifications');
    expect(bell.body.data.unread).toBeGreaterThan(0);
    expect(bell.body.data.items[0].title).toContain('Rohit Sharma');

    const lead = (await boss.get('/api/v1/admin/enquiries')).body.data[0];
    const assigned = await boss.post(`/api/v1/admin/enquiries/${lead.id}/assign`, {
      adminId: member.id,
    });
    expect(assigned.body.data.assignedAdmin).toEqual({ id: member.id, name: SUB.name });

    // The Sub-admin sees it under "my leads" and got a personal alert.
    const mine = await s.get('/api/v1/admin/enquiries?assignee=me');
    expect(mine.body.data.map((e: { id: string }) => e.id)).toEqual([lead.id]);
    expect((await boss.get('/api/v1/admin/enquiries?assignee=none')).body.data).toHaveLength(0);
    const kinds = (await s.get('/api/v1/admin/notifications')).body.data.items.map(
      (n: { kind: string }) => n.kind,
    );
    expect(kinds).toContain('assigned');

    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const visit = await s.post('/api/v1/admin/visits', {
      enquiryId: lead.id,
      name: lead.name,
      phone: lead.phone,
      scheduledAt: when,
      assignedAdminId: member.id,
    });
    expect(visit.status).toBe(201);
    expect(visit.body.data.property.id).toBe(prop.id);
    expect((await boss.get(`/api/v1/admin/enquiries/${lead.id}`)).body.data.status).toBe(
      'contacted',
    );

    const cal = await s.get(
      `/api/v1/admin/visits?from=${new Date().toISOString()}&to=${new Date(Date.now() + 7 * 86_400_000).toISOString()}`,
    );
    expect(cal.body.data).toHaveLength(1);

    const done = await s.patch(`/api/v1/admin/visits/${visit.body.data.id}`, {
      status: 'done',
      outcome: 'Liked it, will confirm by Monday',
    });
    expect(done.body.data.status).toBe('done');
    const after = (await boss.get(`/api/v1/admin/enquiries/${lead.id}`)).body.data;
    expect(after.status).toBe('qualified');
    expect(after.notes.at(-1).text).toContain('Liked it');

    // Team page shows the work in hand.
    const teamList = (await boss.get('/api/v1/admin/team')).body.data;
    const pooja = teamList.find((m: { id: string }) => m.id === member.id);
    expect(pooja.stats.openLeads).toBe(1);

    // Bell can be cleared.
    await s.post('/api/v1/admin/notifications/read', { all: true });
    expect((await s.get('/api/v1/admin/notifications')).body.data.unread).toBe(0);
  });

  it('does not assign to someone who is switched off', async () => {
    const { member } = await addSubAdmin();
    await boss.patch(`/api/v1/admin/team/${member.id}`, { active: false });
    await request(app).post('/api/v1/enquiries').send(enquiry());
    const lead = (await boss.get('/api/v1/admin/enquiries')).body.data[0];
    const res = await boss.post(`/api/v1/admin/enquiries/${lead.id}/assign`, {
      adminId: member.id,
    });
    expect(res.status).toBe(400);
  });
});

describe('dashboard charts', () => {
  it('returns real counts, per-day series and Super-Admin-only activity', async () => {
    const prop = (await boss.post('/api/v1/admin/properties', residential({ status: 'published' })))
      .body.data;
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ propertyId: prop.id }));
    await request(app)
      .post('/api/v1/enquiries')
      .send(enquiry({ phone: '98290 22222', name: 'Neha Jain' }));

    const res = await boss.get('/api/v1/admin/dashboard/charts?days=30');
    expect(res.status).toBe(200);
    const c = res.body.data;
    expect(c.days).toBe(30);
    expect(c.kpis.liveListings.value).toBe(1);
    expect(c.kpis.newLeads.value).toBe(2);
    expect(c.kpis.newLeads.spark).toHaveLength(30);
    expect(c.leadsByDay).toHaveLength(30);
    const today = c.leadsByDay.at(-1);
    expect(today.rent + today.other).toBe(2);
    expect(c.pipeline.total).toBe(2);
    expect(c.today.newLeads).toBe(2);
    expect(c.localities[0]).toMatchObject({ slug: 'vaishali-nagar', leads: 1, live: 1 });
    expect(c.listingsByType[0]).toMatchObject({ type: 'apartment', count: 1 });
    expect(c.activity.length).toBeGreaterThan(0);

    const { s } = await addSubAdmin();
    const sub = (await s.get('/api/v1/admin/dashboard/charts?days=7')).body.data;
    expect(sub.days).toBe(7);
    expect(sub.activity).toEqual([]);
  });

  it('starts days at midnight India time', () => {
    // 2026-11-21 20:00 IST = 14:30 UTC → day starts 2026-11-20 18:30 UTC.
    const start = istDayStart(0, Date.UTC(2026, 10, 21, 14, 30));
    expect(start.toISOString()).toBe('2026-11-20T18:30:00.000Z');
  });
});

describe('verification and featured listings', () => {
  it('queues new agents, verifies or rejects with a reason', async () => {
    const agent = await signUpUser(app, 'agent');
    await signUpUser(app, 'individual');
    const q = await boss.get('/api/v1/admin/verification?status=pending');
    expect(q.body.data.map((u: { id: string }) => u.id)).toEqual([agent.user.id]);
    expect(q.body.counts.waiting).toBe(1);
    const badges = (await boss.get('/api/v1/admin/badges')).body.data;
    expect(badges.verification).toBe(1);
    expect(badges.unread).toBeGreaterThanOrEqual(1);

    const noReason = await boss.post(`/api/v1/admin/users/${agent.user.id}/verification`, {
      decision: 'rejected',
    });
    expect(noReason.status).toBe(400);
    const ok = await boss.post(`/api/v1/admin/users/${agent.user.id}/verification`, {
      decision: 'verified',
    });
    expect(ok.body.data).toMatchObject({ verified: true, verificationStatus: 'verified' });
    const me = (await agent.get('/api/v1/me')).body.data.user;
    expect(me.verified).toBe(true);
  });

  it('features a live listing for a set time and expires it', async () => {
    const prop = (await boss.post('/api/v1/admin/properties', residential({ status: 'published' })))
      .body.data;
    const f = await boss.post(`/api/v1/admin/properties/${prop.id}/feature`, { days: 7 });
    expect(f.status).toBe(200);
    expect(new Date(f.body.data.featuredUntil).getTime()).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    expect((await boss.get('/api/v1/admin/featured')).body.data).toHaveLength(1);
    expect(
      (await boss.post(`/api/v1/admin/properties/${prop.id}/feature`, { days: 3 })).status,
    ).toBe(422);

    await Property.updateOne({ _id: prop.id }, { featuredUntil: new Date(Date.now() - 1000) });
    expect(await expireFeatured()).toBe(1);
    expect((await boss.get('/api/v1/admin/featured')).body.data).toHaveLength(0);

    const draft = (
      await boss.post(
        '/api/v1/admin/properties',
        residential({ title: 'Draft flat near Gandhi Path' }),
      )
    ).body.data;
    expect(
      (await boss.post(`/api/v1/admin/properties/${draft.id}/feature`, { days: 7 })).status,
    ).toBe(400);
  });
});

describe('plans and payments', () => {
  it('releases an owner’s waiting listing when a plan is paid, and ends the plan on refund', async () => {
    const plan = await boss.post('/api/v1/admin/plans', {
      name: 'Owner Plus',
      price: 999,
      durationDays: 30,
      listingLimit: 2,
      roles: ['individual'],
    });
    expect(plan.status).toBe(201);
    const owner = await signUpUser(app);

    // Owners have no free listings: the listing is saved and waits for a plan.
    const held = await owner.post(
      '/api/v1/me/properties',
      userListing({ status: 'pending', title: '3 BHK flat number one near Gandhi Path' }),
    );
    expect(held.body.data).toMatchObject({ status: 'draft', awaitingPlan: true });

    const { s } = await addSubAdmin();
    const body = {
      userId: owner.user.id,
      planId: plan.body.data.id,
      amount: 999,
      reference: 'UPI 1234',
    };
    expect((await s.post('/api/v1/admin/payments/manual', body)).status).toBe(403);
    const paid = await boss.post('/api/v1/admin/payments/manual', body);
    expect(paid.status).toBe(201);
    expect(paid.body.data).toMatchObject({
      status: 'paid',
      method: 'manual',
      amount: 999,
      kind: 'plan',
    });

    // The waiting listing went for review and used one of the plan's 2 slots.
    const mine = await owner.get(`/api/v1/me/properties/${held.body.data.id}`);
    expect(mine.body.data).toMatchObject({ status: 'pending', awaitingPlan: false });
    const second = await owner.post(
      '/api/v1/me/properties',
      userListing({ status: 'pending', title: '3 BHK flat number two near Gandhi Path' }),
    );
    expect(second.body.data.status).toBe('pending');
    const third = await owner.post(
      '/api/v1/me/properties',
      userListing({ status: 'pending', title: '3 BHK flat number three near Gandhi Path' }),
    );
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('LISTING_LIMIT');

    const dash = (await owner.get('/api/v1/me/dashboard')).body.data;
    expect(dash.usage).toMatchObject({ listings: { used: 2, limit: 2 }, premium: true });
    expect(dash.subscription.plan.name).toBe('Owner Plus');

    const summary = (await boss.get('/api/v1/admin/payments/summary')).body.data;
    expect(summary).toMatchObject({ thisMonth: 999, activeSubscriptions: 1, onlineEnabled: false });
    expect(await AdminNotification.countDocuments({ kind: 'payment' })).toBe(1);

    const refund = await boss.post(`/api/v1/admin/payments/${paid.body.data.id}/refund`);
    expect(refund.body.data.status).toBe('refunded');
    expect((await owner.get('/api/v1/me/dashboard')).body.data.subscription).toBeNull();
  });

  it('counts plan listings live at one time: unlisting one frees a place', async () => {
    const plan = (
      await boss.post('/api/v1/admin/plans', {
        name: 'Agent Two',
        price: 599,
        durationDays: 30,
        listingLimit: 2,
        roles: ['agent'],
      })
    ).body.data;
    const agent = await signUpUser(app, 'agent');
    await boss.post('/api/v1/admin/payments/manual', {
      userId: agent.user.id,
      planId: plan.id,
      amount: 599,
    });
    const post = (n: string) =>
      agent.post(
        '/api/v1/me/properties',
        userListing({ status: 'pending', title: `2 BHK flat number ${n} near Gandhi Path` }),
      );
    const one = (await post('one')).body.data;
    const two = (await post('two')).body.data;
    await boss.post(`/api/v1/admin/properties/${one.id}/status`, { status: 'published' });

    // Both places are taken (one live, one in review).
    const full = await post('three');
    expect(full.status).toBe(403);
    expect(full.body.error).toMatchObject({ code: 'LISTING_LIMIT' });
    expect(full.body.error.message).toContain('Unlist');
    // A draft does not need a place.
    const draft = await agent.post(
      '/api/v1/me/properties',
      userListing({ status: 'draft', title: '2 BHK flat number four near Gandhi Path' }),
    );
    expect(draft.status).toBe(201);
    expect((await agent.get('/api/v1/me/dashboard')).body.data.usage.listings).toEqual({
      used: 2,
      limit: 2,
    });

    // Unlisting the live one frees a place, so the draft can go for review.
    await agent.post(`/api/v1/me/properties/${one.id}/status`, { status: 'inactive' });
    const sent = await agent.patch(`/api/v1/me/properties/${draft.body.data.id}`, {
      status: 'pending',
    });
    expect(sent.body.data.status).toBe('pending');

    // Reactivating the old one now needs a place again.
    const back = await agent.post(`/api/v1/me/properties/${one.id}/status`, { status: 'pending' });
    expect(back.status).toBe(403);
    expect(back.body.error.code).toBe('LISTING_LIMIT');

    // Deleting one in review frees a place too.
    await agent.post(`/api/v1/me/properties/${two.id}/status`, { status: 'draft' });
    expect((await agent.del(`/api/v1/me/properties/${two.id}`)).status).toBeLessThan(300);
    const again = await agent.post(`/api/v1/me/properties/${one.id}/status`, {
      status: 'pending',
    });
    expect(again.body.data.status).toBe('pending');
  });

  it('keeps the free listings a lifetime total: deleting does not give one back', async () => {
    const agent = await signUpUser(app, 'agent');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await agent.post(
        '/api/v1/me/properties',
        userListing({ status: 'pending', title: `2 BHK flat free number ${i} near Gandhi Path` }),
      );
      expect(r.body.data.status).toBe('pending');
      ids.push(r.body.data.id);
    }
    await agent.post(`/api/v1/me/properties/${ids[0]}/status`, { status: 'draft' });
    await agent.del(`/api/v1/me/properties/${ids[0]}`);
    const sixth = await agent.post(
      '/api/v1/me/properties',
      userListing({ status: 'pending', title: '2 BHK flat free number six near Gandhi Path' }),
    );
    expect(sixth.body.data).toMatchObject({ status: 'draft', awaitingPlan: true });
  });

  it('creates the ₹599 Premium plan once on first start', async () => {
    expect(await ensureDefaultPlan()).toBe(true);
    expect(await ensureDefaultPlan()).toBe(false);
    const agent = await signUpUser(app, 'agent');
    const mine = (await agent.get('/api/v1/me/plans')).body.data;
    expect(mine.plans).toHaveLength(1);
    expect(mine.plans[0]).toMatchObject({
      name: 'Premium',
      price: 599,
      durationDays: 30,
      listingLimit: 25,
      leadLimit: 0,
      featuredListings: 0,
    });
    expect(mine.featureAddons).toEqual([
      { days: 7, price: 49, label: '7 days' },
      { days: 30, price: 99, label: '1 month' },
    ]);
    // A plan switched off disappears from the website.
    await boss.patch(`/api/v1/admin/plans/${mine.plans[0].id}`, { active: false });
    expect((await agent.get('/api/v1/me/plans')).body.data.plans).toHaveLength(0);
  });

  it('hides leads past the free 10 a month until the poster takes a plan', async () => {
    await ensureDefaultPlan();
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    for (let i = 0; i < 12; i++) {
      const r = await request(app)
        .post('/api/v1/enquiries')
        .send(enquiry({ propertyId: id, phone: `98291${String(10000 + i)}`, name: `Buyer ${i}` }));
      expect(r.status).toBe(201);
    }
    const leads = (await agent.get('/api/v1/me/leads?limit=50')).body.data;
    expect(leads).toHaveLength(12);
    const locked = leads.filter((l: { locked: boolean }) => l.locked);
    expect(locked).toHaveLength(2);
    expect(locked[0]).toMatchObject({ name: 'Hidden lead', phone: '', email: null, message: '' });
    expect(JSON.stringify(locked)).not.toContain('98291');
    const usage = (await agent.get('/api/v1/me/dashboard')).body.data.usage;
    expect(usage.leads).toMatchObject({ used: 10, limit: 10, locked: 2 });

    const plan = (await agent.get('/api/v1/me/plans')).body.data.plans[0];
    await boss.post('/api/v1/admin/payments/manual', {
      userId: agent.user.id,
      planId: plan.id,
      amount: 599,
    });
    const after = (await agent.get('/api/v1/me/leads?limit=50')).body.data;
    expect(after.filter((l: { locked: boolean }) => l.locked)).toHaveLength(0);
    const u = (await agent.get('/api/v1/me/dashboard')).body.data.usage;
    expect(u.leads).toMatchObject({ limit: null, locked: 0 });
    // Premium badge shows on the listing.
    const slug = (await agent.get(`/api/v1/me/properties/${id}`)).body.data.slug;
    expect(
      (await request(app).get(`/api/v1/properties/${slug}`)).body.data.property.poster.premium,
    ).toBe(true);
  });

  it('features a live listing for 7 days on a ₹49 payment, which is not a subscription', async () => {
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    // Not live yet: cannot be featured.
    expect(
      (await boss.post('/api/v1/admin/payments/manual-feature', { propertyId: id, days: 7 }))
        .status,
    ).toBe(400);
    expect(
      (await agent.post(`/api/v1/me/properties/${id}/feature-checkout`, { days: 7 })).status,
    ).toBe(503);
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    expect(
      (await agent.post(`/api/v1/me/properties/${id}/feature-checkout`, { days: 3 })).status,
    ).toBe(422);
    const paid = await boss.post('/api/v1/admin/payments/manual-feature', {
      propertyId: id,
      days: 7,
      reference: 'Cash',
    });
    expect(paid.status).toBe(201);
    expect(paid.body.data).toMatchObject({ kind: 'featured', amount: 49, status: 'paid' });
    expect(paid.body.data.property.id).toBe(id);
    const p = await Property.findById(id).lean();
    expect(p!.featured).toBe(true);
    const days = (p!.featuredUntil!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    // Another month adds on top of the time left.
    const month = await boss.post('/api/v1/admin/payments/manual-feature', {
      propertyId: id,
      days: 30,
    });
    expect(month.status).toBe(201);
    const p2 = await Property.findById(id).lean();
    expect((p2!.featuredUntil!.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(36.9);
    const dash = (await agent.get('/api/v1/me/dashboard')).body.data;
    expect(dash.subscription).toBeNull();
    expect(dash.usage.premium).toBe(false);
  });

  it('counts daily listing views for the poster dashboard chart', async () => {
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    for (let i = 0; i < 2; i++) {
      expect((await request(app).post(`/api/v1/properties/${id}/view`)).status).toBe(200);
    }
    const perf = (await agent.get('/api/v1/me/dashboard')).body.data.performance;
    expect(perf.days).toHaveLength(14);
    expect(perf.views).toHaveLength(14);
    expect(perf.views[13]).toBe(2);
    expect(perf.views30).toBe(2);
    expect(perf.viewsPrev30).toBe(0);
    expect(perf.leads30).toBe(0);
    // Another poster sees none of these views.
    const other = await signUpUser(app, 'agent');
    expect((await other.get('/api/v1/me/dashboard')).body.data.performance.views30).toBe(0);
  });

  it('lists only matching active plans to users and refuses checkout when online payment is off', async () => {
    await boss.post('/api/v1/admin/plans', {
      name: 'Agent Pro',
      price: 4999,
      durationDays: 90,
      listingLimit: 500,
      roles: ['agent'],
    });
    const owner = await signUpUser(app);
    expect((await owner.get('/api/v1/me/plans')).body.data.plans).toHaveLength(0);
    const agent = await signUpUser(app, 'agent');
    const mine = (await agent.get('/api/v1/me/plans')).body.data;
    expect(mine.plans).toHaveLength(1);
    expect(mine.onlineEnabled).toBe(false);
    const co = await agent.post(`/api/v1/me/plans/${mine.plans[0].id}/checkout`);
    expect(co.status).toBe(503);
    expect(await Payment.countDocuments()).toBe(0);
  });

  it('rejects a forged payment signature', () => {
    expect(razorpaySignatureValid('order_1', 'pay_1', 'a'.repeat(64))).toBe(false);
  });
});

describe('alert settings', () => {
  it('saves alert recipients and reports which channels are set up', async () => {
    const res = await boss.patch('/api/v1/admin/alerts', {
      emails: ['sales@example.test'],
      whatsappNumbers: ['+919521750202'],
      events: { signup: false },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.events).toMatchObject({ signup: false, lead: true });
    expect(res.body.data.channels).toEqual({ email: false, whatsapp: false });
    const bad = await boss.patch('/api/v1/admin/alerts', { whatsappNumbers: ['9521750202'] });
    expect(bad.status).toBe(422);
  });
});
