import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { flushWebsiteRefresh } from '../src/lib/web-revalidate.js';
import { Project } from '../src/models/project.model.js';
import { Property } from '../src/models/property.model.js';
import { User } from '../src/models/user.model.js';
import { startDb, stopDb } from './helpers.js';

let server: http.Server;
let calls: { tags: string[]; secret?: string }[] = [];

beforeAll(async () => {
  await startDb();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({
        ...(JSON.parse(body) as { tags: string[] }),
        secret: req.headers['x-revalidate-secret'] as string | undefined,
      });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  (env as { REVALIDATE_URL?: string }).REVALIDATE_URL =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/revalidate`;
  (env as { REVALIDATE_SECRET?: string }).REVALIDATE_SECRET = 'test-secret';
});

afterAll(async () => {
  (env as { REVALIDATE_URL?: string }).REVALIDATE_URL = undefined;
  (env as { REVALIDATE_SECRET?: string }).REVALIDATE_SECRET = undefined;
  server.close();
  await stopDb();
});

beforeEach(async () => {
  await flushWebsiteRefresh();
  calls = [];
});

describe('website cache refresh', () => {
  it('asks the website to drop cached listings when listings are removed or changed', async () => {
    await Property.deleteMany({ isDemo: true });
    await Property.updateMany({}, { $set: { status: 'archived' } });
    await flushWebsiteRefresh();
    expect(calls).toHaveLength(1); // batched into one request
    expect(calls[0]!.tags.sort()).toEqual(['locations', 'properties']);
    expect(calls[0]!.secret).toBe('test-secret');
  });

  it('refreshes projects and poster profiles when they are removed', async () => {
    await Project.deleteMany({ isDemo: true });
    await User.deleteMany({ isDemo: true });
    await flushWebsiteRefresh();
    expect(calls.flatMap((c) => c.tags).sort()).toEqual(['profiles', 'projects', 'properties']);
  });

  it('does not refresh for a view counter bump or ordinary user updates', async () => {
    await Property.updateOne({}, { $inc: { views: 1 } });
    await User.updateMany({}, { $set: { name: 'x' } });
    await flushWebsiteRefresh();
    expect(calls).toHaveLength(0);
  });
});
