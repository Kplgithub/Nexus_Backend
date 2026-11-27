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
  resetDb,
  seedJaipur,
  signIn,
  signUpUser,
  startDb,
  stopDb,
  userListing,
  ADMIN,
  mockRazorpay,
} from './helpers.js';
import { Payment } from '../src/models/admin-panel.models.js';
import { Property } from '../src/models/property.model.js';

let app: Express;
let boss: Awaited<ReturnType<typeof signIn>>;
let orderSeq = 0;

const sign = (raw: string, secret = 'whsec_test') =>
  crypto.createHmac('sha256', secret).update(raw).digest('hex');

const checkoutSig = (orderId: string, paymentId: string) =>
  crypto.createHmac('sha256', 'rzp_test_secret').update(`${orderId}|${paymentId}`).digest('hex');

function event(
  kind: string,
  orderId: string,
  paymentId: string,
  paise: number,
  status = 'captured',
) {
  const payment = {
    entity: { id: paymentId, order_id: orderId, amount: paise, currency: 'INR', status },
  };
  return kind === 'order.paid'
    ? { event: kind, payload: { payment, order: { entity: { id: orderId, amount_paid: paise } } } }
    : { event: kind, payload: { payment } };
}

function hook(body: unknown, sig?: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/api/v1/webhooks/razorpay')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig ?? sign(raw))
    .set('X-Razorpay-Event-Id', `evt_${Math.random()}`)
    .send(raw);
}

/** An agent with a ₹999 plan checkout started (Razorpay order creation mocked). */
async function startPlanCheckout() {
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
  const orderId = `order_${++orderSeq}`;
  mockRazorpay({ '/orders': { id: orderId }, '/customers': { id: 'cust_1' } });
  const co = await agent.post(`/api/v1/me/plans/${plan.id}/checkout`);
  expect(co.status).toBe(200);
  expect(co.body.data).toMatchObject({ orderId, keyId: 'rzp_test_key', amount: 99_900 });
  return { agent, orderId };
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

describe('Razorpay webhook', () => {
  it('turns a plan on from payment.captured when the buyer closed the tab', async () => {
    const { agent, orderId } = await startPlanCheckout();
    expect((await Payment.findOne({ orderId }).lean())!.status).toBe('created');

    const res = await hook(event('payment.captured', orderId, 'pay_1', 99_900));
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('paid');
    const p = (await Payment.findOne({ orderId }).lean())!;
    expect(p).toMatchObject({ status: 'paid', paymentId: 'pay_1' });
    expect(p.invoiceNo).toMatch(/^NX\//);
    expect(p.endsAt).toBeTruthy();
    expect((await agent.get('/api/v1/me/dashboard')).body.data.subscription).toBeTruthy();

    // Razorpay retries and order.paid both arrive later: nothing changes twice.
    const again = await hook(event('order.paid', orderId, 'pay_1', 99_900));
    expect(again.body.result).toBe('already_done');
    const p2 = (await Payment.findOne({ orderId }).lean())!;
    expect(p2.endsAt!.getTime()).toBe(p.endsAt!.getTime());
    expect(p2.invoiceNo).toBe(p.invoiceNo);

    // The browser's own confirmation after that still answers "paid".
    const v = await agent.post('/api/v1/me/payments/verify', {
      orderId,
      paymentId: 'pay_1',
      signature: checkoutSig(orderId, 'pay_1'),
    });
    expect(v.status).toBe(200);
    expect(v.body.data.status).toBe('paid');
  });

  it('pays once when the browser and the webhook arrive together', async () => {
    const { agent, orderId } = await startPlanCheckout();
    const [v, h] = await Promise.all([
      agent.post('/api/v1/me/payments/verify', {
        orderId,
        paymentId: 'pay_2',
        signature: checkoutSig(orderId, 'pay_2'),
      }),
      hook(event('order.paid', orderId, 'pay_2', 99_900)),
    ]);
    expect(v.status).toBe(200);
    expect(h.status).toBe(200);
    const paid = await Payment.find({ status: 'paid' }).lean();
    expect(paid).toHaveLength(1);
    const days = (paid[0]!.endsAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('pays an order the browser wrongly marked failed', async () => {
    const { agent, orderId } = await startPlanCheckout();
    const bad = await agent.post('/api/v1/me/payments/verify', {
      orderId,
      paymentId: 'pay_3',
      signature: 'f'.repeat(64),
    });
    expect(bad.status).toBe(400);
    expect((await Payment.findOne({ orderId }).lean())!.status).toBe('failed');
    expect((await hook(event('payment.captured', orderId, 'pay_3', 99_900))).body.result).toBe(
      'paid',
    );
  });

  it('features a listing from the webhook', async () => {
    await seedJaipur();
    const agent = await signUpUser(app, 'agent');
    const { id } = (await agent.post('/api/v1/me/properties', userListing({ status: 'pending' })))
      .body.data;
    await boss.post(`/api/v1/admin/properties/${id}/status`, { status: 'published' });
    mockRazorpay({ '/orders': { id: 'order_feat' }, '/customers': { id: 'cust_1' } });
    const co = await agent.post(`/api/v1/me/properties/${id}/feature-checkout`, { days: 7 });
    expect(co.status).toBe(200);
    const res = await hook(event('payment.captured', 'order_feat', 'pay_f', co.body.data.amount));
    expect(res.body.result).toBe('paid');
    expect((await Property.findById(id).lean())!.featured).toBe(true);
  });

  it('refuses a bad signature and does not pay', async () => {
    const { orderId } = await startPlanCheckout();
    const body = event('payment.captured', orderId, 'pay_x', 99_900);
    expect((await hook(body, sign(JSON.stringify(body), 'wrong'))).status).toBe(400);
    expect((await hook(body, 'nope')).status).toBe(400);
    const noSig = await request(app)
      .post('/api/v1/webhooks/razorpay')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(body));
    expect(noSig.status).toBe(400);
    expect((await Payment.findOne({ orderId }).lean())!.status).toBe('created');
  });

  it('does not pay when the amount is wrong, the payment is not captured or the order is unknown', async () => {
    const { orderId } = await startPlanCheckout();
    expect((await hook(event('payment.captured', orderId, 'pay_y', 100))).body.result).toBe(
      'amount_mismatch',
    );
    expect(
      (await hook(event('payment.captured', orderId, 'pay_y', 99_900, 'authorized'))).body.result,
    ).toBe('not_captured');
    expect((await hook(event('payment.failed', orderId, 'pay_y', 99_900))).body.result).toBe(
      'ignored_event',
    );
    expect(
      (await hook(event('payment.captured', 'order_other_site', 'pay_z', 99_900))).body.result,
    ).toBe('unknown_order');
    expect((await Payment.findOne({ orderId }).lean())!.status).toBe('created');
  });

  it('reports on the health check that payments and the webhook are set up', async () => {
    const h = await request(app).get('/api/v1/health');
    expect(h.body.data).toMatchObject({ onlinePayments: true, paymentWebhook: true });
  });
});
