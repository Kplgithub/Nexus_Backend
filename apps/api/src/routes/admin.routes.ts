import { z } from 'zod';
import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import {
  IMAGE_MAX_BYTES,
  adminEnquiryQuerySchema,
  adminSupportQuerySchema,
  adminSupportReplySchema,
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
  adminProjectQuerySchema,
  adminProjectUpdateSchema,
  projectStatusChangeSchema,
  adminReportQuerySchema,
  reportUpdateSchema,
  adminBlogQuerySchema,
  blogAnalyticsQuerySchema,
  blogPostCreateSchema,
  blogPostUpdateSchema,
  activityQuerySchema,
  alertSettingsUpdateSchema,
  dashboardChartsQuerySchema,
  featureListingSchema,
  manualFeatureSchema,
  isSuperAdmin,
  leadAssignSchema,
  manualPaymentSchema,
  notificationReadSchema,
  paymentQuerySchema,
  planSchema,
  planUpdateSchema,
  setPasswordSchema,
  setUserPasswordSchema,
  siteVisitCreateSchema,
  siteVisitQuerySchema,
  siteVisitUpdateSchema,
  teamCreateSchema,
  teamUpdateSchema,
  verificationDecisionSchema,
  verificationQuerySchema,
} from '@nexus/shared';
import { getBadges, getCharts } from '../services/charts.service.js';
import * as team from '../services/team.service.js';
import * as visits from '../services/site-visit.service.js';
import * as tickets from '../services/ticket.service.js';
import * as billing from '../services/billing.service.js';
import * as featured from '../services/featured.service.js';
import * as alerts from '../services/notification.service.js';
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
import * as projects from '../services/project.service.js';
import * as reports from '../services/report.service.js';
import * as blog from '../services/blog.service.js';
import * as blogAnalytics from '../services/blog-analytics.service.js';
import { notifyIndexNow } from '../services/indexnow.service.js';
import { importProperties, importTemplateCsv } from '../services/property-import.service.js';
import { searchInsights } from '../services/smart-search/smart-search.service.js';

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

adminRouter.get('/dashboard/charts', async (req, res) => {
  const { days } = parseQuery(dashboardChartsQuerySchema, req);
  ok(res, await getCharts(days, isSuperAdmin(req.admin!.role)));
});

// Small counts for the sidebar badges; cheap enough to poll.
adminRouter.get('/badges', async (req, res) => ok(res, await getBadges(req.admin!.id)));

/* ---------------- Notifications (bell) ---------------- */

adminRouter.get('/notifications', async (req, res) =>
  ok(res, await alerts.listNotifications(req.admin!.id, req.query.unread === '1')),
);

adminRouter.post('/notifications/read', async (req, res) => {
  const { ids, all } = parseBody(notificationReadSchema, req);
  await alerts.markRead(req.admin!.id, all ? undefined : ids);
  ok(res, { read: true });
});

/* ---------------- Team (Super Admin) ---------------- */

// Names of active team members, for "assign to" pickers. Everyone may read.
adminRouter.get('/team/assignees', async (_req, res) => ok(res, await team.listAssignees()));

adminRouter.get('/team', requireRole('admin'), async (_req, res) => ok(res, await team.listTeam()));

adminRouter.post('/team', requireRole('admin'), async (req, res) => {
  const m = await team.createMember(parseBody(teamCreateSchema, req));
  await audit(req.admin, 'create', 'team', m.id, `${m.name} (${m.role})`);
  created(res, m);
});

adminRouter.patch('/team/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(teamUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const m = await team.updateMember(id, patch, req.admin!.id);
  await audit(
    req.admin,
    patch.active === false ? 'deactivate' : patch.active ? 'activate' : 'update',
    'team',
    id,
    `${m.name}: ${Object.keys(patch).join(', ')}`,
  );
  ok(res, m);
});

adminRouter.post('/team/:id/password', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const { password } = parseBody(setPasswordSchema, req);
  const m = await team.setMemberPassword(id, password);
  await audit(req.admin, 'set-password', 'team', id, m.name);
  ok(res, { changed: true });
});

adminRouter.get('/activity', requireRole('admin'), async (req, res) => {
  const { items, meta } = await team.listActivity(parseQuery(activityQuerySchema, req));
  ok(res, items, meta);
});

/* ---------------- What visitors search for ---------------- */

adminRouter.get('/search-insights', async (req, res) => {
  const { days } = parseQuery(
    z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }),
    req,
  );
  ok(res, await searchInsights(days));
});

/* ---------------- Alert settings (Super Admin) ---------------- */

adminRouter.get('/alerts', requireRole('admin'), async (_req, res) =>
  ok(res, { settings: await alerts.getAlertSettings(), channels: alerts.alertChannels() }),
);

adminRouter.patch('/alerts', requireRole('admin'), async (req, res) => {
  const patch = onlySentKeys(parseBody(alertSettingsUpdateSchema, req), req.body);
  const settings = await alerts.updateAlertSettings(patch);
  await audit(req.admin, 'update', 'alerts', undefined, Object.keys(patch).join(', '));
  ok(res, { settings, channels: alerts.alertChannels() });
});

adminRouter.post('/alerts/test', requireRole('admin'), async (req, res) =>
  ok(res, await alerts.sendTestAlert(req.admin!.name)),
);

/* ---------------- Properties ---------------- */

adminRouter.get('/properties', async (req, res) => {
  const { items, meta } = await properties.listAdmin(parseQuery(adminPropertyQuerySchema, req));
  ok(res, items, meta);
});

// Bulk import from a broker's or owner's sheet. Rows become drafts; photos are added in the editor.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, fields: 2 },
});

adminRouter.get('/properties/import/template', (_req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="nexus-listings-template.csv"');
  res.send(importTemplateCsv());
});

adminRouter.post(
  '/properties/import',
  limiters.upload,
  requireRole('editor'),
  csvUpload.single('file'),
  async (req, res) => {
    const file = req.file;
    if (!file?.buffer.length) throw badRequest('Choose a CSV file');
    const text = file.buffer.toString('utf8');
    if (text.includes('\u0000')) throw badRequest('Save the sheet as CSV (UTF-8) and upload that');
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const result = await importProperties(text, { dryRun, adminId: req.admin!.id });
    if (!dryRun && result.created) {
      await audit(
        req.admin,
        'import',
        'property',
        undefined,
        `${result.created} draft(s) from ${file.originalname}`,
      );
    }
    ok(res, result);
  },
);

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

adminRouter.post('/properties/:id/feature', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const { days } = parseBody(featureListingSchema, req);
  const p = await featured.setFeatured(id, days);
  await audit(req.admin, days ? `feature:${days}d` : 'unfeature', 'property', id, p.title);
  ok(res, p);
});

adminRouter.get('/featured', async (_req, res) => ok(res, await featured.listFeatured()));

adminRouter.delete('/properties/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const removed = await properties.deleteProperty(id);
  await audit(req.admin, 'delete', 'property', id, removed.title);
  ok(res, { deleted: true });
});

/* ---------------- Projects ---------------- */

adminRouter.get('/projects', async (req, res) => {
  const { items, meta } = await projects.listAdminProjects(
    parseQuery(adminProjectQuerySchema, req),
  );
  ok(res, items, meta);
});

adminRouter.get('/projects/:id', async (req, res) =>
  ok(res, await projects.getAdminProject(parseId(req))),
);

adminRouter.patch('/projects/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(adminProjectUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const p = await projects.updateAdminProject(id, patch);
  await audit(req.admin, 'update', 'project', id, Object.keys(patch).join(', '));
  ok(res, p);
});

adminRouter.post('/projects/:id/status', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const { status, note } = parseBody(projectStatusChangeSchema, req);
  const p = await projects.changeProjectStatus(id, status, note);
  await audit(req.admin, `status:${status}`, 'project', id, p.name);
  ok(res, p);
});

adminRouter.delete('/projects/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const removed = await projects.deleteProject(id);
  await audit(req.admin, 'delete', 'project', id, removed.name);
  ok(res, { deleted: true });
});

/* ---------------- Listing reports ---------------- */

adminRouter.get('/reports', async (req, res) => {
  const { items, meta } = await reports.listReports(parseQuery(adminReportQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.patch('/reports/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const { status, note } = parseBody(reportUpdateSchema, req);
  const r = await reports.updateReport(id, status, req.admin!.email, note);
  await audit(req.admin, `report:${status}`, 'report', id, r.property?.title ?? '');
  ok(res, r);
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
  const { items, meta } = await leads.listEnquiries(
    parseQuery(adminEnquiryQuerySchema, req),
    req.admin!.id,
  );
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

adminRouter.post('/enquiries/:id/assign', async (req, res) => {
  const id = parseId(req);
  const { adminId } = parseBody(leadAssignSchema, req);
  const e = await leads.assignLead(id, adminId, req.admin!);
  await audit(
    req.admin,
    adminId ? 'assign' : 'unassign',
    'enquiry',
    id,
    `${e.leadId}${e.assignedTo ? ` → ${e.assignedTo}` : ''}`,
  );
  ok(res, e);
});

/* ---------------- Site visits ---------------- */

adminRouter.get('/visits', async (req, res) => {
  const { items, meta } = await visits.listVisits(
    parseQuery(siteVisitQuerySchema, req),
    req.admin!.id,
  );
  ok(res, items, meta);
});

adminRouter.post('/visits', async (req, res) => {
  const v = await visits.createVisit(parseBody(siteVisitCreateSchema, req), req.admin!);
  await audit(
    req.admin,
    'create',
    'visit',
    v.id,
    `${v.name}${v.enquiry ? ` (${v.enquiry.leadId})` : ''}`,
  );
  created(res, v);
});

adminRouter.patch('/visits/:id', async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(siteVisitUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const { visit, changes } = await visits.updateVisit(id, patch, req.admin!);
  await audit(req.admin, changes[0] ?? 'update', 'visit', id, visit.name);
  ok(res, visit);
});

adminRouter.delete('/visits/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const v = await visits.deleteVisit(id);
  await audit(req.admin, 'delete', 'visit', id, v.name);
  ok(res, { deleted: true });
});

/* ---------------- Help & support tickets ---------------- */

adminRouter.get('/support', async (req, res) => {
  const { items, meta, counts } = await tickets.listForAdmin(
    parseQuery(adminSupportQuerySchema, req),
  );
  ok(res, { items, counts }, meta);
});

adminRouter.get('/support/:id', async (req, res) => {
  ok(res, await tickets.getForAdmin(parseId(req)));
});

adminRouter.post('/support/:id/reply', async (req, res) => {
  const id = parseId(req);
  const { ticket, changes } = await tickets.replyAsAdmin(
    id,
    parseBody(adminSupportReplySchema, req),
    req.admin!,
  );
  if (changes.length)
    await audit(
      req.admin,
      changes.includes('reply') ? 'reply' : 'status',
      'support',
      id,
      `${ticket.ticketId} ${ticket.user.name} (${ticket.status})`,
    );
  ok(res, ticket);
});

/* ---------------- Agent & builder verification ---------------- */

adminRouter.get('/verification', async (req, res) => {
  const { items, meta, counts } = await adminUsers.listVerification(
    parseQuery(verificationQuerySchema, req),
  );
  res.json({ ok: true, data: items, meta, counts });
});

adminRouter.post('/users/:id/verification', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const input = parseBody(verificationDecisionSchema, req);
  const u = await adminUsers.decideVerification(id, input, req.admin!.name);
  await audit(req.admin, `verify:${input.decision}`, 'user', id, u.companyName ?? u.name);
  ok(res, u);
});

/* ---------------- Plans & payments (Super Admin) ---------------- */

adminRouter.get('/plans', async (_req, res) => ok(res, await billing.listPlans()));

adminRouter.post('/plans', requireRole('admin'), async (req, res) => {
  const p = await billing.createPlan(parseBody(planSchema, req));
  await audit(req.admin, 'create', 'plan', p.id, `${p.name} ₹${p.price}`);
  created(res, p);
});

adminRouter.patch('/plans/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(planUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const p = await billing.updatePlan(id, patch);
  await audit(req.admin, 'update', 'plan', id, `${p.name}: ${Object.keys(patch).join(', ')}`);
  ok(res, p);
});

adminRouter.get('/payments', requireRole('admin'), async (req, res) => {
  const { items, meta } = await billing.listPayments(parseQuery(paymentQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/payments/summary', requireRole('admin'), async (_req, res) =>
  ok(res, await billing.paymentSummary()),
);

adminRouter.post('/payments/manual', requireRole('admin'), async (req, res) => {
  const p = await billing.recordManualPayment(parseBody(manualPaymentSchema, req), req.admin!.name);
  await audit(
    req.admin,
    'record',
    'payment',
    p.id,
    `₹${p.amount} ${p.plan.name} — ${p.user?.name ?? ''}`,
  );
  created(res, p);
});

adminRouter.post('/payments/manual-feature', requireRole('admin'), async (req, res) => {
  const p = await billing.recordManualFeature(parseBody(manualFeatureSchema, req), req.admin!.name);
  await audit(req.admin, 'record', 'payment', p.id, `₹${p.amount} ${p.plan.name}`);
  created(res, p);
});

adminRouter.post('/payments/:id/refund', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const p = await billing.refundPayment(id, req.admin!.name);
  await audit(req.admin, 'refund', 'payment', id, `₹${p.amount} ${p.plan.name}`);
  ok(res, p);
});

/* ---------------- Website users ---------------- */

adminRouter.get('/users', async (req, res) => {
  const { items, meta } = await adminUsers.listUsers(parseQuery(adminUserQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/users/:id', async (req, res) => ok(res, await adminUsers.getUser(parseId(req))));

adminRouter.patch('/users/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(adminUserUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const u = await adminUsers.updateUser(id, patch, req.admin!.name);
  await audit(req.admin, 'update', 'user', id, Object.keys(patch).join(', '));
  ok(res, u);
});

adminRouter.post('/users/:id/password', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const { password } = parseBody(setUserPasswordSchema, req);
  const u = await adminUsers.setUserPassword(id, password);
  await audit(req.admin, 'set-password', 'user', id, u.name);
  ok(res, { changed: true });
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
  if (c.active) {
    const live = c.localities.filter((l) => l.active);
    notifyIndexNow(
      ['buy', 'rent'].flatMap((d) => [
        `/${d}/${c.slug}`,
        ...live.map((l) => `/${d}/${c.slug}/${l.slug}`),
      ]),
    );
  }
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

/* ---------------- Blog ---------------- */

adminRouter.get('/blog', async (req, res) => {
  const { items, meta } = await blog.listAdmin(parseQuery(adminBlogQuerySchema, req));
  ok(res, items, meta);
});

adminRouter.get('/blog/analytics', async (req, res) => {
  const { days } = parseQuery(blogAnalyticsQuerySchema, req);
  ok(res, await blogAnalytics.overview(days));
});

adminRouter.get('/blog/:id/analytics', async (req, res) => {
  const { days } = parseQuery(blogAnalyticsQuerySchema, req);
  ok(res, await blogAnalytics.postReport(parseId(req), days));
});

adminRouter.get('/blog/:id', async (req, res) => ok(res, await blog.getAdmin(parseId(req))));

adminRouter.post('/blog', requireRole('editor'), async (req, res) => {
  const post = await blog.createPost(parseBody(blogPostCreateSchema, req), req.admin!.id);
  await audit(
    req.admin,
    post.status === 'published' ? 'publish' : 'create',
    'blog',
    post.id,
    post.title,
  );
  if (post.status === 'published') notifyIndexNow([`/blog/${post.slug}`, '/blog']);
  created(res, post);
});

adminRouter.patch('/blog/:id', requireRole('editor'), async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(blogPostUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  const post = await blog.updatePost(id, patch, req.admin!.id);
  await audit(
    req.admin,
    patch.status ? `status:${patch.status}` : 'update',
    'blog',
    id,
    post.title,
  );
  if (post.status === 'published') notifyIndexNow([`/blog/${post.slug}`, '/blog']);
  ok(res, post);
});

adminRouter.delete('/blog/:id', requireRole('admin'), async (req, res) => {
  const id = parseId(req);
  const removed = await blog.deletePost(id);
  await audit(req.admin, 'delete', 'blog', id, removed.title);
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
