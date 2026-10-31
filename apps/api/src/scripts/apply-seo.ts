/**
 * Adds the keyword copy from seo-copy.ts to Buy/Rent location pages that have none yet.
 * Safe to run on every deploy: it never overwrites copy written in Admin → Locations.
 *
 *   pnpm seo:apply
 */
import { applySeoCopy } from './seo-copy.js';
import { runScript } from './run.js';

await runScript('seo:apply', async () => {
  const filled = await applySeoCopy();
  console.warn(filled.length ? `Filled: ${filled.join(', ')}` : 'Nothing to fill');
});
