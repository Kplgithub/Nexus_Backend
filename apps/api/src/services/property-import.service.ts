/**
 * Bulk import of listings from a CSV sheet (brokers and owners usually keep
 * their stock in Excel). Every imported row becomes a draft: staff add the
 * broker's or owner's photos in the editor and publish it from there.
 */
import {
  AMENITIES,
  AREA_UNITS,
  CATEGORIES,
  FURNISHING_STATUSES,
  LISTING_TYPES,
  PARKING_OPTIONS,
  PREFERRED_TENANTS,
  PROPERTY_TYPES,
  PROPERTY_TYPE_LABELS,
  FURNISHING_LABELS,
  propertyCreateSchema,
  slugify,
  type PropertyCreate,
  type PropertyType,
} from '@nexus/shared';
import { City } from '../models/misc.models.js';
import { badRequest } from '../lib/errors.js';
import { parseCsv, toCsv } from '../lib/csv.js';
import { createProperty } from './property.service.js';

export const IMPORT_MAX_ROWS = 200;

/** Template columns, in order. Header matching ignores case, spaces and punctuation. */
export const IMPORT_COLUMNS = [
  'listing_type',
  'property_type',
  'bhk',
  'bathrooms',
  'balconies',
  'city',
  'locality',
  'address',
  'pincode',
  'rent_or_price',
  'deposit',
  'maintenance',
  'area',
  'area_unit',
  'furnishing',
  'floor',
  'total_floors',
  'facing',
  'parking',
  'tenants',
  'amenities',
  'available_from',
  'title',
  'description',
  'owner_contact',
  'notes',
] as const;

const HEADER_ALIASES: Record<string, string> = {
  type: 'property_type',
  bedrooms: 'bhk',
  beds: 'bhk',
  baths: 'bathrooms',
  area_name: 'locality',
  colony: 'locality',
  rent: 'rent_or_price',
  price: 'rent_or_price',
  security_deposit: 'deposit',
  area_value: 'area',
  size: 'area',
  unit: 'area_unit',
  furnished: 'furnishing',
  floor_number: 'floor',
  preferred_tenants: 'tenants',
  available: 'available_from',
  contact: 'owner_contact',
  owner: 'owner_contact',
  broker: 'owner_contact',
  internal_notes: 'notes',
};

const TYPE_ALIASES: Record<string, PropertyType> = {
  flat: 'apartment',
  apartment: 'apartment',
  'apartment-flat': 'apartment',
  house: 'independent-house',
  kothi: 'independent-house',
  'independent-house': 'independent-house',
  'builder-floor': 'builder-floor',
  floor: 'builder-floor',
  villa: 'villa',
  bungalow: 'villa',
  studio: 'studio',
  '1rk': 'studio',
  rk: 'studio',
  pg: 'pg',
  hostel: 'pg',
  plot: 'plot',
  farmhouse: 'farmhouse',
  'farm-house': 'farmhouse',
  farm: 'farm-land',
  'farm-land': 'farm-land',
  farmland: 'farm-land',
  'agricultural-land': 'farm-land',
  office: 'office',
  shop: 'shop',
  showroom: 'showroom',
  coworking: 'coworking',
  warehouse: 'warehouse',
  godown: 'warehouse',
};

const UNIT_ALIASES: Record<string, (typeof AREA_UNITS)[number]> = {
  sqft: 'sqft',
  'sq-ft': 'sqft',
  ft: 'sqft',
  sqyd: 'sqyd',
  'sq-yd': 'sqyd',
  yd: 'sqyd',
  gaj: 'sqyd',
  sqm: 'sqm',
  'sq-m': 'sqm',
  bigha: 'bigha',
  acre: 'acre',
  acres: 'acre',
};

const FURNISHING_ALIASES: Record<string, (typeof FURNISHING_STATUSES)[number]> = {
  unfurnished: 'unfurnished',
  no: 'unfurnished',
  none: 'unfurnished',
  semi: 'semi-furnished',
  'semi-furnished': 'semi-furnished',
  furnished: 'furnished',
  full: 'furnished',
  'fully-furnished': 'furnished',
};

export type CityLookup = {
  name: string;
  slug: string;
  localities: { name: string; slug: string }[];
};

export type ImportRowResult =
  | {
      row: number;
      ok: true;
      title: string;
      locality: string;
      price: number;
      listingType: 'rent' | 'sale';
      id?: string;
      slug?: string;
    }
  | { row: number; ok: false; errors: string[] };

const headerKey = (h: string) => {
  const k = h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return HEADER_ALIASES[k] ?? k;
};

/** "25,000", "₹25000", "25k", "1.2 lakh", "1.5 cr" → whole rupees. */
export function parseMoney(raw: string): number | null {
  const s = raw.toLowerCase().replace(/[₹,\s]|rs\.?|inr|\/-|per\s*month|pm/g, '');
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k|l|lac|lakh|lakhs|cr|crore|crores)?$/.exec(s);
  if (!m) return NaN;
  const mult = !m[2] ? 1 : m[2] === 'k' ? 1_000 : m[2].startsWith('c') ? 10_000_000 : 100_000;
  return Math.round(Number(m[1]) * mult);
}

function parseInt0(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s === 'ground' || s === 'g') return 0;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && /\d/.test(s) ? Math.round(n) : NaN;
}

/** YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY; "now"/"immediate" means today. */
function parseDate(raw: string): Date | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (['now', 'immediate', 'immediately', 'ready'].includes(s)) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(+m[3]!, +m[2]! - 1, +m[1]!));
  return new Date(NaN);
}

const list = (raw: string) =>
  raw
    .split(/[;,|]/)
    .map((v) => slugify(v.trim()))
    .filter(Boolean);

function pick<T extends string>(
  raw: string,
  allowed: readonly T[],
  aliases: Record<string, T> = {},
): T | undefined | null {
  const k = slugify(raw.trim());
  if (!k) return undefined;
  if (aliases[k]) return aliases[k];
  return (allowed as readonly string[]).includes(k) ? (k as T) : null;
}

/**
 * Turn one sheet row into create-input. Pure (no database), so it is unit
 * tested on its own; schema validation happens afterwards.
 */
export function mapImportRow(
  row: Record<string, string>,
  cities: CityLookup[],
): { input: Record<string, unknown>; errors: string[] } {
  const errors: string[] = [];
  const v = (k: string) => (row[k] ?? '').trim();
  const input: Record<string, unknown> = { status: 'draft', images: [] };

  const listingType = pick(v('listing_type') || 'rent', LISTING_TYPES, {
    buy: 'sale',
    sell: 'sale',
    rental: 'rent',
  });
  if (!listingType) errors.push(`listing_type: use "rent" or "sale"`);
  else input.listingType = listingType;

  const rawType = v('property_type') || 'apartment';
  const propertyType =
    TYPE_ALIASES[slugify(rawType)] ??
    pick(rawType, Object.keys(PROPERTY_TYPE_LABELS) as PropertyType[]);
  if (!propertyType) errors.push(`property_type: "${rawType}" is not a known type`);
  else {
    input.propertyType = propertyType;
    input.category = CATEGORIES.find((c) =>
      (PROPERTY_TYPES[c] as readonly string[]).includes(propertyType),
    );
  }

  const cityRaw = v('city') || 'jaipur';
  const city = cities.find(
    (c) => c.slug === slugify(cityRaw) || c.name.toLowerCase() === cityRaw.toLowerCase(),
  );
  if (!city) errors.push(`city: "${cityRaw}" is not set up under Locations`);
  const locRaw = v('locality');
  if (!locRaw) errors.push('locality: required');
  const locality = city?.localities.find(
    (l) => l.slug === slugify(locRaw) || l.name.toLowerCase() === locRaw.toLowerCase(),
  );
  if (city && locRaw && !locality) {
    errors.push(`locality: "${locRaw}" is not set up under Locations for ${city.name}`);
  }
  if (city) input.citySlug = city.slug;
  if (locality) input.localitySlug = locality.slug;

  const num = (key: string, field: string) => {
    const n = parseInt0(v(key));
    if (Number.isNaN(n)) errors.push(`${key}: "${v(key)}" is not a number`);
    else if (n !== null) input[field] = n;
  };
  num('bhk', 'bedrooms');
  num('bathrooms', 'bathrooms');
  num('balconies', 'balconies');
  num('floor', 'floorNumber');
  num('total_floors', 'totalFloors');

  const money = (key: string, field: string) => {
    const n = parseMoney(v(key));
    if (Number.isNaN(n)) errors.push(`${key}: "${v(key)}" is not an amount`);
    else if (n !== null) input[field] = n;
  };
  money('rent_or_price', 'price');
  if (!v('rent_or_price')) errors.push('rent_or_price: required');
  money('deposit', 'securityDeposit');
  money('maintenance', 'maintenanceCharges');

  const area = Number(v('area').replace(/,/g, ''));
  if (!v('area')) errors.push('area: required');
  else if (!Number.isFinite(area) || area <= 0) errors.push(`area: "${v('area')}" is not a size`);
  else input.areaValue = area;
  const unit = pick(v('area_unit') || 'sqft', AREA_UNITS, UNIT_ALIASES);
  if (!unit) errors.push(`area_unit: use sqft, sqyd (gaj) or sqm`);
  else input.areaUnit = unit;

  const furnishing = pick(
    v('furnishing') || 'unfurnished',
    FURNISHING_STATUSES,
    FURNISHING_ALIASES,
  );
  if (!furnishing) errors.push('furnishing: use unfurnished, semi or furnished');
  else input.furnishingStatus = furnishing;

  if (v('parking')) {
    const parking = pick(v('parking'), PARKING_OPTIONS, { yes: 'car', 'two-wheeler': 'bike' });
    if (!parking) errors.push(`parking: use one of ${PARKING_OPTIONS.join(', ')}`);
    else input.parking = parking;
  }

  const tenants = list(v('tenants')).map((t) =>
    t === 'bachelor' || t === 'bachelors-only' ? 'bachelors' : t === 'families' ? 'family' : t,
  );
  const badTenants = tenants.filter((t) => !(PREFERRED_TENANTS as readonly string[]).includes(t));
  if (badTenants.length) errors.push(`tenants: unknown "${badTenants.join(', ')}"`);
  else if (tenants.length) input.preferredTenants = [...new Set(tenants)];

  const amenities = list(v('amenities'));
  const badAmenities = amenities.filter((a) => !(AMENITIES as readonly string[]).includes(a));
  if (badAmenities.length) errors.push(`amenities: unknown "${badAmenities.join(', ')}"`);
  else if (amenities.length) input.amenities = [...new Set(amenities)];

  const avail = parseDate(v('available_from'));
  if (avail && Number.isNaN(avail.getTime())) {
    errors.push('available_from: use YYYY-MM-DD or DD-MM-YYYY');
  } else if (avail) input.availableFrom = avail;

  for (const [key, field] of [
    ['address', 'approvedAddress'],
    ['pincode', 'pincode'],
    ['facing', 'facing'],
    ['owner_contact', 'ownerReference'],
    ['notes', 'internalNotes'],
  ] as const) {
    if (v(key)) input[field] = v(key);
  }

  // Brokers rarely write copy: build a plain title and description from the facts.
  const typeLabel = propertyType ? PROPERTY_TYPE_LABELS[propertyType] : 'Property';
  const beds =
    typeof input.bedrooms === 'number' && input.bedrooms > 0 ? `${input.bedrooms} BHK ` : '';
  const deal = listingType === 'sale' ? 'for Sale' : 'for Rent';
  const place = [locality?.name, city?.name].filter(Boolean).join(', ');
  input.title =
    v('title') || `${beds}${typeLabel} ${deal} in ${locality?.name ?? city?.name ?? ''}`.trim();
  if (v('description')) input.description = v('description');
  else {
    const bits = [
      `${beds}${typeLabel.toLowerCase()} available ${deal.toLowerCase()} in ${place}.`,
      input.areaValue ? `Area ${input.areaValue} ${unit ?? 'sqft'}.` : '',
      furnishing ? `${FURNISHING_LABELS[furnishing]}.` : '',
      v('address') ? `Location: ${v('address')}.` : '',
    ];
    input.description = bits.filter(Boolean).join(' ');
  }

  return { input, errors };
}

function rowsFromCsv(csv: string): Record<string, string>[] {
  const table = parseCsv(csv);
  if (table.length < 2)
    throw badRequest('The sheet has no rows. Keep the header row and add listings below it.');
  const headers = table[0]!.map(headerKey);
  if (!headers.includes('locality')) {
    throw badRequest('Missing the "locality" column. Download the template and use its headers.');
  }
  return table
    .slice(1)
    .map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()])));
}

/**
 * Validate every row, then (unless dryRun) create the valid ones as drafts.
 * Invalid rows are reported and skipped, so one typo doesn't block the sheet.
 */
export async function importProperties(
  csv: string,
  opts: { dryRun: boolean; adminId: string },
): Promise<{ total: number; valid: number; created: number; results: ImportRowResult[] }> {
  const rows = rowsFromCsv(csv);
  if (rows.length > IMPORT_MAX_ROWS) {
    throw badRequest(`Up to ${IMPORT_MAX_ROWS} listings per sheet. Split it into smaller files.`);
  }
  const cities = await City.find(
    {},
    { name: 1, slug: 1, 'localities.name': 1, 'localities.slug': 1 },
  ).lean<CityLookup[]>();

  const checked = rows.map((row, i) => {
    const { input, errors } = mapImportRow(row, cities);
    const parsed = propertyCreateSchema.safeParse(input);
    if (!parsed.success && !errors.length) {
      for (const issue of parsed.error.issues) {
        errors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
      }
    }
    // Header row is row 1 in the spreadsheet, so data starts at row 2.
    return { row: i + 2, errors, data: parsed.success ? parsed.data : null, input };
  });

  const results: ImportRowResult[] = [];
  let created = 0;
  for (const c of checked) {
    if (c.errors.length || !c.data) {
      results.push({ row: c.row, ok: false, errors: c.errors });
      continue;
    }
    const base = {
      row: c.row,
      ok: true as const,
      title: c.data.title,
      locality: String(c.input.localitySlug),
      price: c.data.price,
      listingType: c.data.listingType,
    };
    if (opts.dryRun) {
      results.push(base);
      continue;
    }
    try {
      const p = await createProperty(c.data as PropertyCreate, opts.adminId);
      created++;
      results.push({ ...base, id: p.id, slug: p.slug });
    } catch (err) {
      results.push({
        row: c.row,
        ok: false,
        errors: [err instanceof Error ? err.message : 'Could not save'],
      });
    }
  }
  return {
    total: rows.length,
    valid: checked.filter((c) => !c.errors.length && c.data).length,
    created,
    results,
  };
}

/** Blank template with two example rows, ready to open in Excel or Google Sheets. */
export function importTemplateCsv(): string {
  return toCsv(
    [...IMPORT_COLUMNS],
    [
      [
        'rent',
        'apartment',
        2,
        2,
        1,
        'Jaipur',
        'Vaishali Nagar',
        'Near Gandhi Path',
        '302021',
        '18000',
        '36000',
        '1500',
        1100,
        'sqft',
        'semi',
        2,
        4,
        'East',
        'car',
        'family',
        'lift; power-backup; security',
        'now',
        '',
        '',
        'Ramesh Sharma (broker) 98xxxxxx10',
        '',
      ],
      [
        'rent',
        'independent-house',
        3,
        3,
        2,
        'Jaipur',
        'Malviya Nagar',
        '',
        '',
        '35k',
        '70k',
        '',
        200,
        'gaj',
        'furnished',
        0,
        2,
        'North',
        'covered',
        'family; company',
        'park; cctv',
        '15-11-2026',
        '',
        '',
        'Owner: Sunita Jain 97xxxxxx22',
        'Keys with guard',
      ],
    ],
  );
}
