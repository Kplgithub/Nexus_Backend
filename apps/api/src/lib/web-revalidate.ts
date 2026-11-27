import type { Schema } from 'mongoose';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { bumpCache } from './redis.js';

/**
 * Tells the website to drop its cached copy of public data as soon as it
 * changes (listing approved, edited, removed, demo data deleted...). Without
 * this, a search URL nobody opened for a while can still show old listings on
 * its first visit.
 *
 * Calls are batched for a moment so a bulk change sends one request.
 * Production default: the website on the same server (port 3000).
 */
export type WebTag = 'properties' | 'projects' | 'profiles' | 'locations' | 'settings';

const DEBOUNCE_MS = 300;
const pending = new Set<WebTag>();
let timer: NodeJS.Timeout | null = null;
let inFlight: Promise<void> = Promise.resolve();

function targetUrl(): string | null {
  if (env.REVALIDATE_URL) return env.REVALIDATE_URL;
  return env.NODE_ENV === 'production' ? 'http://127.0.0.1:3000/api/revalidate' : null;
}

async function send(tags: WebTag[]) {
  const url = targetUrl();
  if (!url || !tags.length) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.REVALIDATE_SECRET ? { 'x-revalidate-secret': env.REVALIDATE_SECRET } : {}),
      },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) logger.warn({ status: res.status, tags }, 'website cache refresh refused');
  } catch (err) {
    // Never fail a listing change because the website is restarting.
    logger.warn({ err: (err as Error).message, tags }, 'website cache refresh failed');
  }
}

function flushNow() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tags = [...pending];
  pending.clear();
  inFlight = inFlight.then(() => send(tags));
  return inFlight;
}

export function refreshWebsite(...tags: WebTag[]) {
  // Cached API answers (Redis) go stale on the same events as the website's own cache.
  bumpCache('public');
  if (!targetUrl()) return;
  for (const t of tags) pending.add(t);
  if (!timer) {
    timer = setTimeout(() => void flushNow(), DEBOUNCE_MS);
    timer.unref?.();
  }
}

/** Scripts call this before exiting so the last change is not lost. */
export function flushWebsiteRefresh(): Promise<void> {
  return flushNow();
}

/** Only a view counter bump (plus the automatic updatedAt): nothing the website shows changed. */
function isViewCountOnly(update: unknown): boolean {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const u = update as Record<string, Record<string, unknown> | undefined>;
  if (!u.$inc || !Object.keys(u.$inc).every((k) => k === 'views')) return false;
  return Object.entries(u).every(
    ([op, fields]) =>
      op === '$inc' ||
      ((op === '$set' || op === '$setOnInsert') &&
        Object.keys(fields ?? {}).every((k) => k === 'updatedAt' || k === 'createdAt')),
  );
}

/** Hooks every write on a model so the website cache is refreshed after it. */
export function refreshWebsiteOnWrite(
  schema: Schema,
  tags: WebTag[],
  { deletesOnly = false }: { deletesOnly?: boolean } = {},
) {
  const fire = () => refreshWebsite(...tags);
  schema.post(
    ['deleteOne', 'deleteMany', 'findOneAndDelete'],
    { document: false, query: true },
    fire,
  );
  schema.post('deleteOne', { document: true, query: false }, fire);
  if (deletesOnly) return;
  schema.post('save', fire);
  schema.post('insertMany', fire);
  schema.post(
    ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne'],
    { document: false, query: true },
    function (this: { getUpdate(): unknown }) {
      if (!isViewCountOnly(this.getUpdate())) fire();
    },
  );
  schema.post('bulkWrite', fire);
}
