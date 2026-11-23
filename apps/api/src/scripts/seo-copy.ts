/**
 * Keyword-focused Buy and Rent page copy for Jaipur and its localities (longer, unique
 * copy is added a few localities at a time by the weekly SEO run).
 *
 * `applySeoCopy()` fills a page's copy only if that page has never had any, or if it still has
 * the exact older text named in `upgradeFrom`. Anything an editor writes (or clears) in
 * Admin → Locations always wins and is never overwritten.
 */
import type { DealSeo } from '@nexus/shared';
import { City } from '../models/misc.models.js';

type PageCopy = {
  buySeo: DealSeo;
  rentSeo: DealSeo;
  /**
   * Older copy this entry replaces. A page whose stored intro is still exactly this text was
   * never edited in Admin, so it gets the new copy; any edited page is left alone.
   */
  upgradeFrom?: Partial<Record<'buySeo' | 'rentSeo', string>>;
};

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
      mansarovar: {
        buySeo: {
          title: 'Flats & Houses for Sale in Mansarovar, Jaipur',
          description:
            'Buy flats, independent houses and plots in Mansarovar, Jaipur. 2 and 3 BHK homes near the metro and Madhyam Marg, with direct owner contact on NEXUS Estate.',
          h1: 'Property for Sale in Mansarovar, Jaipur',
          intro:
            'Mansarovar is one of the largest planned residential areas of Jaipur, in the south-west of the city. It is laid out in sectors with wide internal roads, parks and a neighbourhood market in almost every part, and it has grown over the years into a complete township where families can live, study, shop and commute without leaving the area. Most homes for sale here are independent houses and builder floors in the older sectors, plus apartments in societies around Shipra Path, Madhyam Marg and New Sanganer Road. Plots come up for resale too, mostly in the outer parts towards the newer extensions. Before you buy, ask for the patta, the approved map and the society or JDA papers, and check that the floor you are buying matches the sanctioned plan. Connectivity is one of the main reasons people choose Mansarovar. The Pink Line metro starts at Mansarovar station and runs east through Shyam Nagar, Ram Nagar, Civil Lines and the railway station to Chandpole and Badi Chaupar in the Walled City. By road, New Sanganer Road, Gopalpura Bypass, Tonk Road and Ajmer Road are all a short drive away, and Durgapura and Sanganer are close for the airport side. Daily life is easy: Madhyam Marg and Shipra Path have large shopping streets, and the area has many schools, coaching institutes, hospitals, clinics, banks and parks. Families who rent in Mansarovar often stay on and buy here, because they already know the sector and the schools. Browse flats, independent houses, builder floors and plots for sale in Mansarovar below. The page shows the locality price per sq ft worked out from current listings, so you can compare an asking price before you call. Every listing is checked by our team before it goes live, and you contact owners, agents and builders directly. Mansarovar Jaipur me ghar ya flat kharidna hai? Yahan dekhiye.',
        },
        rentSeo: {
          title: 'Flats for Rent in Mansarovar, Jaipur: 1-3 BHK',
          description:
            '1, 2 and 3 BHK flats, houses, rooms and PGs for rent in Mansarovar, Jaipur. Homes near the metro and Madhyam Marg with direct owner contact on NEXUS Estate.',
          h1: 'Flats & Houses for Rent in Mansarovar, Jaipur',
          intro:
            'Mansarovar is one of the easiest parts of Jaipur to find a home on rent. It is a large planned area in south-west Jaipur with many sectors, so there is a steady supply of rental floors in independent houses, flats in societies, and rooms and PGs for students and working people. The Pink Line metro starts at Mansarovar station and goes to Civil Lines, the railway station and the Walled City, which makes daily travel simple for office-goers and students. Families often prefer the quieter inner sectors near a park, while people who commute every day look for homes within walking distance of the metro or New Sanganer Road. Gopalpura, with its coaching institutes, Tonk Road, Durgapura and Ajmer Road are all a short drive away. Madhyam Marg and Shipra Path have big markets for groceries, clothes and eating out, and the area has many schools, coaching centres, hospitals and clinics. Most homes here are 1, 2 and 3 BHK floors in independent houses and flats in societies; ask the owner whether parking, water supply and the electricity meter are separate before you agree. Before you move in, read the rent agreement line by line, agree the deposit and notice period in writing, and complete tenant police verification. Compare 1 BHK, 2 BHK and 3 BHK flats, houses, rooms and PGs for rent in Mansarovar below. Check the monthly rent, deposit and furnishing, and see typical rents by BHK worked out from current listings, so you know a fair price before you visit. Every listing is checked by our team before it goes live, and you talk to owners and agents directly. Mansarovar me kiraye par flat ya room chahiye? Yahan dekhiye.',
        },
        // The first, shorter copy (Nov 2026 locality batch). Replaced only while a page still has it word for word.
        upgradeFrom: {
          buySeo:
            'Mansarovar is a planned residential area in south-west Jaipur, laid out in sectors with wide internal roads, parks and neighbourhood markets. Buyers here mostly look at independent houses and builder floors in the older sectors, and apartments in societies around Shipra Path, Madhyam Marg and New Sanganer Road. The Pink Line metro begins at Mansarovar, so a daily ride to Civil Lines, the railway station or the Walled City is easy, and Gopalpura, Tonk Road and Ajmer Road are a short drive away. Schools, hospitals, coaching centres and big shopping streets are all inside the area, which is why many families who rent here end up buying here. Browse flats, houses and plots for sale in Mansarovar below, check the locality price per sq ft from current listings, and contact owners, agents and builders directly. Mansarovar Jaipur me ghar ya flat kharidna hai? Yahan dekhiye.',
          rentSeo:
            'Mansarovar is one of the easiest parts of Jaipur to rent in: there is a large supply of rental floors in independent houses, flats in societies and rooms for students and working people. Tenants like the Pink Line metro from Mansarovar station, the markets on Madhyam Marg and Shipra Path, and the number of schools and coaching institutes nearby in Mansarovar and neighbouring Gopalpura. Families often prefer the quieter inner sectors, while those who commute every day look for homes within walking distance of the metro or New Sanganer Road. Compare 1 BHK, 2 BHK and 3 BHK flats, houses and PGs for rent in Mansarovar below, check the rent and deposit, and see typical rents by BHK worked out from current listings. Mansarovar me kiraye par flat ya room chahiye? Yahan dekhiye.',
        },
      },
      'jawahar-nagar': {
        buySeo: {
          title: 'Houses & Flats for Sale in Jawahar Nagar, Jaipur',
          description:
            'Independent houses, floors, flats and plots for sale in Jawahar Nagar, Jaipur, next to Raja Park. Resale homes with direct owner contact on NEXUS Estate.',
          h1: 'Property for Sale in Jawahar Nagar, Jaipur',
          intro:
            'Jawahar Nagar is an established residential colony in central-east Jaipur (PIN code 302004), next to Raja Park, Tilak Nagar and Bapu Nagar. It is laid out in numbered sectors with internal roads and parks, and it has been a settled family area for decades, so most of what comes up for sale is resale property rather than new projects. Typical homes here are independent houses, floors in older houses that owners sell one by one, and a smaller number of flats in low-rise buildings. Commercial property such as shops and small offices comes up on the main roads and near the market. Because many houses are old, check the patta, the approved map, the chain of earlier sale deeds and any pending dues with the seller before you pay a token amount. The location is the main reason buyers look at Jawahar Nagar. The Raja Park market is next door, and the city centre, Tilak Nagar, Bapu Nagar, Jawaharlal Nehru Marg and Malviya Nagar are a short drive away, so daily trips to offices, colleges and hospitals stay short. Schools, coaching centres, clinics, banks and neighbourhood shops are spread across the sectors. Browse independent houses, floors, flats, plots and shops for sale in Jawahar Nagar below. When there are current listings, the page shows the locality price per sq ft worked out from them, so you can compare an asking price before you call. Every listing is checked by our team before it goes live, and you contact owners, agents and builders directly. Jawahar Nagar Jaipur me makan ya flat kharidna hai? Yahan dekhiye.',
        },
        rentSeo: {
          title: 'Flats & Rooms for Rent in Jawahar Nagar, Jaipur',
          description:
            'Flats, house floors, rooms and PGs for rent in Jawahar Nagar, Jaipur, near Raja Park. Compare rent and deposit, and contact owners on NEXUS Estate.',
          h1: 'Flats & Houses for Rent in Jawahar Nagar, Jaipur',
          intro:
            'Jawahar Nagar is a settled residential colony in central-east Jaipur, next to Raja Park, Tilak Nagar and Bapu Nagar. It suits families and working people who want a central address, with markets, schools and hospitals close by and short trips to most parts of the city. Most homes on rent here are floors in independent houses: 1 BHK and 2 BHK floors for small families and working couples, and full houses or 3 BHK floors for bigger families. Rooms and PGs for students and working people are also available, mostly close to the main roads and the market. Some shops and small offices are let out on the busier roads. Raja Park market is next door for daily shopping and eating out, and Jawaharlal Nehru Marg, Malviya Nagar, Tilak Nagar and the city centre are a short drive away. Schools, coaching centres, clinics and banks are spread across the sectors. In older houses, ask the owner about parking, water supply, a separate electricity meter and who pays for repairs before you agree. Before you move in, get a written rent agreement, agree the deposit and notice period, and complete tenant police verification. Compare flats, house floors, rooms and PGs for rent in Jawahar Nagar below. Check the monthly rent, deposit and furnishing, and when there are current listings see typical rents by BHK worked out from them. Every listing is checked by our team before it goes live, and you talk to owners and agents directly. Jawahar Nagar me kiraye par flat ya room chahiye? Yahan dekhiye.',
        },
      },
    },
  },
];

/** True only for pages that have never had Buy/Rent copy; a page an editor cleared stays clear. */
const neverSet = (s: unknown) => s === undefined || s === null;

const squash = (t: string) => t.replace(/\s+/g, ' ').trim();

/** True when the stored copy is still the exact older text that `upgradeFrom` names. */
function stillOldCopy(stored: unknown, oldIntro: string | undefined): boolean {
  if (!oldIntro || !stored || typeof stored !== 'object') return false;
  const intro = (stored as { intro?: unknown }).intro;
  return typeof intro === 'string' && squash(intro) === squash(oldIntro);
}

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
        const stored = loc.get(deal);
        if (neverSet(stored) || stillOldCopy(stored, copy.upgradeFrom?.[deal])) {
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
