import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import {
  ADMIN,
  createAdmin,
  resetDb,
  seedJaipur,
  signIn,
  signUpUser,
  startDb,
  stopDb,
} from './helpers.js';
import { AdminNotification } from '../src/models/admin-panel.models.js';

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

describe('help & support tickets', () => {
  it('lets every kind of user raise a request with a topic, text or both', async () => {
    const seeker = await signUpUser(app, 'seeker');
    const owner = await signUpUser(app, 'individual');
    const agent = await signUpUser(app, 'agent');
    const builder = await signUpUser(app, 'builder');

    const a = await seeker.post('/api/v1/me/support', { topic: 'account' });
    expect(a.status).toBe(201);
    expect(a.body.data.ticketId).toMatch(/^NX-S-\d{4}-\d{5}$/);
    expect(a.body.data.subject).toBe('Login / account');
    expect(a.body.data.status).toBe('open');

    const b = await owner.post('/api/v1/me/support', { message: 'How do I add more photos?' });
    expect(b.status).toBe(201);
    expect(b.body.data.topic).toBeNull();
    expect(b.body.data.subject).toBe('How do I add more photos?');

    expect(
      (
        await agent.post('/api/v1/me/support', {
          topic: 'payment',
          message: 'Paid but plan is Free',
        })
      ).status,
    ).toBe(201);
    expect((await builder.post('/api/v1/me/support', { topic: 'leads' })).status).toBe(201);

    // Neither a topic nor text: refused.
    expect((await seeker.post('/api/v1/me/support', { message: 'hi' })).status).toBe(422);

    // Users only see their own requests.
    const mine = await seeker.get('/api/v1/me/support');
    expect(mine.body.data.items).toHaveLength(1);
    expect((await owner.get(`/api/v1/me/support/${a.body.data.id}`)).status).toBe(404);

    // The team is told on the bell.
    expect(await AdminNotification.countDocuments({ kind: 'support' })).toBeGreaterThanOrEqual(4);
  });

  it('shows admins tickets by role and status with counts, and threads replies', async () => {
    const seeker = await signUpUser(app, 'seeker');
    const agent = await signUpUser(app, 'agent');
    await seeker.post('/api/v1/me/support', {
      topic: 'report',
      message: 'Owner asked for token money',
    });
    const t = (await agent.post('/api/v1/me/support', { topic: 'payment' })).body.data;

    const all = await boss.get('/api/v1/admin/support');
    expect(all.status).toBe(200);
    expect(all.body.data.items).toHaveLength(2);
    expect(all.body.data.items[0].user.phone).toMatch(/^\+91/);
    expect(all.body.data.counts.roles).toMatchObject({ all: 2, seeker: 1, agent: 1, builder: 0 });
    expect(all.body.data.counts.statuses).toMatchObject({ all: 2, open: 2, resolved: 0 });

    const agents = await boss.get('/api/v1/admin/support?role=agent');
    expect(agents.body.data.items.map((i: { id: string }) => i.id)).toEqual([t.id]);

    expect((await boss.get('/api/v1/admin/badges')).body.data.support).toBe(2);

    // Opening marks it read for the team.
    const open = await boss.get(`/api/v1/admin/support/${t.id}`);
    expect(open.body.data.unread).toBe(false);
    expect(open.body.data.userInfo.email).toContain('@example.test');

    // A reply moves it to in progress and lights up the user's side.
    const r = await boss.post(`/api/v1/admin/support/${t.id}/reply`, {
      message: 'We found your payment, the plan is active in 15 minutes.',
    });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('in-progress');
    expect(r.body.data.messages.at(-1)).toMatchObject({ from: 'admin' });

    expect((await agent.get('/api/v1/me/support/unread')).body.data.unread).toBe(1);
    const seen = await agent.get(`/api/v1/me/support/${t.id}`);
    expect(seen.body.data.messages).toHaveLength(2);
    expect(seen.body.data.user.phone).toBe('');
    expect((await agent.get('/api/v1/me/support/unread')).body.data.unread).toBe(0);

    // Resolve, then the user replies: it opens again.
    expect(
      (await boss.post(`/api/v1/admin/support/${t.id}/reply`, { status: 'resolved' })).body.data
        .status,
    ).toBe('resolved');
    const again = await agent.post(`/api/v1/me/support/${t.id}/reply`, { message: 'Still Free' });
    expect(again.body.data.status).toBe('open');

    const resolved = await boss.get('/api/v1/admin/support?status=resolved');
    expect(resolved.body.data.items).toHaveLength(0);
    expect((await boss.get('/api/v1/admin/support?q=token')).body.data.items).toHaveLength(1);
    expect((await boss.post(`/api/v1/admin/support/${t.id}/reply`, {})).status).toBe(422);
  });

  it('keeps support for signed-in users and team members only', async () => {
    const seeker = await signUpUser(app, 'seeker');
    const t = (await seeker.post('/api/v1/me/support', { topic: 'other' })).body.data;
    const req = (await import('supertest')).default;
    expect((await req(app).get('/api/v1/me/support')).status).toBe(401);
    expect((await req(app).get(`/api/v1/admin/support/${t.id}`)).status).toBe(401);
    expect(ADMIN.email).toBeTruthy();
  });
});
