import { LISTING_TYPES, AMENITY_LABELS, isFarmType, type PropertyCard } from '@nexus/shared';
import { z } from 'zod';
import type { FilterQuery } from 'mongoose';
import { Property, type PropertyAttrs } from '../../models/property.model.js';
import { SearchLog } from '../../models/search-log.model.js';
import { CARD_FIELDS, VISIBLE, toCard } from '../property.service.js';
import { listPublicLocations } from '../location.service.js';
import { farmListingsHidden } from '../settings.service.js';
import { logger } from '../../lib/logger.js';
import { parseQuery, understoodKeys, type Intent, type PlaceRef, type Point } from './parse.js';
import { scoreListing, type MatchReason } from './rank.js';

export const smartSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  deal: z.enum(LISTING_TYPES).optional(),
  /** Chips the visitor removed, e.g. "bedrooms,amenity:lift". */
  drop: z
    .string()
    .max(500)
    .optional()
    .transform(
      (v) =>
        new Set(
          (v ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
    ),
  /** The locality page the box sits on: used when the text names no place. */
  locality: z
    .string()
    .regex(/^[a-z0-9-]{1,100}$/)
    .optional(),
  /** "Raise my budget" button. */
  maxPrice: z.coerce.number().int().positive().max(1_000_000_000).optional(),
  page: z.coerce.number().int().min(1).max(10).default(1),
});
export type SmartSearchQuery = z.output<typeof smartSearchQuerySchema>;

export type SmartChip = { key: string; label: string; removable: boolean };
export type SmartResult = PropertyCard & {
  match: { score: number; exact: boolean; reasons: MatchReason[] };
};
export type SmartSearchResponse = {
  query: string;
  understood: boolean;
  hinglish: boolean;
  summary: string;
  chips: SmartChip[];
  /** Same search as normal filters, for the "open in filters" link. */
  filters: Record<string, string | number | boolean | string[] | undefined>;
  listingType: Intent['listingType'];
  city: string;
  exactCount: number;
  total: number;
  page: number;
  pages: number;
  items: SmartResult[];
  /** "Raise budget to ₹18,000 and see 4 more." */
  budgetSuggestion: { maxPrice: number; extra: number; label: string } | null;
  projectsPath: string | null;
};

const PAGE = 20;
const MAX_RESULTS = 200;
const CANDIDATE_LIMIT = 1500;

/* Locations change rarely; reading them on every keystroke is wasteful. */
let placesCache: {
  at: number;
  city: { slug: string; name: string };
  localities: PlaceRef[];
  centers: Map<string, Point>;
} | null = null;
async function places() {
  if (placesCache && Date.now() - placesCache.at < 60_000) return placesCache;
  const cities = await listPublicLocations();
  const city = cities.find((c) => c.slug === 'jaipur') ?? cities[0];
  const localities: PlaceRef[] = (city?.localities ?? []).map((l) => ({
    slug: l.slug,
    name: l.name,
    center: l.center ? { lat: l.center.lat, lng: l.center.lng } : null,
  }));
  const centers = new Map<string, Point>();
  for (const l of localities) if (l.center) centers.set(l.slug, l.center);
  placesCache = {
    at: Date.now(),
    city: { slug: city?.slug ?? 'jaipur', name: city?.name ?? 'Jaipur' },
    localities,
    centers,
  };
  return placesCache;
}
export const clearSmartSearchCache = () => {
  placesCache = null;
};

const rupees = (n: number) =>
  n >= 10_000_000
    ? `₹${+(n / 10_000_000).toFixed(2)} Cr`
    : n >= 100_000
      ? `₹${+(n / 100_000).toFixed(2)} lakh`
      : `₹${n.toLocaleString('en-IN')}`;

function applyDrops(i: Intent, drop: Set<string>) {
  if (drop.has('type')) {
    delete i.types;
    delete i.typeLabel;
  }
  if (drop.has('bedrooms')) delete i.bedrooms;
  if (drop.has('budget')) {
    delete i.minPrice;
    delete i.maxPrice;
  }
  if (drop.has('furnishing')) delete i.furnishing;
  if (drop.has('near')) delete i.near;
  if (drop.has('area')) delete i.areaSqft;
  if (drop.has('parking')) delete i.parking;
  if (drop.has('pgGender')) delete i.pgGender;
  if (drop.has('pgFood')) delete i.pgFood;
  if (drop.has('tenant')) delete i.tenant;
  if (drop.has('owner')) delete i.ownerOnly;
  if (drop.has('verified')) delete i.verified;
  if (drop.has('plotApproval')) delete i.plotApproval;
  if (drop.has('availableNow')) delete i.availableNow;
  if (drop.has('ready')) delete i.readyToMove;
  if (drop.has('cheap')) delete i.cheap;
  i.localities = i.localities.filter((l) => !drop.has(`locality:${l.slug}`));
  i.amenities = i.amenities.filter((a) => !drop.has(`amenity:${a}`));
}

function chipsFor(i: Intent): SmartChip[] {
  const c: SmartChip[] = [];
  c.push({
    key: 'deal',
    label: i.listingType === 'rent' ? 'For rent' : 'For sale',
    removable: false,
  });
  if (i.bedrooms)
    c.push({ key: 'bedrooms', label: `${i.bedrooms.join('/')} BHK`, removable: true });
  if (i.typeLabel) c.push({ key: 'type', label: i.typeLabel, removable: true });
  if (i.furnishing)
    c.push({
      key: 'furnishing',
      label:
        i.furnishing === 'furnished'
          ? 'Furnished'
          : i.furnishing === 'semi-furnished'
            ? 'Semi-furnished'
            : 'Unfurnished',
      removable: true,
    });
  for (const l of i.localities)
    c.push({ key: `locality:${l.slug}`, label: l.name, removable: true });
  if (i.near) c.push({ key: 'near', label: `Near ${i.near.name}`, removable: true });
  if (i.minPrice && i.maxPrice)
    c.push({
      key: 'budget',
      label: `${rupees(i.minPrice)} – ${rupees(i.maxPrice)}`,
      removable: true,
    });
  else if (i.maxPrice)
    c.push({ key: 'budget', label: `Up to ${rupees(i.maxPrice)}`, removable: true });
  else if (i.minPrice)
    c.push({ key: 'budget', label: `From ${rupees(i.minPrice)}`, removable: true });
  if (i.areaSqft)
    c.push({ key: 'area', label: `~${i.areaSqft.toLocaleString('en-IN')} sq ft`, removable: true });
  if (i.parking) c.push({ key: 'parking', label: 'Parking', removable: true });
  for (const a of i.amenities)
    c.push({ key: `amenity:${a}`, label: AMENITY_LABELS[a], removable: true });
  if (i.pgGender)
    c.push({
      key: 'pgGender',
      label: i.pgGender === 'female' ? 'For girls' : 'For boys',
      removable: true,
    });
  if (i.pgFood) c.push({ key: 'pgFood', label: 'With meals', removable: true });
  if (i.tenant)
    c.push({
      key: 'tenant',
      label: {
        family: 'Family',
        bachelors: 'Bachelors',
        students: 'Students',
        company: 'Company lease',
      }[i.tenant],
      removable: true,
    });
  if (i.ownerOnly) c.push({ key: 'owner', label: 'Direct owner', removable: true });
  if (i.verified) c.push({ key: 'verified', label: 'Verified', removable: true });
  if (i.plotApproval)
    c.push({
      key: 'plotApproval',
      label: `${i.plotApproval.toUpperCase()} approved`,
      removable: true,
    });
  if (i.availableNow) c.push({ key: 'availableNow', label: 'Available now', removable: true });
  if (i.readyToMove && i.listingType === 'sale')
    c.push({ key: 'ready', label: 'Ready to move', removable: true });
  if (i.cheap) c.push({ key: 'cheap', label: 'Lowest price first', removable: true });
  return c;
}

/** "furnished 2 BHK flats" (English) or "furnished 2 BHK flat" (Hinglish). */
function describeHomes(i: Intent): string {
  const parts: string[] = [];
  if (i.furnishing) parts.push(i.furnishing);
  if (i.bedrooms) parts.push(`${i.bedrooms.join('/')} BHK`);
  const label = i.typeLabel === 'PG' ? 'PG' : i.typeLabel?.toLowerCase();
  parts.push(
    label
      ? i.hinglish || label === 'PG'
        ? label
        : `${label}s`
      : i.hinglish
        ? 'property'
        : 'properties',
  );
  return parts.join(' ');
}

function summaryFor(i: Intent, exact: number, total: number): string {
  const where = i.localities.length
    ? i.localities.map((l) => l.name).join(i.hinglish ? ' ya ' : ' or ')
    : i.near
      ? i.hinglish
        ? `${i.near.name} ke paas`
        : `near ${i.near.name}`
      : '';
  const budget = i.maxPrice ? rupees(i.maxPrice) : null;
  const what = describeHomes(i);
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (i.hinglish) {
    if (exact > 0) {
      const loc = where ? (i.near && !i.localities.length ? `${where}, ` : `${where} mein `) : '';
      return `${loc}${budget ? `${budget} tak ke ` : ''}${what}: ${n(exact, 'option mila', 'options mile')}.`;
    }
    if (total > 0)
      return `Bilkul aisa abhi nahi mila. Yeh sabse kareeb wale ${total} options hain.`;
    return 'Abhi is search se koi property nahi mili. Area ya budget badal ke dekhiye.';
  }
  if (exact > 0)
    return `${n(exact, 'match', 'matches')}: ${what}${where ? ` ${i.near && !i.localities.length ? where : `in ${where}`}` : ''}${budget ? ` up to ${budget}` : ''}.`;
  if (total > 0) return `No exact match yet. Here are the ${total} closest options.`;
  return 'Nothing matches this search yet. Try another area or budget.';
}

function filtersFor(i: Intent, city: string) {
  return {
    listingType: i.listingType,
    city,
    locality: i.localities.length === 1 ? i.localities[0]!.slug : undefined,
    propertyType: i.types,
    bedrooms: i.bedrooms ? Math.min(...i.bedrooms) : undefined,
    minPrice: i.minPrice,
    maxPrice: i.maxPrice,
    furnishing: i.furnishing ? [i.furnishing] : undefined,
    amenities: i.amenities.length ? i.amenities : undefined,
    parking: i.parking,
    pgGender: i.pgGender,
    pgFood: i.pgFood,
    verified: i.verified,
    postedBy: i.ownerOnly ? 'owner' : undefined,
    plotApproval: i.plotApproval ? [i.plotApproval] : undefined,
    availableNow: i.availableNow,
  };
}

/** The hard limits: rent vs sale, the city, and the family of property (a PG is never a flat). */
function candidateFilter(i: Intent, city: string, hideFarms: boolean): FilterQuery<PropertyAttrs> {
  const f: FilterQuery<PropertyAttrs> = { ...VISIBLE, listingType: i.listingType, citySlug: city };
  const t = (i.types ?? []).filter((x) => !hideFarms || !isFarmType(x));
  if (t.includes('pg') && t.length === 1) f.propertyType = 'pg';
  else if (t.length && t.every((x) => isFarmType(x))) f.propertyType = { $in: t };
  else if (t.includes('plot'))
    f.propertyType = {
      $in: ['plot', 'industrial-land', ...t.filter((x) => isFarmType(x))],
    };
  else if (hideFarms && (i.types ?? []).length && !t.length) f.propertyType = { $in: [] };
  else if (
    t.some((x) =>
      ['office', 'shop', 'showroom', 'coworking', 'warehouse', 'factory-shed'].includes(x),
    )
  )
    f.propertyType = { $in: t };
  else if (t.length || i.bedrooms || i.furnishing)
    f.propertyType = {
      $in: t.includes('pg')
        ? ['apartment', 'builder-floor', 'independent-house', 'villa', 'studio', 'pg']
        : ['apartment', 'builder-floor', 'independent-house', 'villa', 'studio'],
    };
  return f;
}

/** Up to five reasons; what differs is always shown, matches fill the rest. */
function pickReasons(all: MatchReason[]): MatchReason[] {
  const misses = all.filter((r) => r.level !== 'yes').slice(0, 3);
  const hits = all.filter((r) => r.level === 'yes').slice(0, 5 - misses.length);
  return [...hits, ...misses];
}

const MATCH_FIELDS = `${CARD_FIELDS} amenities parking pgFoodIncluded preferredTenants boostRank`;

export async function smartSearch(q: SmartSearchQuery): Promise<SmartSearchResponse> {
  const { city, localities, centers } = await places();
  const intent = parseQuery(q.q, { localities, deal: q.deal });
  if (q.locality && !intent.localities.length && !intent.near) {
    const here = localities.find((l) => l.slug === q.locality);
    if (here) intent.localities.push(here);
  }
  applyDrops(intent, q.drop);
  if (q.maxPrice) intent.maxPrice = q.maxPrice;
  const keys = understoodKeys(intent);
  const understood = keys.length > 0;

  const hideFarms = await farmListingsHidden();
  const rows = await Property.find(candidateFilter(intent, city.slug, hideFarms))
    .select(MATCH_FIELDS)
    .sort({ featured: -1, boostRank: -1, refreshedAt: -1, publishedAt: -1 })
    .limit(CANDIDATE_LIMIT)
    .lean<Parameters<typeof toCard>[0][]>();

  const scored = rows.map((r) => ({
    row: r,
    s: scoreListing(r as never, intent, centers),
    featured: Boolean((r as { featured?: boolean }).featured),
    boost: (r as { boostRank?: number }).boostRank ?? 0,
    price: (r as { price: number }).price,
  }));
  scored.sort(
    (a, b) =>
      Number(b.s.exact) - Number(a.s.exact) ||
      b.s.score - a.s.score ||
      (intent.cheap ? a.price - b.price : 0) ||
      Number(b.featured) - Number(a.featured) ||
      b.boost - a.boost,
  );
  // Close matches only: a listing that meets under a third of the ask, or costs far
  // more than the budget, is noise. If nothing is close, show the best we have.
  let kept = understood
    ? scored.filter((x) => x.s.exact || (x.s.score >= 0.34 && !x.s.outOfBudget))
    : scored;
  if (!kept.length) kept = scored.slice(0, PAGE);
  const list = kept.slice(0, MAX_RESULTS);
  const exactCount = understood ? list.filter((x) => x.s.exact).length : 0;

  let budgetSuggestion: SmartSearchResponse['budgetSuggestion'] = null;
  if (intent.maxPrice && !q.maxPrice) {
    const misses = scored
      .filter((x) => x.s.onlyBudgetMiss !== undefined)
      .map((x) => x.s.onlyBudgetMiss!);
    if (misses.length) {
      const raised = Math.max(...misses);
      const step = raised >= 100_000 ? 50_000 : 1000;
      const maxPrice = Math.ceil(raised / step) * step;
      budgetSuggestion = {
        maxPrice,
        extra: misses.length,
        label: intent.hinglish
          ? `Budget ${rupees(maxPrice)} tak badhayein to ${misses.length} aur mil jayenge`
          : `Raise budget to ${rupees(maxPrice)} for ${misses.length} more`,
      };
    }
  }

  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = Math.min(q.page, pages);
  const items: SmartResult[] = list.slice((page - 1) * PAGE, page * PAGE).map((x) => ({
    ...toCard(x.row),
    match: {
      score: Math.round(x.s.score * 100) / 100,
      exact: understood && x.s.exact,
      reasons: pickReasons(x.s.reasons),
    },
  }));

  const summary = understood
    ? summaryFor(intent, exactCount, list.length)
    : intent.hinglish
      ? 'Poori baat samajh nahi aayi, isliye nayi listings dikha rahe hain. Area, budget ya BHK likh ke dekhiye.'
      : "We couldn't pick out an area, budget or BHK, so here are the latest listings. Try adding one.";

  if (page === 1 && q.drop.size === 0 && !q.maxPrice) {
    SearchLog.create({
      text: q.q,
      normalized: q.q.toLowerCase().replace(/\s+/g, ' ').trim(),
      deal: intent.listingType,
      understood: keys,
      exactCount,
      resultCount: list.length,
      hinglish: intent.hinglish,
    }).catch((err: unknown) => logger.warn({ err }, 'search log failed'));
  }

  const projectsPath =
    intent.wantsProject && intent.listingType === 'sale'
      ? `/projects?city=${city.slug}${intent.localities[0] ? `&locality=${intent.localities[0].slug}` : ''}${intent.maxPrice ? `&maxPrice=${intent.maxPrice}` : ''}`
      : null;

  return {
    query: q.q,
    understood,
    hinglish: intent.hinglish,
    summary,
    chips: chipsFor(intent),
    filters: filtersFor(intent, city.slug),
    listingType: intent.listingType,
    city: city.slug,
    exactCount,
    total: list.length,
    page,
    pages,
    items,
    budgetSuggestion,
    projectsPath,
  };
}

/* ------------------------------------------------------------------ */
/* Admin: what people search for                                       */
/* ------------------------------------------------------------------ */

export async function searchInsights(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const group = (match: Record<string, unknown>) =>
    SearchLog.aggregate<{
      _id: string;
      count: number;
      last: Date;
      text: string;
      exactCount: number;
      understood: string[];
    }>([
      { $match: { createdAt: { $gte: since }, ...match } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: '$normalized',
          count: { $sum: 1 },
          last: { $first: '$createdAt' },
          text: { $first: '$text' },
          exactCount: { $first: '$exactCount' },
          understood: { $first: '$understood' },
        },
      },
      { $sort: { count: -1, last: -1 } },
      { $limit: 50 },
    ]);
  const [total, noResult, notUnderstood, top, notUnderstoodList, noExactList] = await Promise.all([
    SearchLog.countDocuments({ createdAt: { $gte: since } }),
    SearchLog.countDocuments({ createdAt: { $gte: since }, exactCount: 0 }),
    SearchLog.countDocuments({ createdAt: { $gte: since }, understood: { $size: 0 } }),
    group({}),
    group({ understood: { $size: 0 } }),
    group({ exactCount: 0, 'understood.0': { $exists: true } }),
  ]);
  const row = (r: (typeof top)[number]) => ({
    text: r.text,
    count: r.count,
    lastAt: r.last.toISOString(),
    exactCount: r.exactCount,
    understood: r.understood,
  });
  return {
    days,
    total,
    noExactMatch: noResult,
    notUnderstood,
    top: top.map(row),
    notUnderstoodQueries: notUnderstoodList.map(row),
    noExactQueries: noExactList.map(row),
  };
}
