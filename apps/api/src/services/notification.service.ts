import type { Types } from 'mongoose';
import {
  ALERT_EVENT_LABELS,
  alertSettingsSchema,
  type AdminNotification as NotificationDto,
  type AlertChannels,
  type AlertEvent,
  type AlertSettings,
} from '@nexus/shared';
import { env, mailEnabled, whatsappEnabled } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { Admin, SiteSettings } from '../models/misc.models.js';
import { AdminNotification } from '../models/admin-panel.models.js';
import { sendMail } from './mail.service.js';

/* ---------------- Alert settings (stored beside site settings, never public) ---------------- */

const ALERTS_KEY = 'alerts';
let cache: { value: AlertSettings; at: number } | null = null;

export async function getAlertSettings(): Promise<AlertSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const doc = await SiteSettings.findOne({ key: ALERTS_KEY }).lean();
  const value = alertSettingsSchema.parse(doc?.data ?? {}) as AlertSettings;
  cache = { value, at: Date.now() };
  return value;
}

export async function updateAlertSettings(patch: Partial<AlertSettings>) {
  const current = await getAlertSettings();
  const next = alertSettingsSchema.parse({
    ...current,
    ...patch,
    events: { ...current.events, ...(patch.events ?? {}) },
  }) as AlertSettings;
  await SiteSettings.updateOne(
    { key: ALERTS_KEY },
    { $set: { data: next }, $setOnInsert: { key: ALERTS_KEY } },
    { upsert: true },
  );
  cache = null;
  return next;
}

export const clearAlertCache = () => {
  cache = null;
};

export const alertChannels = (): AlertChannels => ({
  email: mailEnabled,
  whatsapp: whatsappEnabled,
});

/* ---------------- WhatsApp Cloud API ---------------- */

/** Sends the approved alert template to one number. Returns false when off or failed. */
export async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  if (!whatsappEnabled) return false;
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: env.WHATSAPP_TEMPLATE,
            language: { code: env.WHATSAPP_TEMPLATE_LANG },
            components: [
              // WhatsApp rejects newlines and long runs of spaces inside variables.
              {
                type: 'body',
                parameters: [{ type: 'text', text: text.replace(/\s+/g, ' ').slice(0, 900) }],
              },
            ],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, 'WhatsApp alert failed');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err }, 'WhatsApp alert failed');
    return false;
  }
}

/* ---------------- In-app bell + outside alerts ---------------- */

type Audience = 'all' | 'super' | Array<string | Types.ObjectId>;

type Alert = {
  kind: NotificationDto['kind'];
  title: string;
  body?: string;
  /** Admin path, e.g. "/admin/enquiries?open=…". */
  link?: string;
  to?: Audience;
};

async function recipients(to: Audience) {
  if (Array.isArray(to)) {
    return Admin.find({ _id: { $in: to }, active: true })
      .select('_id')
      .lean();
  }
  return Admin.find({
    active: true,
    ...(to === 'super' ? { role: { $in: ['owner', 'admin'] } } : {}),
  })
    .select('_id')
    .lean();
}

/** Puts a notification on the bell of each recipient. Never throws. */
export async function notifyAdmins(alert: Alert) {
  try {
    const list = await recipients(alert.to ?? 'all');
    if (!list.length) return;
    await AdminNotification.insertMany(
      list.map((a) => ({
        admin: a._id,
        kind: alert.kind,
        title: alert.title.slice(0, 160),
        body: (alert.body ?? '').slice(0, 500),
        link: alert.link ?? null,
      })),
    );
  } catch (err) {
    logger.warn({ err }, 'notification write failed');
  }
}

/**
 * A business event: goes on everyone's bell and, if switched on in alert settings,
 * out by email and WhatsApp. Runs in the background; never affects the request.
 */
export async function businessAlert(
  event: AlertEvent,
  alert: Omit<Alert, 'kind'>,
  opts: { skipEmail?: boolean } = {},
) {
  await notifyAdmins({ ...alert, kind: event });
  try {
    const s = await getAlertSettings();
    if (!s.events[event]) return;
    const text = [alert.title, alert.body].filter(Boolean).join(' — ');
    const url = alert.link ? `${env.PUBLIC_SITE_URL}${alert.link}` : `${env.PUBLIC_SITE_URL}/admin`;
    const jobs: Promise<unknown>[] = [];
    if (!opts.skipEmail) {
      for (const to of s.emails) {
        jobs.push(
          sendMail(
            to,
            `NEXUS: ${alert.title}`,
            [ALERT_EVENT_LABELS[event], ...(alert.body ? [alert.body] : [])],
            {
              label: 'Open in admin',
              url,
            },
          ),
        );
      }
    }
    for (const n of s.whatsappNumbers) jobs.push(sendWhatsApp(n, `${text} ${url}`));
    await Promise.allSettled(jobs);
  } catch (err) {
    logger.warn({ err, event }, 'business alert failed');
  }
}

/** Sends a test message on every configured channel and reports what worked. */
export async function sendTestAlert(by: string) {
  const s = await getAlertSettings();
  const text = `Test alert from NEXUS admin, sent by ${by}. If you got this, alerts work.`;
  const email = await Promise.all(s.emails.map((to) => sendMail(to, 'NEXUS: test alert', [text])));
  const whatsapp = await Promise.all(s.whatsappNumbers.map((n) => sendWhatsApp(n, text)));
  return {
    email: { configured: mailEnabled, sent: email.filter(Boolean).length, of: s.emails.length },
    whatsapp: {
      configured: whatsappEnabled,
      sent: whatsapp.filter(Boolean).length,
      of: s.whatsappNumbers.length,
    },
  };
}

type NotificationLean = {
  _id: Types.ObjectId;
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  read: boolean;
  createdAt: Date;
};

export async function listNotifications(adminId: string, unreadOnly: boolean, limit = 30) {
  const f = { admin: adminId, ...(unreadOnly ? { read: false } : {}) };
  const [rows, unread] = await Promise.all([
    AdminNotification.find(f).sort({ createdAt: -1 }).limit(limit).lean<NotificationLean[]>(),
    AdminNotification.countDocuments({ admin: adminId, read: false }),
  ]);
  return {
    unread,
    items: rows.map(
      (n): NotificationDto => ({
        id: String(n._id),
        kind: n.kind as NotificationDto['kind'],
        title: n.title,
        body: n.body ?? '',
        link: n.link ?? null,
        read: n.read,
        createdAt: n.createdAt.toISOString(),
      }),
    ),
  };
}

export async function markRead(adminId: string, ids?: string[]) {
  await AdminNotification.updateMany(
    { admin: adminId, read: false, ...(ids?.length ? { _id: { $in: ids } } : {}) },
    { $set: { read: true } },
  );
}
