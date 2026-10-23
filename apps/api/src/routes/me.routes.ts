import { Router, type Router as RouterType } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { Types } from 'mongoose';
import {
  IMAGE_MAX_BYTES,
  PROPERTY_STATUSES,
  otpVerifySchema,
  profileUpdateSchema,
  userChangePasswordSchema,
  userPropertyCreateSchema,
  userPropertyStatusSchema,
  userPropertyUpdateSchema,
  type PropertyCard,
} from '@nexus/shared';
import { limiters } from '../middleware/security.js';
import { onlySentKeys, parseBody, parseId, parseQuery } from '../middleware/validate.js';
import { clearUserSession, issueUserSession, requireUser } from '../middleware/user-auth.js';
import { created, ok } from '../lib/respond.js';
import { badRequest, notFound } from '../lib/errors.js';
import { hashIp } from '../lib/crypto.js';
import { User } from '../models/user.model.js';
import { Property } from '../models/property.model.js';
import * as users from '../services/user.service.js';
import * as properties from '../services/property.service.js';
import * as leads from '../services/enquiry.service.js';
import { getUserDashboard } from '../services/dashboard.service.js';
import { storeImage } from '../services/upload.service.js';

/** Everything a signed-in website user can do with their own account. */
export const meRouter: RouterType = Router();

meRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
meRouter.use(requireUser);

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).catch(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).catch(20).default(20),
});

/* ---------------- Account ---------------- */

meRouter.get('/', async (req, res) => {
  ok(res, { user: await users.getMe(req.user!.id), csrfToken: req.userCsrfToken });
});

meRouter.patch('/', limiters.userWrite, async (req, res) => {
  const patch = onlySentKeys(parseBody(profileUpdateSchema, req), req.body);
  ok(res, await users.updateProfile(req.user!.id, patch));
});

meRouter.post('/verify-phone/request', limiters.otp, async (req, res) => {
  const result = await users.requestPhoneVerification(req.user!.id, hashIp(req.ip));
  ok(res, result);
});

meRouter.post('/verify-phone/confirm', limiters.userLogin, async (req, res) => {
  const { code } = parseBody(otpVerifySchema, req);
  const user = await users.confirmPhoneVerification(req.user!.id, code);
  ok(res, await users.getMe(String(user._id)));
});

meRouter.post('/change-password', limiters.userLogin, async (req, res) => {
  const { currentPassword, newPassword } = parseBody(userChangePasswordSchema, req);
  const user = await users.changeUserPassword(req.user!.id, currentPassword, newPassword);
  issueUserSession(res, { id: String(user._id), role: user.role, tokenVersion: user.tokenVersion });
  ok(res, { changed: true });
});

meRouter.post('/logout-all', async (req, res) => {
  await users.signOutUserEverywhere(req.user!.id);
  clearUserSession(res);
  ok(res, { signedOut: true });
});

meRouter.get('/dashboard', async (req, res) => {
  ok(res, await getUserDashboard(req.user!.id, req.user!.role));
});

/* ---------------- My listings ---------------- */

const statusQuery = z.object({
  status: z.enum(PROPERTY_STATUSES).optional().catch(undefined),
});

meRouter.get('/properties', async (req, res) => {
  const { status } = parseQuery(statusQuery, req);
  ok(res, await properties.listMine(req.user!.id, status));
});

meRouter.post('/properties', limiters.userWrite, async (req, res) => {
  const input = parseBody(userPropertyCreateSchema, req);
  created(res, await properties.createMine(req.user!, input));
});

meRouter.get('/properties/:id', async (req, res) => {
  ok(res, await properties.getMine(req.user!.id, parseId(req)));
});

meRouter.patch('/properties/:id', limiters.userWrite, async (req, res) => {
  const id = parseId(req);
  const patch = onlySentKeys(parseBody(userPropertyUpdateSchema, req), req.body);
  if (!Object.keys(patch).length) throw badRequest('Nothing to update');
  ok(res, await properties.updateMine(req.user!, id, patch));
});

meRouter.post('/properties/:id/status', limiters.userWrite, async (req, res) => {
  const id = parseId(req);
  const { status } = parseBody(userPropertyStatusSchema, req);
  ok(res, await properties.setMyStatus(req.user!, id, status));
});

meRouter.delete('/properties/:id', limiters.userWrite, async (req, res) => {
  await properties.deleteMine(req.user!.id, parseId(req));
  ok(res, { deleted: true });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_MAX_BYTES, files: 10, fields: 5 },
});

meRouter.post('/uploads', limiters.upload, upload.array('files', 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw badRequest('Choose at least one image');
  const results: (
    | { ok: true; name: string; image: Awaited<ReturnType<typeof storeImage>> }
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
  ok(res, results);
});

/* ---------------- Saved properties ---------------- */

meRouter.get('/saved', async (req, res) => {
  const user = await User.findById(req.user!.id).select('saved').lean();
  const ids = (user?.saved ?? []) as Types.ObjectId[];
  const rows = await Property.find({
    _id: { $in: ids },
    status: { $in: ['published', 'rented', 'sold'] },
  }).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  // Keep the order in which they were saved, newest first.
  const items: PropertyCard[] = [...ids]
    .reverse()
    .map((id) => byId.get(String(id)))
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .map((r) => properties.toCard(r as Parameters<typeof properties.toCard>[0]));
  ok(res, items);
});

meRouter.get('/saved/ids', async (req, res) => {
  const user = await User.findById(req.user!.id).select('saved').lean();
  ok(res, (user?.saved ?? []).map(String));
});

meRouter.put('/saved/:id', limiters.userWrite, async (req, res) => {
  const id = parseId(req);
  if (!(await Property.exists({ _id: id, status: 'published' })))
    throw notFound('Property not found');
  await User.updateOne({ _id: req.user!.id }, { $addToSet: { saved: id } });
  ok(res, { saved: true });
});

meRouter.delete('/saved/:id', limiters.userWrite, async (req, res) => {
  const id = parseId(req);
  await User.updateOne({ _id: req.user!.id }, { $pull: { saved: id } });
  ok(res, { saved: false });
});

/* ---------------- Leads and enquiries ---------------- */

meRouter.get('/leads', async (req, res) => {
  const { page, limit } = parseQuery(pageQuery, req);
  const { items, meta } = await leads.listLeadsForOwner(req.user!.id, page, limit);
  ok(res, items, meta);
});

const seenBody = z.object({ ids: z.array(z.string().max(24)).max(100).optional() });

meRouter.post('/leads/seen', limiters.userWrite, async (req, res) => {
  const { ids } = parseBody(seenBody, req);
  await leads.markLeadsSeen(req.user!.id, ids);
  ok(res, { updated: true });
});

meRouter.get('/enquiries', async (req, res) => {
  const { page, limit } = parseQuery(pageQuery, req);
  const { items, meta } = await leads.listSentEnquiries(req.user!.id, page, limit);
  ok(res, items, meta);
});

/** Reveal a poster's phone number (counts as a lead for them). */
meRouter.post('/contact/:id', limiters.userWrite, async (req, res) => {
  const id = parseId(req);
  ok(
    res,
    await leads.revealContact(id, req.user!, {
      ipHash: hashIp(req.ip),
      userAgent: req.get('user-agent'),
    }),
  );
});
