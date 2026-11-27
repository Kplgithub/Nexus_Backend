import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

// Online payment on, with a webhook secret. Must be set before the app (and env) load.
vi.hoisted(() => {
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_test';
});

import {
  createAdmin,
  mockRazorpay,
  resetDb,
  seedJaipur,
  signIn,
  signUpUser,
  startDb,
  stopDb,
  userListing,
  ADMIN,
} from './helpers.js';
import { Autopay, Payment, Plan } from '../src/models/admin-panel.models.js';
import { User } from '../src/models/user.model.js';
import { autopayCycles, razorpayPeriod } from '../src/services/billing.service.js';

let app: Express;
let boss: Awaited<ReturnType<typeof signIn>>;

const DAY = 86_400_000;
const subSig = (paymentId: string, subscriptionId: string) =>
  crypto
    .createHmac('sha256', 'rzp_test_secret')
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');

function hook(body: unknown) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set(
      'X-Razorpay-Signature',
      crypto.createHmac('sha256', 'whsec_test').update(raw).digest('hex'),
    )
    .send(raw);
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const charged = (subId: string, payId: string, paise = 99_900, extra: object = {}) => ({
  event: 'subscription.charged',
  payload: {
    subscription: {
      entity: { id: subId, status: 'active', charge_at: unix(new Date(Date.now() + 30 * DAY)) },
    },
    payment: {
      entity: {
        id: payId,
        order_id: `order_${payId}`,
        amount: paise,
        currency: 'INR',
        status: 'captured',
        method: 'upi',
        vpa: 'kapil@okhdfc',
        ...extra,
      },
    },
  },
});

const subEvent = (event: string, subId: string) => ({
  event,
  payload: { subscription: { entity: { id: subId, status: event.split('.')[1] } } },
});

/** An agent who opened the auto-renew checkout for a ₹999 / 30 day plan. */
async function startAutopay(subId = 'sub_1') {
  await boss.post('/api/v1/admin/plans', {
    name: 'Premium',
    price: 999,
    durationDays: 30,
    listingLimit: 50,
    roles: ['agent'],
  });
  const agent = await signUpUser(app, 'agent');
  const plan = (await agent.get('/api/v1/me/plans')).body.data.plans.find(
    (p: { price: number }) => p.price === 999,
  );
  const calls = mockRazorpay({
    '/customers': { id: 'cust_9' },
    '/plans': { id: 'plan_rzp_1' },
    '/subscriptions': { id: subId, status: 'created' },
  });
  const co = await agent.post(`/api/v1/me/plans/${plan.id}/autopay`);
  expect(co.status).toBe(200);
  return { agent, plan, co: co.body.data, calls };
}

beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
  await createAdmin();
  boss = await signIn(app, ADMIN.email);
});

describe('auto-renew (card mandate / UPI Autopay)', () => {
  it('picks a Razorpay period that repeats every plan length', () => {
    expect(razorpayPeriod(30)).toEqual({ period: 'daily', interval: 30 });
    expect(razorpayPeriod(365)).toEqual({ period: 'yearly', interval: 1 });
    expect(autopayCycles(30)).toBe(100);
    expect(autopayCycles(365)).toBe(10);
  });

  it('opens checkout on a subscription tied to the user’s Razorpay customer', async () => {
    const { co, calls, plan } = await startAutopay();
    expect(co).toMatchObject({
      subscriptionId: 'sub_1',
      customerId: 'cust_9',
      keyId: 'rzp_test_key',
      amount: 99_900,
    });
    const planCall = calls.find((c) => c.path === '/plans')!;
    expect(planCall.body).toMatchObject({
      period: 'daily',
      interval: 30,
      item: { amount: 99_900, currency: 'INR' },
    });
    const subCall = calls.find((c) => c.path === '/subscriptions')!;
    expect(subCall.body).toMatchObject({
      plan_id: 'plan_rzp_1',
      customer_id: 'cust_9',
      customer_notify: 1,
    });
    expect((await Plan.findById(plan.id).lean())!.razorpayPlan).toMatchObject({
      id: 'plan_rzp_1',
      price: 999,
    });
    expect(await User.exists({ razorpayCustomerId: 'cust_9' })).toBeTruthy();
    expect((await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!.status).toBe('created');
  });

  it('reuses the Razorpay plan, and makes a new one when admin changes the price', async () => {
    const { agent, plan, calls } = await startAutopay();
    await Autopay.updateMany({}, { $set: { status: 'cancelled' } });
    await agent.post(`/api/v1/me/plans/${plan.id}/autopay`);
    expect(calls.filter((c) => c.path === '/plans')).toHaveLength(1);
    expect(calls.filter((c) => c.path === '/customers')).toHaveLength(1);

    await Autopay.updateMany({}, { $set: { status: 'cancelled' } });
    await boss.patch(`/api/v1/admin/plans/${plan.id}`, { price: 1199 });
    await agent.post(`/api/v1/me/plans/${plan.id}/autopay`);
    const planCalls = calls.filter((c) => c.path === '/plans');
    expect(planCalls).toHaveLength(2);
    expect(planCalls[1]!.body).toMatchObject({ item: { amount: 119_900 } });
  });

  it('turns the plan on from the browser verify and books the payment once', async () => {
    const { agent } = await startAutopay();
    mockRazorpay({
      '/payments/pay_a1': {
        id: 'pay_a1',
        order_id: 'order_a1',
        amount: 99_900,
        currency: 'INR',
        status: 'captured',
        method: 'card',
        card: { network: 'Visa', last4: '4242' },
      },
      '/subscriptions/sub_1': {
        id: 'sub_1',
        status: 'active',
        charge_at: unix(new Date(Date.now() + 30 * DAY)),
      },
    });
    const bad = await agent.post('/api/v1/me/autopay/verify', {
      subscriptionId: 'sub_1',
      paymentId: 'pay_a1',
      signature: 'a'.repeat(64),
    });
    expect(bad.status).toBe(400);

    const v = await agent.post('/api/v1/me/autopay/verify', {
      subscriptionId: 'sub_1',
      paymentId: 'pay_a1',
      signature: subSig('pay_a1', 'sub_1'),
    });
    expect(v.status).toBe(200);
    expect(v.body.data.autopay).toMatchObject({
      status: 'active',
      method: 'card',
      methodLabel: 'Visa •••• 4242',
    });
    expect(v.body.data.autopay.nextChargeAt).toBeTruthy();

    // The webhook for the same debit (charged + captured) changes nothing.
    const h1 = await hook(charged('sub_1', 'pay_a1', 99_900, { order_id: 'order_a1' }));
    expect(h1.body.result).toBe('already_done');
    const h2 = await hook({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_a1',
            order_id: 'order_a1',
            amount: 99_900,
            currency: 'INR',
            status: 'captured',
          },
        },
      },
    });
    expect(h2.body.result).toBe('already_done');

    const paid = await Payment.find({ status: 'paid' }).lean();
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ subscriptionId: 'sub_1', paymentId: 'pay_a1' });
    expect(paid[0]!.invoiceNo).toMatch(/^NX\//);

    const me = (await agent.get('/api/v1/me/plans')).body.data;
    expect(me.subscription).toBeTruthy();
    expect(me.payments[0].autopay).toBe(true);
    expect(me.autopay.status).toBe('active');
  });

  it('books each monthly debit from the webhook and carries the plan on', async () => {
    const { agent } = await startAutopay();
    const first = await hook(charged('sub_1', 'pay_m1'));
    expect(first.body.result).toBe('paid');
    const second = await hook(charged('sub_1', 'pay_m2'));
    expect(second.body.result).toBe('paid');
    const rows = await Payment.find({ status: 'paid' }).sort({ startsAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    // The second month starts when the first ends: no days lost or doubled.
    expect(rows[1]!.startsAt!.getTime()).toBe(rows[0]!.endsAt!.getTime());
    expect(rows[0]!.invoiceNo).not.toBe(rows[1]!.invoiceNo);
    const a = (await agent.get('/api/v1/me/plans')).body.data.autopay;
    expect(a).toMatchObject({ status: 'active', method: 'upi', methodLabel: 'kapil@okhdfc' });

    // A wrong amount is never booked.
    const odd = await hook(charged('sub_1', 'pay_m3', 100));
    expect(odd.body.result).toBe('amount_mismatch');
    expect(await Payment.countDocuments({ status: 'paid' })).toBe(2);
  });

  it('keeps the plan on for 3 days when a debit fails, without giving free days', async () => {
    await startAutopay();
    await hook(charged('sub_1', 'pay_g1'));
    const firstEnd = (await Payment.findOne({ paymentId: 'pay_g1' }).lean())!.endsAt!;
    // Pretend the month is nearly over.
    const nearEnd = new Date(Date.now() + DAY);
    await Payment.updateOne({ paymentId: 'pay_g1' }, { $set: { endsAt: nearEnd } });
    expect(firstEnd.getTime()).toBeGreaterThan(nearEnd.getTime());

    const p = await hook(subEvent('subscription.pending', 'sub_1'));
    expect(p.status).toBe(200);
    const kept = (await Payment.findOne({ paymentId: 'pay_g1' }).lean())!.endsAt!;
    expect(kept.getTime()).toBeGreaterThanOrEqual(nearEnd.getTime() + 3 * DAY - 1000);
    expect((await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!.status).toBe('pending');

    // The retry goes through: the new month starts at the old end, not after the grace.
    await hook(charged('sub_1', 'pay_g2'));
    const next = (await Payment.findOne({ paymentId: 'pay_g2' }).lean())!;
    expect(next.startsAt!.getTime()).toBe(nearEnd.getTime());
    const a = (await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!;
    expect(a.status).toBe('active');
    expect(a.graceFrom).toBeNull();
  });

  it('lets the user turn auto-renew off, and Razorpay is told', async () => {
    const { agent } = await startAutopay();
    await hook(charged('sub_1', 'pay_c1'));
    const twice = await agent.post(
      '/api/v1/me/plans/' + (await Plan.findOne({ price: 999 }))!._id + '/autopay',
    );
    expect(twice.status).toBe(400);

    const calls = mockRazorpay({
      '/subscriptions/sub_1/cancel': { id: 'sub_1', status: 'cancelled' },
    });
    const off = await agent.post('/api/v1/me/autopay/cancel');
    expect(off.status).toBe(200);
    expect(off.body.data).toBeNull();
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/subscriptions/sub_1/cancel' });
    expect((await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!.status).toBe('cancelled');
    // The paid month stays.
    expect((await agent.get('/api/v1/me/plans')).body.data.subscription).toBeTruthy();

    // A late "activated" webhook does not switch it back on.
    await hook(subEvent('subscription.activated', 'sub_1'));
    expect((await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!.status).toBe('cancelled');
    expect((await agent.post('/api/v1/me/autopay/cancel')).status).toBe(400);
  });

  it('lets a Super Admin stop auto-renew from the payment', async () => {
    await startAutopay();
    await hook(charged('sub_1', 'pay_s1'));
    const row = (await Payment.findOne({ paymentId: 'pay_s1' }).lean())!;
    // Razorpay already cancelled it on its side: still off here.
    mockRazorpay(
      { '/subscriptions/sub_1/cancel': { error: 'already cancelled' } },
      {
        '/subscriptions/sub_1/cancel': 400,
      },
    );
    const res = await boss.post(`/api/v1/admin/payments/${row._id}/stop-autopay`);
    expect(res.status).toBe(200);
    expect(res.body.data.autopay).toBe(true);
    expect((await Autopay.findOne({ subscriptionId: 'sub_1' }).lean())!.status).toBe('cancelled');
  });

  it('offers saved cards on Featured checkout through the customer', async () => {
    await seedJaipur();
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    mockRazorpay({ '/orders': { id: 'order_f1' }, '/customers': { id: 'cust_f' } });
    const co = await agent.post(`/api/v1/me/properties/${id}/feature-checkout`, { days: 7 });
    expect(co.status).toBe(200);
    expect(co.body.data.customerId).toBe('cust_f');
  });

  it('still lets people pay when Razorpay customers fail', async () => {
    await seedJaipur();
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    mockRazorpay(
      { '/orders': { id: 'order_f2' }, '/customers': { error: 'x' } },
      { '/customers': 500 },
    );
    const co = await agent.post(`/api/v1/me/properties/${id}/feature-checkout`, { days: 7 });
    expect(co.status).toBe(200);
    expect(co.body.data.customerId).toBeNull();
  });
});
