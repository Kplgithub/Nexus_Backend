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
  projectSearchSchema,
  reportCreateSchema,
  blogSearchSchema,
  blogReadSchema,
  type CategoryInfo,
} from '@nexus/shared';
import { z } from 'zod';
import { env } from '../config/env.js';
import { parseBody, parseId, parseQuery } from '../middleware/validate.js';
import { limiters } from '../middleware/security.js';
import { created, ok, paginate } from '../lib/respond.js';
import { notFound } from '../lib/errors.js';
import { hashIp } from '../lib/crypto.js';
import { cached } from '../lib/redis.js';
import { optionalUser } from '../middleware/user-auth.js';
import * as properties from '../services/property.service.js';
import * as locations from '../services/location.service.js';
import * as faqs from '../services/faq.service.js';
import * as projects from '../services/project.service.js';
import * as profiles from '../services/profile.service.js';
import * as reports from '../services/report.service.js';
import * as leads from '../services/enquiry.service.js';
import * as blog from '../services/blog.service.js';
import * as blogAnalytics from '../services/blog-analytics.service.js';
import { getPublicSettings, projectsOn } from '../services/settings.service.js';
import {
  smartSearch,
  smartSearchQuerySchema,
} from '../services/smart-search/smart-search.service.js';

export const publicRouter: RouterType = Router();

const cache = (res: Response, seconds = env.PUBLIC_CACHE_SECONDS) =>
  res.set(
    'Cache-Control',
    `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`,
  );

publicRouter.get('/properties', async (req, res) => {
  const q = parseQuery(propertySearchSchema, req);
  const { items, meta } = await cached('public', `properties:${JSON.stringify(q)}`, 60, () =>
    properties.searchPublic(q),
  );
  cache(res);
  ok(res, items, meta);
});

/** Plain-language search: "2bhk furnished vaishali nagar 15k tak". */
publicRouter.get('/smart-search', limiters.smartSearch, async (req, res) => {
  const q = parseQuery(smartSearchQuerySchema, req);
  res.set('Cache-Control', 'no-store');
  ok(res, await smartSearch(q));
});

publicRouter.get('/properties/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.length > 100) throw notFound('Property not found');
  const result = await cached('public', `property:${slug}`, 60, () =>
    properties.getPublicBySlug(slug),
  );
  cache(res);
  if (result.kind === 'redirect') {
    // The web app turns this into a permanent (308) redirect for crawlers.
    return ok(res, { redirectTo: result.slug });
  }
  // Its site section is switched off: the web app redirects or shows 404 (admin's choice).
  if (result.kind === 'off') return ok(res, { sectionOff: result.section });
  ok(res, { property: result.property, similar: result.similar });
});

publicRouter.post('/properties/:id/view', limiters.view, async (req, res) => {
  await properties.recordView(parseId(req));
  res.set('Cache-Control', 'no-store');
  ok(res, { counted: true });
});

publicRouter.get('/home', async (req, res) => {
  // Optional ?city=<slug>: the home page shows each visitor their own city.
  const raw = String(req.query.city ?? '').toLowerCase();
  const city = raw && SLUG_PATTERN.test(raw) && raw.length <= 60 ? raw : undefined;
  cache(res);
  const data = await cached('public', `home:${city ?? ''}`, 60, async () => {
    const [sections, newProjects] = await Promise.all([
      properties.listHomeSections(city),
      (await projectsOn())
        ? projects.searchProjects({ page: 1, limit: 6, ...(city ? { city } : {}) })
        : { items: [] },
    ]);
    return { ...sections, projects: newProjects.items };
  });
  ok(res, data);
});

/* ---------------- New projects ---------------- */

/** New projects switched off in Admin → Settings → Site sections: no project data goes out. */
async function requireProjects() {
  if (!(await projectsOn())) throw notFound('Project not found');
}

publicRouter.get('/projects', async (req, res) => {
  const q = parseQuery(projectSearchSchema, req);
  if (!(await projectsOn())) return ok(res, [], paginate(q.page, q.limit, 0));
  const { items, meta } = await cached('public', `projects:${JSON.stringify(q)}`, 60, () =>
    projects.searchProjects(q),
  );
  cache(res);
  ok(res, items, meta);
});

publicRouter.get('/projects/options', async (req, res) => {
  const city = String(req.query.city ?? '').toLowerCase();
  if (!SLUG_PATTERN.test(city) || !(await projectsOn())) return ok(res, []);
  cache(res);
  ok(res, await projects.projectOptions(city));
});

publicRouter.get('/projects/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.length > 100) throw notFound('Project not found');
  await requireProjects();
  cache(res);
  ok(res, await projects.getPublicProject(slug));
});

publicRouter.post('/projects/:id/view', limiters.view, async (req, res) => {
  await projects.recordProjectView(parseId(req));
  res.set('Cache-Control', 'no-store');
  ok(res, { counted: true });
});

publicRouter.get('/sitemap/projects', async (_req, res) => {
  cache(res, 300);
  ok(res, (await projectsOn()) ? await projects.sitemapProjects() : []);
});

/* ---------------- Agents and builders ---------------- */

const profileQuery = z.object({
  city: z.string().regex(SLUG_PATTERN).optional().catch(undefined),
  locality: z.string().regex(SLUG_PATTERN).optional().catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(1000).catch(1).default(1),
  limit: z.coerce.number().int().min(1).max(48).catch(24).default(24),
});

for (const [path, role] of [
  ['agents', 'agent'],
  ['builders', 'builder'],
] as const) {
  publicRouter.get(`/${path}`, async (req, res) => {
    const q = parseQuery(profileQuery, req);
    const { items, meta } = await profiles.listProfiles({ ...q, role, q: q.q || undefined });
    cache(res);
    ok(res, items, meta);
  });
  publicRouter.get(`/${path}/:slug`, async (req, res) => {
    const slug = String(req.params.slug).toLowerCase();
    if (!SLUG_PATTERN.test(slug) || slug.length > 100) throw notFound('Profile not found');
    cache(res);
    ok(res, await profiles.getProfile(role, slug));
  });
}

publicRouter.get('/sitemap/profiles', async (_req, res) => {
  cache(res, 300);
  ok(res, await profiles.sitemapProfiles());
});

/* ---------------- Reports ---------------- */

publicRouter.post('/reports', limiters.publicForm, optionalUser, async (req, res) => {
  const input = parseBody(reportCreateSchema, req);
  await reports.createReport(input, { ipHash: hashIp(req.ip) }, req.user);
  res.set('Cache-Control', 'no-store');
  created(res, { received: true });
});

/* ---------------- Blog ---------------- */

publicRouter.get('/blog', async (req, res) => {
  const { items, meta } = await blog.listPublic(parseQuery(blogSearchSchema, req));
  cache(res);
  ok(res, items, meta);
});

publicRouter.get('/blog/:slug', async (req, res) => {
  const slug = String(req.params.slug).toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.length > 100) throw notFound('Article not found');
  const result = await blog.getPublicBySlug(slug);
  cache(res);
  // The web app turns this into a permanent (308) redirect.
  if (result.kind === 'redirect') return ok(res, { redirectTo: result.slug });
  ok(res, { post: result.post, related: result.related });
});

/** Reading beacon from the article page: time spent and how far the reader scrolled. */
publicRouter.post('/blog/:id/read', limiters.view, async (req, res) => {
  const id = parseId(req);
  const input = parseBody(blogReadSchema, req);
  res.set('Cache-Control', 'no-store');
  const ua = req.get('user-agent');
  if (blogAnalytics.isBot(ua)) return ok(res, { counted: false });
  const counted = await blogAnalytics.recordRead(id, input, { userAgent: ua });
  ok(res, { counted });
});

publicRouter.get('/sitemap/blog', async (_req, res) => {
  cache(res, 300);
  ok(res, await blog.sitemapBlog());
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

publicRouter.get('/locations/:city/:locality/insights', async (req, res) => {
  const city = String(req.params.city).toLowerCase();
  const locality = String(req.params.locality).toLowerCase();
  if (!SLUG_PATTERN.test(city) || !SLUG_PATTERN.test(locality))
    throw notFound('Locality not found');
  cache(res);
  ok(res, await locations.getLocalityInsights(city, locality));
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
