import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { Admin, City } from '../src/models/misc.models.js';
import { hashPassword } from '../src/services/auth.service.js';
import { clearSettingsCache } from '../src/services/settings.service.js';

let mongo: MongoMemoryServer | null = null;

export async function startDb(): Promise<Express> {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  return createApp();
}

export async function stopDb() {
  await mongoose.disconnect();
  await mongo?.stop();
  mongo = null;
}

export async function resetDb() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  clearSettingsCache();
}

export const ADMIN = {
  email: 'owner@example.test',
  password: 'Correct-Horse-9-Battery',
  name: 'Test Owner',
};

export async function createAdmin(
  role: 'owner' | 'admin' | 'editor' = 'owner',
  email = ADMIN.email,
) {
  return Admin.create({
    email,
    name: ADMIN.name,
    role,
    passwordHash: await hashPassword(ADMIN.password),
  });
}

export async function seedJaipur() {
  return City.create({
    name: 'Jaipur',
    slug: 'jaipur',
    state: 'Rajasthan',
    localities: [
      { name: 'Vaishali Nagar', slug: 'vaishali-nagar', intro: 'Test intro' },
      { name: 'C-Scheme', slug: 'c-scheme' },
      { name: 'Malviya Nagar', slug: 'malviya-nagar' },
    ],
  });
}

/** Supertest agent that is signed in and sends the CSRF header automatically. */
export async function signIn(app: Express, email = ADMIN.email) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/admin/auth/login')
    .send({ email, password: ADMIN.password });
  if (res.status !== 200)
    throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf: string = res.body.data.csrfToken;
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('X-CSRF-Token', csrf).send(body),
    patch: (url: string, body?: object) => agent.patch(url).set('X-CSRF-Token', csrf).send(body),
    del: (url: string) => agent.delete(url).set('X-CSRF-Token', csrf),
  };
}

export const IMG = {
  url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg',
  publicId: 'demo/sample',
  alt: 'Front view',
};

export const residential = (overrides: Record<string, unknown> = {}) => ({
  listingType: 'rent',
  title: '2 BHK apartment near Gandhi Path',
  description:
    'A bright two-bedroom apartment with good ventilation and covered parking for one car.',
  category: 'residential',
  propertyType: 'apartment',
  citySlug: 'jaipur',
  localitySlug: 'vaishali-nagar',
  price: 18000,
  securityDeposit: 36000,
  areaValue: 1050,
  areaUnit: 'sqft',
  bedrooms: 2,
  bathrooms: 2,
  furnishingStatus: 'semi-furnished',
  amenities: ['lift', 'power-backup'],
  parking: 'covered',
  ownerReference: 'Owner: Mr Sharma 98xxxxxx (PRIVATE)',
  internalNotes: 'Owner prefers families (PRIVATE)',
  images: [IMG],
  ...overrides,
});

export const commercial = (overrides: Record<string, unknown> = {}) => ({
  listingType: 'rent',
  title: 'Furnished office near Ashok Marg',
  description:
    'Ready-to-move office with twenty workstations, a cabin, conference room and pantry.',
  category: 'commercial',
  propertyType: 'office',
  citySlug: 'jaipur',
  localitySlug: 'c-scheme',
  price: 85000,
  areaValue: 1600,
  areaUnit: 'sqft',
  furnishingStatus: 'furnished',
  amenities: ['power-backup', 'lift'],
  parking: 'covered',
  images: [IMG],
  ...overrides,
});

let phoneSeq = 0;
/** A unique, valid Indian mobile for each test user. */
export const nextPhone = () => `98290${String(10000 + ++phoneSeq).slice(-5)}`;

/** Signs up a website user and returns a cookie-carrying agent that sends the user CSRF token. */
export async function signUpUser(
  app: Express,
  role: 'individual' | 'agent' | 'builder' = 'individual',
  overrides: Record<string, unknown> = {},
) {
  const agent = request.agent(app);
  const phone = nextPhone();
  const body = {
    role,
    name: role === 'individual' ? 'Asha Verma' : 'Rahul Mehta',
    email: `user${phoneSeq}@example.test`,
    phone,
    password: 'secret123',
    acceptTerms: true,
    ...(role !== 'individual'
      ? { companyName: role === 'agent' ? 'Mehta Realty' : 'Mehta Builders' }
      : {}),
    ...overrides,
  };
  const res = await agent.post('/api/v1/auth/signup').send(body);
  if (res.status !== 201)
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
  const csrf = cookies
    .find((c) => c.startsWith('nexus_ucsrf='))!
    .split(';')[0]!
    .split('=')[1]!;
  return {
    agent,
    csrf,
    user: res.body.data.user as {
      id: string;
      phone: string;
      email: string;
      phoneVerified: boolean;
    },
    devCode: res.body.data.verification?.devCode as string | undefined,
    password: body.password as string,
    get: (url: string) => agent.get(url),
    post: (url: string, b?: object) => agent.post(url).set('X-CSRF-Token', csrf).send(b),
    put: (url: string, b?: object) => agent.put(url).set('X-CSRF-Token', csrf).send(b),
    patch: (url: string, b?: object) => agent.patch(url).set('X-CSRF-Token', csrf).send(b),
    del: (url: string) => agent.delete(url).set('X-CSRF-Token', csrf),
  };
}

/** A listing payload a user would post (no admin-only fields). */
export const userListing = (overrides: Record<string, unknown> = {}) => ({
  listingType: 'sale',
  title: '3 BHK flat for sale near Gandhi Path',
  description:
    'A bright three-bedroom flat with two balconies, modular kitchen and covered parking.',
  category: 'residential',
  propertyType: 'apartment',
  citySlug: 'jaipur',
  localitySlug: 'vaishali-nagar',
  price: 5500000,
  areaValue: 1400,
  areaUnit: 'sqft',
  bedrooms: 3,
  bathrooms: 2,
  furnishingStatus: 'semi-furnished',
  possessionStatus: 'ready',
  images: [IMG],
  ...overrides,
});
