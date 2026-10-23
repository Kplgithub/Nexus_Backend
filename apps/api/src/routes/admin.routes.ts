import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import {
  IMAGE_MAX_BYTES,
  adminEnquiryQuerySchema,
  adminUserQuerySchema,
  adminUserUpdateSchema,
  adminPropertyQuerySchema,
  changePasswordSchema,
  cityCreateSchema,
  cityUpdateSchema,
  enquiryUpdateSchema,
  faqCreateSchema,
  faqUpdateSchema,
  loginSchema,
  propertyCreateSchema,
  propertyStatusChangeSchema,
  propertyUpdateSchema,
  siteSettingsUpdateSchema,
} from '@nexus/shared';
import { clearSession, issueSession, requireAuth, requireRole } from '../middleware/auth.js';
import { limiters } from '../middleware/security.js';
import { onlySentKeys, parseBody, parseId, parseQuery } from '../middleware/validate.js';
import { created, ok } from '../lib/respond.js';
import { badRequest } from '../lib/errors.js';
import * as auth from '../services/auth.service.js';
import * as properties from '../services/property.service.js';
import * as leads from '../services/enquiry.service.js';
import * as locations from '../services/location.service.js';
import * as faqs from '../services/faq.service.js';
import { getSettings, updateSettings } from '../services/settings.service.js';
import { getDashboard } from '../services/dashboard.service.js';
import { storeImage } from '../services/upload.service.js';
import { audit } from '../services/support.service.js';
import * as adminUsers from '../services/admin-users.service.js';

export const adminRouter: RouterType = Router();

// Admin responses contain private data — never cache.
adminRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

/* ---------------- Auth ---------------- */

adminRouter.post('/auth/login', limiters.login, async (req, res) => {
  const { email, password } = parseBody(loginSchema, req);
  const admin = await auth.login(email, password);
  const csrfToken = issueSession(res, admin);
  await audit(
    { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    'login',
    'admin',
    admin.id,
  );
  ok(res, {
    admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role },
    csrfToken,
  });
});

adminRouter.post('/auth/logout', (_req, res) => {
  clearSession(res);
  ok(res, { signedOut: true });
});

// Everything below requires a valid session (and CSRF header on writes).
adminRouter.use(requireAuth);

adminRouter.get('/auth/me', (req, res) => ok(res, { admin: req.admin, csrfToken: req.csrfToken }));

adminRouter.post('/auth/change-password', async (req, res) => {
  const { currentPassword, newPassword } = parseBody(changePasswordSchema, req);
  const updated = await auth.changePassword(req.admin!.id, currentPassword, newPassword);
  const csrfToken = issueSession(res, updated);
  await audit(req.admin, 'change-password', 'admin', req.admin!.id);
  ok(res, { changed: true, csrfToken });
});

adminRouter.post('/auth/logout-all', async (req, res) => {
  await auth.signOutEverywhere(req.admin!.id);
  clearSession(res);
  await audit(req.admin, 'logout-all', 'admin', req.admin!.id);
  ok(res, { signedOut: true });
});

/* ---------------- Dashboard ---------------- */

adminRouter.get('/dashboard', async (_req, res) => ok(res, await getDashboard()));

/* ---------------- Properties ---------------- */

adminRouter.get('/properties', async (req, res) => {
  const { items, meta } = await properties.listAdmin(parseQuery(adminPropertyQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/properties/:id', async (req, res) =>
  ok(res, await properties.getAdmin(parseId(req))),
);

adminRouter.post('/properties', requireRole('editor'), async (req, res) => {
  const input = parseBody(propertyCreateSchema, req);
  const p = await properties.createProperty(input, req.admin!.id);
  await audit(req.admin, 'create', 'property', p.id, p.title);
  created(res, p);
});

adminRouter.patch('/properties/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(propertyUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const p = await properties.updateProperty(id, patch, req.admin!.id);
  await audit(req.admin, 'update', 'property', id, Object.keys(patch).join(', '));
  ok(res, p);
});

adminRouter.post('/properties/:id/status', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const { status, note } = parseBody(propertyStatusChangeSchema, req);
  const p = await properties.changeStatus(id, status, req.admin!.id, note);
  await audit(req.admin, `status:${status}`, 'property', id, p.title);
  ok(res, p);
});

adminRouter.delete('/properties/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const removed = await properties.deleteProperty(id);
  await audit(req.admin, 'delete', 'property', id, removed.title);
  ok(res, { deleted: true });
});

/* ---------------- Uploads ---------------- */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 10, fields: 5 },
});

adminRouter.post(
  '/uploads',
  limiters.upload,
  requireRole('editor'),
  upload.array('files', 10),
  async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) throw badRequest('Choose at least one image');
    // Upload sequentially and report per-file results so one bad file doesn't lose the rest.
    const results: (
      | { ok: true; image: Awaited<ReturnType<typeof storeImage>>; name: string }
      | { ok: false; name: string; error: string }
    )[] = [];
    for (const f of files) {
      try {
        results.push({ ok: true, name: f.originalname, image: await storeImage(f.buffer) });
      } catch (err) {
        results.push({
          ok: false,
          name: f.originalname,
          error: err instanceof Error ? err.message : 'Upload failed',
        });
      }
    }
    await audit(
      req.admin,
      'upload',
      'image',
      undefined,
      `${results.filter((r) => r.ok).length} file(s)`,
    );
    ok(res, results);
  },
);

/* ---------------- Enquiries ---------------- */

adminRouter.get('/enquiries', async (req, res) => {
  const { items, meta } = await leads.listEnquiries(parseQuery(adminEnquiryQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/enquiries/export.csv', requireRole('admin'), async (req, res) => {
  const csv = await leads.exportEnquiriesCsv({
    ...parseQuery(adminEnquiryQuerySchema, req),
    page: 1,
    limit: 100,
  });
  await audit(req.admin, 'export', 'enquiry', undefined, 'CSV export');
  res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set(
      'Content-Disposition',
      `attachment; filename="nexus-enquiries-${new Date().toISOString().slice(0, 10)}.csv"`,
    )
    .send(csv);
});

adminRouter.get('/enquiries/:id', async (req, res) =>
  ok(res, await leads.getEnquiry(parseId(req))),
);

adminRouter.patch('/enquiries/:id', async (req, res) => {
  const id = parseId(req);
  const patch = parseBody(enquiryUpdateSchema, req);
  const e = await leads.updateEnquiry(id, patch, req.admin!.name);
  if (patch.status) await audit(req.admin, `status:${patch.status}`, 'enquiry', id, e.leadId);
  ok(res, e);
});

/* ---------------- Website users ---------------- */

adminRouter.get('/users', async (req, res) => {
  const { items, meta } = await adminUsers.listUsers(parseQuery(adminUserQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/users/:id', async (req, res) => ok(res, await adminUsers.getUser(parseId(req))));

adminRouter.patch('/users/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(adminUserUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const u = await adminUsers.updateUser(id, patch, req.admin!.name);
  await audit(req.admin, 'update', 'user', id, Object.keys(patch).join(', '));
  ok(res, u);
});

/* ---------------- Locations ---------------- */

adminRouter.get('/locations', async (_req, res) => ok(res, await locations.listAllLocations()));

adminRouter.post('/locations', requireRole('admin'), async (req, res) => {
  const c = await locations.createCity(parseBody(cityCreateSchema, req));
  await audit(req.admin, 'create', 'city', c.id, c.name);
  created(res, c);
});

adminRouter.patch('/locations/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(cityUpdateSchema, req), req.body);
  const c = await locations.updateCity(id, patch);
  await audit(req.admin, 'update', 'city', id, c.name);
  ok(res, c);
});

adminRouter.delete('/locations/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  await locations.deleteCity(id);
  await audit(req.admin, 'delete', 'city', id);
  ok(res, { deleted: true });
});

/* ---------------- FAQs ---------------- */

adminRouter.get('/faqs', async (_req, res) => ok(res, await faqs.listAllFaqs()));
adminRouter.post('/faqs', requireRole('editor'), async (req, res) =>
  created(res, await faqs.createFaq(parseBody(faqCreateSchema, req))),
);
adminRouter.patch('/faqs/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  ok(res, await faqs.updateFaq(id, onlySentKeys(parseBody(faqUpdateSchema, req), req.body)));
});
adminRouter.delete('/faqs/:id', requireRole('editor'), async (req, res) => {
  await faqs.deleteFaq(parseId(req));
  ok(res, { deleted: true });
});

/* ---------------- Site settings ---------------- */

adminRouter.get('/settings', async (_req, res) => ok(res, await getSettings()));

adminRouter.patch('/settings', requireRole('admin'), async (req, res) => {
  const patch = onlySentKeys(parseBody(siteSettingsUpdateSchema, req), req.body);
  const s = await updateSettings(patch);
  await audit(req.admin, 'update', 'settings', undefined, Object.keys(patch).join(', '));
  ok(res, s);
});
