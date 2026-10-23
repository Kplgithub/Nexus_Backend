import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { ADMIN, createAdmin, resetDb, signIn, startDb, stopDb } from './helpers.js';

let app: Express;
beforeAll(async () => {
  app = await startDb();
});
afterAll(stopDb);
beforeEach(async () => {
  await resetDb();
  await createAdmin();
});

describe('health', () => {
  it('reports the database as up', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.db).toBe('up');
  });
});

describe('admin auth', () => {
  it('rejects wrong passwords without revealing whether the email exists', async () => {
    const a = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN.email, password: 'wrong' });
    const b = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'nobody@example.test', password: 'wrong' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('sets an httpOnly session cookie and a readable CSRF cookie', async () => {
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(res.status).toBe(200);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('nexus_session='));
    const csrf = cookies.find((c) => c.startsWith('nexus_csrf='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
  });

  it('blocks admin routes without a session', async () => {
    expect((await request(app).get('/api/v1/admin/dashboard')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/enquiries')).status).toBe(401);
  });

  it('requires the CSRF header on writes', async () => {
    const s = await signIn(app);
    const res = await s.agent
      .post('/api/v1/admin/faqs')
      .send({ question: 'Test question?', answer: 'Test answer.' });
    expect(res.status).toBe(403);
    const ok = await s.post('/api/v1/admin/faqs', {
      question: 'Test question?',
      answer: 'Test answer.',
    });
    expect(ok.status).toBe(201);
  });

  it('rejects writes from foreign origins', async () => {
    const s = await signIn(app);
    const res = await s.agent
      .post('/api/v1/admin/faqs')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', s.csrf)
      .send({ question: 'Test question?', answer: 'Test answer.' });
    expect(res.status).toBe(403);
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post('/api/v1/admin/auth/login')
        .send({ email: ADMIN.email, password: 'bad' });
    }
    const res = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });
    expect(res.status).toBe(423);
  });

  it('revokes sessions after logout-all', async () => {
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: ADMIN.email, password: ADMIN.password });
    const cookie = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    expect((await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie)).status).toBe(
      200,
    );
    const s = await signIn(app);
    expect((await s.post('/api/v1/admin/auth/logout-all')).status).toBe(200);
    // The earlier session's token is now stale.
    expect((await request(app).get('/api/v1/admin/dashboard').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('enforces role hierarchy', async () => {
    await createAdmin('editor', 'editor@example.test');
    const editor = await signIn(app, 'editor@example.test');
    expect((await editor.patch('/api/v1/admin/settings', { businessHours: '10–7' })).status).toBe(
      403,
    );
    expect((await editor.get('/api/v1/admin/enquiries/export.csv')).status).toBe(403);
  });

  it('does not expose stack traces', async () => {
    const res = await request(app)
      .post('/api/v1/enquiries')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts|node_modules/);
  });
});
