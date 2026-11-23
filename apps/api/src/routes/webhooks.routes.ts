import express, { Router, type Router as RouterType } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { limiters } from '../middleware/security.js';
import * as billing from '../services/billing.service.js';

/**
 * Calls from outside services. Mounted before the JSON parser: the Razorpay signature
 * covers the exact bytes it sent, so the body must stay raw.
 */
export const webhookRouter: RouterType = Router();
webhookRouter.use(limiters.global);

webhookRouter.post('/razorpay', express.raw({ type: '*/*', limit: '100kb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!env.RAZORPAY_WEBHOOK_SECRET) {
    logger.error('Razorpay webhook called but RAZORPAY_WEBHOOK_SECRET is not set');
    res.status(503).json({ ok: false });
    return;
  }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!billing.webhookSignatureValid(raw, req.get('x-razorpay-signature'))) {
    logger.warn('Razorpay webhook with a bad signature');
    res.status(400).json({ ok: false });
    return;
  }
  let event: Parameters<typeof billing.handleRazorpayEvent>[0];
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    res.status(400).json({ ok: false });
    return;
  }
  // A 5xx makes Razorpay retry later; everything else is final.
  const result = await billing.handleRazorpayEvent(event);
  logger.info(
    { event: event.event, eventId: req.get('x-razorpay-event-id'), result },
    'Razorpay webhook',
  );
  res.json({ ok: true, result });
});
