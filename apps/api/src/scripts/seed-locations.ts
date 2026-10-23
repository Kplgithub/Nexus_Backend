/**
 * OPTIONAL sample locations for development, demos and CI.
 * In production, add cities and localities from Admin → Locations instead;
 * the website shows only what the admin has added.
 *
 *   pnpm seed:locations
 */
import { slugify } from '@nexus/shared';
import { City } from '../models/misc.models.js';
import { runScript } from './run.js';
import { JAIPUR_LOCALITIES } from './jaipur-data.js';

const toLocality = (l: (typeof JAIPUR_LOCALITIES)[number]) => ({
  name: l.name,
  slug: slugify(l.name),
  active: true,
  intro: l.intro ?? '',
  center: l.center,
  highlights: l.highlights ?? [],
  landmarks: l.landmarks ?? [],
});

await runScript('seed:locations', async () => {
  const exists = await City.findOne({ slug: 'jaipur' });
  if (exists) {
    // Fill in map centres for localities added before they existed; never overwrite edits.
    let filled = 0;
    for (const l of exists.localities) {
      const sample = JAIPUR_LOCALITIES.find((s) => slugify(s.name) === l.slug);
      if (sample && !l.center) {
        l.center = sample.center;
        filled++;
      }
    }
    if (filled) await exists.save();
    console.warn(`Jaipur already exists — added map centres to ${filled} localities.`);
    return;
  }
  await City.create({
    name: 'Jaipur',
    slug: 'jaipur',
    state: 'Rajasthan',
    active: true,
    sortOrder: 0,
    intro:
      'Jaipur offers homes and business spaces for every need, from apartments and independent houses in established colonies to offices, shops and showrooms along the main commercial roads.',
    localities: JAIPUR_LOCALITIES.map(toLocality),
  });
  console.warn('Created Jaipur with', JAIPUR_LOCALITIES.length, 'localities');
});
