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
import { Property } from '../src/models/property.model.js';
import { syncPlanPerks } from '../src/services/billing.service.js';

let app: Express;
let boss: Awaited<ReturnType<typeof signIn>>;

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

const DAY = 86_400_000;

async function liveListing(agent: Awaited<ReturnType<typeof signUpUser>>, title: string) {
  const { id } = (
    await agent.post('/api/v1/me/properties', userListing({ status: 'pending', title }))
  ).body.data;
  await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
  return id as string;
}

const searchSlugs = async () =>
  (await request(app).get('/api/v1/properties?city=jaipur')).body.data as {
    id: string;
    partnerBadge: boolean;
    refreshedAt: string | null;
  }[];

describe('plan perks: search position, Premium Partner badge, auto refresh', () => {
  it('stores the new plan fields and keeps one "Most chosen" plan', async () => {
    const a = await boss.post('/api/v1/admin/plans', {
      name: 'Smart',
      price: 2499,
      mrp: 2997,
      durationDays: 90,
      listingLimit: 25,
      searchRank: 1,
      partnerBadge: true,
      autoRefreshDays: 7,
      recommended: true,
      roles: ['agent', 'builder', 'individual'],
    });
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ mrp: 2997, searchRank: 1, autoRefreshDays: 7 });
    const b = await boss.post('/api/v1/admin/plans', {
      name: 'Pro',
      price: 4499,
      durationDays: 180,
      listingLimit: 50,
      recommended: true,
      roles: ['agent'],
    });
    expect(b.status).toBe(201);
    const plans = (await boss.get('/api/v1/admin/plans')).body.data as {
      name: string;
      recommended: boolean;
      searchRank: number;
    }[];
    expect(plans.filter((p) => p.recommended).map((p) => p.name)).toEqual(['Pro']);

    // A partial update changes only what it sends.
    await boss.patch(`/api/v1/admin/plans/${a.body.data.id}`, { active: false });
    const smart = (await boss.get('/api/v1/admin/plans')).body.data.find(
      (p: { name: string }) => p.name === 'Smart',
    );
    expect(smart).toMatchObject({ active: false, searchRank: 1, partnerBadge: true, mrp: 2997 });

    expect(
      (
        await boss.post('/api/v1/admin/plans', {
          ...a.body.data,
          id: undefined,
          autoRefreshDays: 5,
        })
      ).status,
    ).toBe(422);
  });

  it('puts plan listings above free ones, shows the badge, refreshes, and clears on refund', async () => {
    const plan = (
      await boss.post('/api/v1/admin/plans', {
        name: 'Elite',
        price: 7999,
        durationDays: 180,
        listingLimit: 100,
        searchRank: 3,
        partnerBadge: true,
        autoRefreshDays: 3,
        roles: ['agent'],
      })
    ).body.data;
    const paidAgent = await signUpUser(app, 'agent');
    const freeAgent = await signUpUser(app, 'agent');

    const planned = await liveListing(paidAgent, '2 BHK flat with plan near Gandhi Path');
    // Posted later, so it would come first on date alone.
    const free = await liveListing(freeAgent, '2 BHK flat without plan near Gandhi Path');
    let rows = await searchSlugs();
    expect(rows.map((r) => r.id)).toEqual([free, planned]);

    const paid = await boss.post('/api/v1/admin/payments/manual', {
      userId: paidAgent.user.id,
      planId: plan.id,
      amount: 7999,
    });
    expect(paid.status).toBe(201);
    rows = await searchSlugs();
    expect(rows.map((r) => r.id)).toEqual([planned, free]);
    expect(rows[0]!.partnerBadge).toBe(true);
    expect(rows[1]!.partnerBadge).toBe(false);

    // A listing posted while the plan is on gets the perks at once.
    const second = (
      await paidAgent.post(
        '/api/v1/me/properties',
        userListing({ status: 'pending', title: '3 BHK flat with plan near Gandhi Path' }),
      )
    ).body.data.id;
    expect(await Property.findById(second).select('boostRank partnerBadge').lean()).toMatchObject({
      boostRank: 3,
      partnerBadge: true,
    });

    // Auto refresh: a listing last refreshed 4 days ago moves back to the top.
    const old = new Date(Date.now() - 4 * DAY);
    await Property.updateOne({ _id: planned }, { $set: { refreshedAt: old } });
    await Property.updateOne({ _id: free }, { $set: { refreshedAt: old } });
    await syncPlanPerks();
    const after = await Property.find({ _id: { $in: [planned, free] } })
      .select('refreshedAt')
      .lean();
    const byId = new Map(after.map((p) => [String(p._id), p.refreshedAt!.getTime()]));
    expect(byId.get(planned)!).toBeGreaterThan(Date.now() - 60_000);
    expect(byId.get(free)!).toBe(old.getTime());

    // Refund ends the plan: back to normal position, no badge.
    await boss.post(`/api/v1/admin/payments/${paid.body.data.id}/refund`);
    expect(await Property.findById(planned).select('boostRank partnerBadge').lean()).toMatchObject({
      boostRank: 0,
      partnerBadge: false,
    });
  });

  it('fills refreshedAt for listings published before it existed and clears ended plans', async () => {
    const agent = await signUpUser(app, 'agent');
    const id = await liveListing(agent, '2 BHK flat old listing near Gandhi Path');
    await Property.updateOne(
      { _id: id },
      { $set: { refreshedAt: null, boostRank: 2, partnerBadge: true } },
    );
    await syncPlanPerks();
    const p = await Property.findById(id)
      .select('refreshedAt publishedAt boostRank partnerBadge')
      .lean();
    expect(p!.refreshedAt!.getTime()).toBe(p!.publishedAt!.getTime());
    expect(p).toMatchObject({ boostRank: 0, partnerBadge: false });
  });
});
