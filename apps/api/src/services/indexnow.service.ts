import { env, isProd } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * IndexNow (https://www.indexnow.org): tells Bing (and through it ChatGPT search and
 * Copilot), Yandex and others about new or changed URLs right away, without Search Console.
 * The key is public by design: the website serves it at /<key>.txt (apps/web/public).
 */
export const INDEXNOW_KEY = 'c72a622105ee7079f8a6a4cbe6ead30d';

/** Fire-and-forget ping for site paths such as "/blog/my-post". Production only. */
export function notifyIndexNow(paths: string[]): void {
  if (!isProd || !paths.length) return;
  let base: URL;
  try {
    base = new URL(env.PUBLIC_SITE_URL);
  } catch {
    return;
  }
  if (base.hostname === 'localhost' || base.hostname === '127.0.0.1') return;
  const urlList = [...new Set(paths)].slice(0, 10_000).map((p) => new URL(p, base).toString());
  void fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: base.host,
      key: INDEXNOW_KEY,
      keyLocation: new URL(`/${INDEXNOW_KEY}.txt`, base).toString(),
      urlList,
    }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => logger.info({ status: res.status, urls: urlList.length }, 'indexnow ping'))
    .catch((err: unknown) => logger.warn({ err }, 'indexnow ping failed'));
}
