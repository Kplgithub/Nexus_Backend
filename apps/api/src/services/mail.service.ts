import nodemailer, { type Transporter } from 'nodemailer';
import { env, mailEnabled } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { getSettings } from './settings.service.js';

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Notify the business about a new lead. Runs after the lead is saved and never
 * affects the visitor's response: a mail outage must not lose or block leads.
 */
export async function notifyNewLead(
  subject: string,
  fields: Record<string, string | null | undefined>,
) {
  const t = getTransport();
  if (!t) return;
  const settings = await getSettings();
  const to = settings.enquiryNotificationEmail;
  if (!to) return;
  const rows = Object.entries(fields)
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${esc(k)}</td><td>${esc(String(v))}</td></tr>`,
    )
    .join('');
  const text = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  try {
    await t.sendMail({
      from: env.MAIL_FROM,
      to,
      subject,
      text: `${text}\n\nOpen the admin dashboard: ${env.PUBLIC_SITE_URL}/admin`,
      html: `<table>${rows}</table><p><a href="${esc(env.PUBLIC_SITE_URL)}/admin">Open the admin dashboard</a></p>`,
    });
  } catch (err) {
    logger.error({ err }, 'Lead notification email failed');
  }
}

/** Sends a plain message to one recipient. Returns false when mail is not configured or fails. */
export async function sendMail(
  to: string,
  subject: string,
  lines: string[],
  link?: { label: string; url: string },
) {
  const t = getTransport();
  if (!t) return false;
  const text = [...lines, ...(link ? ['', `${link.label}: ${link.url}`] : [])].join('\n');
  const html =
    lines.map((l) => `<p>${esc(l)}</p>`).join('') +
    (link ? `<p><a href="${esc(link.url)}">${esc(link.label)}</a></p>` : '');
  try {
    await t.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
    return true;
  } catch (err) {
    logger.error({ err }, 'Email send failed');
    return false;
  }
}
