import { Router, type Response, type Router as RouterType } from 'express';
import {
  ACTIVE_CATEGORIES,
  CATEGORIES,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  SLUG_PATTERN,
  enquiryCreateSchema,
  FAQ_CATEGORIES,
  INDIAN_STATES,
  propertySearchSchema,
  type CategoryInfo,
} from '@nexus/shared';
import { env } from '../config/env.js';
import { parseBody, parseQuery } from '../middleware/validate.js';
import { limiters } from '../middleware/security.js';
import { created, ok } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import { hashIp } from '../lib/crypto.js';
import { optionalUser } from '../middleware/user-auth.js';
import * as properties from '../services/property.service.js';
import * as locations from '../services/location.service.js';
import * as faqs from '../services/faq.service.js';
import * as leads from '../services/enquiry.service.js';
import { getPublicSettings } from '../services/settings.service.js';

export const publicRouter: RouterType = Router();

const cache = (res: Response, seconds = env.PUBLIC_CACHE_SECONDS) =>
  res.set(
    'Cache-Control',
    `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
  );

publicRouter.get('/properties', async (req, res) => {
  const q = parseQuery(propertySearchSchema, req);
  const { items, meta } = await properties.searchPublic(q);
  cache(res);
  ok(res, items, meta);
});

publicRouter.get('/properties/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.length > 100) throw notFound('Property not found');
  const result = await properties.getPublicBySlug(slug);
  cache(res);
  if (result.kind === 'redirect') {
    // The web app turns this into a permanent (308) redirect for crawlers.
    return ok(res, { redirectTo: result.slug });
  }
  ok(res, { property: result.property, similar: result.similar });
});

publicRouter.get('/home', async (_req, res) => {
  cache(res);
  ok(res, await properties.listHomeSections());
});

publicRouter.get('/sitemap/properties', async (_req, res) => {
  cache(res, 300);
  ok(res, await properties.sitemapEntries());
});

publicRouter.get('/locations', async (_req, res) => {
  cache(res);
  ok(res, await locations.listPublicLocations());
});

publicRouter.get('/locations/:city', async (req, res) => {
  const slug = String(req.params.city).toLowerCase();
  if (!SLUG_PATTERN.test(slug)) throw notFound('City not found');
  cache(res);
  ok(res, await locations.getPublicCity(slug));
});

publicRouter.get('/categories', (_req, res) => {
  const data: CategoryInfo[] = CATEGORIES.map((category) => ({
    category,
    label: category[0]!.toUpperCase() + category.slice(1),
    enabled: ACTIVE_CATEGORIES.includes(category),
    types: PROPERTY_TYPES[category].map((value) => ({ value, label: PROPERTY_TYPE_LABELS[value] })),
  }));
  cache(res, 3600);
  ok(res, data);
});

publicRouter.get('/faqs', async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const allowed: readonly string[] = FAQ_CATEGORIES;
  cache(res);
  ok(
    res,
    await faqs.listPublicFaqs({
      category: category && allowed.includes(category) ? category : undefined,
      home: req.query.home === 'true',
    }),
  );
});

publicRouter.get('/settings', async (_req, res) => {
  cache(res);
  ok(res, await getPublicSettings());
});

publicRouter.get('/states', (_req, res) => {
  cache(res, 3600);
  ok(res, INDIAN_STATES);
});

publicRouter.post('/enquiries', limiters.publicForm, optionalUser, async (req, res) => {
  const input = parseBody(enquiryCreateSchema, req);
  const result = await leads.createEnquiry(
    input,
    { ipHash: hashIp(req.ip), userAgent: req.get('user-agent') },
    req.user,
  );
  res.set('Cache-Control', 'no-store');
  created(res, { leadId: result.leadId, message: 'Thank you. We will contact you shortly.' });
});
