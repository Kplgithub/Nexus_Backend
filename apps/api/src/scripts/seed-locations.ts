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

const JAIPUR_LOCALITIES: { name: string; intro?: string }[] = [
  {
    name: 'Vaishali Nagar',
    intro:
      'Vaishali Nagar is a large, well-established residential area in west Jaipur with a mix of apartments, builder floors and independent houses, along with busy shopping streets suited to retail and small offices.',
  },
  {
    name: 'Malviya Nagar',
    intro:
      'Malviya Nagar in south Jaipur combines residential sectors with commercial stretches along its main roads, making it a common choice for both family homes and storefronts.',
  },
  {
    name: 'Jagatpura',
    intro:
      'Jagatpura in south-east Jaipur has seen steady growth in apartment projects and is popular with working professionals and students looking for newer housing.',
  },
  {
    name: 'C-Scheme',
    intro:
      'C-Scheme is one of central Jaipur’s best-known addresses, with offices, showrooms and premium residences close to key roads such as Ashok Marg and Prithviraj Road.',
  },
  { name: 'Mansarovar' },
  { name: 'Raja Park' },
  { name: 'Bani Park' },
  { name: 'Tonk Road' },
  { name: 'Civil Lines' },
  { name: 'Durgapura' },
  { name: 'Ajmer Road' },
  { name: 'Jawahar Nagar' },
  { name: 'Sodala' },
  { name: 'Nirman Nagar' },
  { name: 'Sitapura' },
];

await runScript('seed:locations', async () => {
  const exists = await City.findOne({ slug: 'jaipur' });
  if (exists) {
    console.warn('Jaipur already exists — nothing to do.');
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
    localities: JAIPUR_LOCALITIES.map((l) => ({
      name: l.name,
      slug: slugify(l.name),
      active: true,
      intro: l.intro ?? '',
    })),
  });
  console.warn('Created Jaipur with', JAIPUR_LOCALITIES.length, 'localities');
});
