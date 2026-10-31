/**
 * Keyword-focused Buy and Rent page copy for the first locations we target in search:
 * /buy/jaipur, /rent/jaipur, /buy/jaipur/vaishali-nagar and /rent/jaipur/vaishali-nagar.
 *
 * `applySeoCopy()` fills a page's copy only if that page has never had any, so anything an
 * editor writes (or clears) in Admin → Locations always wins and is never overwritten.
 */
import type { DealSeo } from '@nexus/shared';
import { City } from '../models/misc.models.js';

type PageCopy = { buySeo: DealSeo; rentSeo: DealSeo };

export const SEO_COPY: {
  city: string;
  copy: PageCopy;
  localities: Record<string, PageCopy>;
}[] = [
  {
    city: 'jaipur',
    copy: {
      buySeo: {
        title: 'Buy Property in Jaipur: Flats, Houses & Plots',
        description:
          'Buy flats, houses, villas and plots in Jaipur. 2 and 3 BHK, ready to move and new projects with photos, prices and direct contact on NEXUS Estate.',
        h1: 'Property for Sale in Jaipur',
        intro:
          'Looking for property in Jaipur? Browse flats, independent houses, villas and plots for sale across the city, from established colonies like Vaishali Nagar, Malviya Nagar and Mansarovar to growing areas along Ajmer Road, Tonk Road and Jagatpura. Filter 2 BHK and 3 BHK flats by budget, pick ready to move homes or new projects, and see RERA numbers where the seller has added them. Every listing is checked by our team before it goes live, and you contact owners, agents and builders directly. Jaipur me flat, makan ya plot kharidna hai? Apna budget aur area chuniye.',
      },
      rentSeo: {
        title: 'Flats & Houses for Rent in Jaipur: 1, 2, 3 BHK',
        description:
          'Find flats, houses, rooms and PGs for rent in Jaipur. Compare rent, deposit and furnishing, and contact owners and agents directly on NEXUS Estate.',
        h1: 'Flats & Houses for Rent in Jaipur',
        intro:
          'Find a flat or house for rent in Jaipur that fits your budget. Compare 1 BHK, 2 BHK and 3 BHK flats, independent houses, rooms and PGs on rent in areas like Vaishali Nagar, Malviya Nagar, Mansarovar, C-Scheme and Jagatpura. Filter by furnished, semi furnished or unfurnished, check the monthly rent and deposit, and talk to owners and agents directly. Offices and shops for rent are listed too. Jaipur me kiraye par makan ya flat chahiye? Area aur budget chuniye.',
      },
    },
    localities: {
      'vaishali-nagar': {
        buySeo: {
          title: 'Flats & Houses for Sale in Vaishali Nagar, Jaipur',
          description:
            '2 and 3 BHK flats, houses, villas and plots for sale in Vaishali Nagar, Jaipur. See prices, photos and locality rates, and contact owners on NEXUS Estate.',
          h1: 'Flats & Property for Sale in Vaishali Nagar, Jaipur',
          intro:
            'Vaishali Nagar is one of the most popular residential areas in west Jaipur, close to Gandhi Path, Queens Road, Amrapali Circle and Ajmer Road. Browse 2 BHK and 3 BHK flats, builder floors, independent houses, villas and plots for sale in Vaishali Nagar, along with shops and offices on its busy market roads. Compare asking prices and the locality’s price per sq ft below, and contact owners, agents and builders directly. Vaishali Nagar Jaipur me flat ya makan kharidna hai? Yahan dekhiye.',
        },
        rentSeo: {
          title: 'Flats for Rent in Vaishali Nagar, Jaipur: 1-3 BHK',
          description:
            '1, 2 and 3 BHK flats, houses, rooms and PGs for rent in Vaishali Nagar, Jaipur. Furnished and family options with direct owner contact on NEXUS Estate.',
          h1: 'Flats & Houses for Rent in Vaishali Nagar, Jaipur',
          intro:
            'Looking for a flat for rent in Vaishali Nagar, Jaipur? Compare 1 BHK, 2 BHK and 3 BHK flats, independent houses, rooms and PGs on rent near Gandhi Path, Queens Road, Amrapali Circle and the Vaishali Nagar market. Filter furnished and semi furnished homes, check the monthly rent and deposit, and see typical rents by BHK for the locality below. Contact owners and agents directly. Vaishali Nagar me kiraye par flat ya room chahiye? Yahan dekhiye.',
        },
      },
    },
  },
];

/** True only for pages that have never had Buy/Rent copy; a page an editor cleared stays clear. */
const neverSet = (s: unknown) => s === undefined || s === null;

/** Fills empty Buy/Rent page copy. Returns the pages it filled, e.g. "buy/jaipur". */
export async function applySeoCopy(): Promise<string[]> {
  const filled: string[] = [];
  for (const entry of SEO_COPY) {
    const city = await City.findOne({ slug: entry.city });
    if (!city) continue;
    let changed = false;
    for (const deal of ['buySeo', 'rentSeo'] as const) {
      if (neverSet(city.get(deal))) {
        city.set(deal, entry.copy[deal]);
        filled.push(`${deal === 'buySeo' ? 'buy' : 'rent'}/${entry.city}`);
        changed = true;
      }
    }
    for (const [slug, copy] of Object.entries(entry.localities)) {
      const loc = city.localities.find((l) => l.slug === slug);
      if (!loc) continue;
      for (const deal of ['buySeo', 'rentSeo'] as const) {
        if (neverSet(loc.get(deal))) {
          loc.set(deal, copy[deal]);
          filled.push(`${deal === 'buySeo' ? 'buy' : 'rent'}/${entry.city}/${slug}`);
          changed = true;
        }
      }
    }
    if (changed) await city.save();
  }
  return filled;
}
