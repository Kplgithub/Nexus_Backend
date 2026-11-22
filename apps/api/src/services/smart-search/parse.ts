import type {
  Amenity,
  FurnishingStatus,
  ListingType,
  PgGender,
  PlotApproval,
  PreferredTenant,
  PropertyType,
} from '@nexus/shared';
import { isFarmType } from '@nexus/shared';
import { JAIPUR_LANDMARKS } from './landmarks.js';
import { editDistance, hasDevanagari, phoneticKey, toLatin, typoAllowance } from './text.js';

/**
 * Turns whatever a visitor types ("2bhk furnished vaishali ngr 15k tak parking
 * chahiye", "girls PG with food near WTP", "मानसरोवर में 1 बीएचके") into a
 * search intent. Rule based and instant; runs on our server only.
 */

export type Point = { lat: number; lng: number };
export type PlaceRef = { slug: string; name: string; center: Point | null };
export type SearchContext = { localities: PlaceRef[]; deal?: ListingType };

export type Intent = {
  listingType: ListingType;
  /** Where the deal came from: the text, the page the box sits on, or our guess. */
  listingTypeFrom: 'text' | 'page' | 'guess';
  types?: PropertyType[];
  typeLabel?: string;
  bedrooms?: number[];
  minPrice?: number;
  maxPrice?: number;
  furnishing?: FurnishingStatus;
  localities: PlaceRef[];
  near?: { name: string } & Point;
  areaSqft?: number;
  amenities: Amenity[];
  parking?: true;
  pgGender?: Exclude<PgGender, 'any'>;
  pgFood?: true;
  tenant?: Exclude<PreferredTenant, 'any'>;
  ownerOnly?: true;
  verified?: true;
  plotApproval?: PlotApproval;
  availableNow?: true;
  readyToMove?: true;
  cheap?: true;
  wantsProject?: true;
  /** The visitor wrote in Hindi or Hinglish, so we answer the same way. */
  hinglish: boolean;
};

const LAKH = 100_000;
const CRORE = 10_000_000;

/* ------------------------------------------------------------------ */
/* Spelling correction for keywords                                    */
/* ------------------------------------------------------------------ */

const VOCAB = new Set(
  `flat flats apartment apartments house houses villa villas bungalow kothi makan makaan ghar builder floor
  studio plot plots land zameen jameen office offices shop shops showroom warehouse godown coworking hostel
  room rooms rent rental kiraye kiraya kiraaye lease buy sale purchase resale kharidna khareedna kharid
  furnished unfurnished semi parking lift elevator gym swimming pool security guard cctv generator backup
  inverter gated society family bachelor bachelors students student girls boys ladies gents meals food
  tiffin khana verified owner broker brokerage budget under below above upto lakh lakhs crore thousand
  hazar hazaar bedroom bedrooms immediately available ready move near chahiye independent garden balcony
  wifi kitchen modular water supply pipeline clubhouse pets friendly working professionals company cheap
  sasta luxury premium approved corner commercial residential project projects construction possession`
    .split(/\s+/)
    .filter(Boolean),
);
const VOCAB_LIST = [...VOCAB];

/** Everyday words that sit one typo away from a keyword ("good" vs "food", "show" vs "shop"). */
const KEEP = new Set(
  'good show shows best need want find nice home main more less like with near look looking some same mera meri mere mujhe hona chahte'.split(
    ' ',
  ),
);

function correctWord(w: string): string {
  if (w.length < 4 || VOCAB.has(w) || KEEP.has(w) || /\d/.test(w)) return w;
  const allow = w.length <= 9 ? 1 : 2;
  let best = w;
  let bestD = allow + 1;
  for (const v of VOCAB_LIST) {
    if (Math.abs(v.length - w.length) > allow) continue;
    const d = editDistance(w, v, allow);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Places                                                              */
/* ------------------------------------------------------------------ */

const ABBREVIATIONS: Record<string, string> = {
  ngr: 'nagar',
  nager: 'nagar',
  rd: 'road',
  marg: 'marg',
  colny: 'colony',
  clny: 'colony',
  ext: 'extension',
  sch: 'scheme',
  skeem: 'scheme',
  stn: 'station',
};

/** Query words that are never part of a place name. */
const PLACE_STOP = new Set([
  ...VOCAB,
  ...'bhk rk sqft sq ft sft gaj gaz yard yards k l cr tak me mein ke ki ka paas pass in near for with se and or ya aur chahiye chaiye wala wali wale on at of to the a an is hai mujhe mera liye ke paas side around nearby'.split(
    ' ',
  ),
]);

/** Words that never start a place match on their own. */
const GENERIC = new Set(
  'new old near the sector nagar road colony park vihar scheme marg extension enclave lines bazar bazaar market circle gate station metro hospital mall college university area city jaipur'.split(
    ' ',
  ),
);

type PlaceCandidate = {
  key: string;
  exactOnly: boolean;
  locality?: PlaceRef;
  landmark?: { name: string } & Point;
};

function placeCandidates(localities: PlaceRef[]): PlaceCandidate[] {
  const out: PlaceCandidate[] = [];
  for (const l of localities) {
    const words = l.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const full = phoneticKey(words.join(''));
    out.push({ key: full, exactOnly: full.length <= 3, locality: l });
    // "Vaishali" alone means Vaishali Nagar; "Malviya" means Malviya Nagar.
    const first = words[0];
    if (words.length > 1 && first && !GENERIC.has(first) && first.length >= 4) {
      out.push({ key: phoneticKey(first), exactOnly: false, locality: l });
    }
  }
  for (const lm of JAIPUR_LANDMARKS) {
    const point = { name: lm.names[0]!, lat: lm.lat, lng: lm.lng };
    for (const n of lm.names) {
      const key = phoneticKey(n);
      // Short names like "WTP", "SKIT" or "VGU" must be typed exactly.
      out.push({ key, exactOnly: key.length <= 5, landmark: point });
    }
  }
  return out;
}

type Token = { word: string; start: number; end: number };

function tokenize(s: string): Token[] {
  const out: Token[] = [];
  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    const raw = m[0];
    out.push({ word: ABBREVIATIONS[raw] ?? raw, start: m.index!, end: m.index! + raw.length });
  }
  return out;
}

function findPlaces(tokens: Token[], localities: PlaceRef[]) {
  const candidates = placeCandidates(localities);
  type Hit = { from: number; to: number; dist: number; c: PlaceCandidate };
  const hits: Hit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(4, tokens.length - i); n >= 1; n--) {
      const words = tokens.slice(i, i + n).map((t) => t.word);
      if (words.some((w) => PLACE_STOP.has(w))) continue;
      if (n === 1 && GENERIC.has(words[0]!)) continue;
      const key = phoneticKey(words.join(''));
      if (!key) continue;
      const hasDigit = /\d/.test(key);
      for (const c of candidates) {
        // "ajmer road 40" is Ajmer Road plus a budget, not a misspelt place.
        if (hasDigit !== /\d/.test(c.key)) continue;
        if (c.exactOnly) {
          if (key === c.key) hits.push({ from: i, to: i + n, dist: 0, c });
          continue;
        }
        // Typos rarely hit the first letter; insisting on it avoids silly matches.
        if (key[0] !== c.key[0]) continue;
        const allow = typoAllowance(c.key.length);
        const d = editDistance(key, c.key, allow);
        if (d <= allow) hits.push({ from: i, to: i + n, dist: d, c });
      }
    }
  }
  // Longest span first, then fewest typos, then localities over landmarks.
  hits.sort(
    (a, b) =>
      b.to - b.from - (a.to - a.from) ||
      a.dist - b.dist ||
      Number(Boolean(b.c.locality)) - Number(Boolean(a.c.locality)),
  );
  const used = new Set<number>();
  const localitiesFound: PlaceRef[] = [];
  let near: Intent['near'];
  const spans: [number, number][] = [];
  for (const h of hits) {
    let free = true;
    for (let k = h.from; k < h.to; k++) if (used.has(k)) free = false;
    if (!free) continue;
    if (h.c.locality) {
      if (localitiesFound.some((l) => l.slug === h.c.locality!.slug)) continue;
      localitiesFound.push(h.c.locality);
    } else if (h.c.landmark && !near) {
      near = h.c.landmark;
    } else continue;
    for (let k = h.from; k < h.to; k++) used.add(k);
    spans.push([tokens[h.from]!.start, tokens[h.to - 1]!.end]);
  }
  return { localities: localitiesFound, near, spans };
}

/* ------------------------------------------------------------------ */
/* Numbers                                                             */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  ek: 1,
  two: 2,
  do: 2,
  three: 3,
  teen: 3,
  tin: 3,
  four: 4,
  char: 4,
  chaar: 4,
  five: 5,
  paanch: 5,
  panch: 5,
};

const UNIT = String.raw`(k|thousand|hazar|hazaar|hajar|l|lac|lacs|lakh|lakhs|lakhs?|cr|crore|crores|karod|karor)?`;
const AMOUNT = String.raw`(?:rs\.?|₹|inr)?\s*(\d+(?:[.,]\d+)*)\s*${UNIT}\b`;

function toRupees(num: string, unit = ''): number | undefined {
  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const u = unit.toLowerCase();
  if (/^(k|thousand|hazaa?r|hajar)$/.test(u)) return Math.round(n * 1000);
  if (/^(l|lacs?|lakhs?)$/.test(u)) return Math.round(n * LAKH);
  if (/^(cr|crores?|karod|karor)$/.test(u)) return Math.round(n * CRORE);
  return Math.round(n);
}

function parsePrices(t: string): { min?: number; max?: number; rest: string } {
  let rest = t;
  const take = (re: RegExp) => {
    const m = rest.match(re);
    if (m) rest = rest.replace(m[0], ' ');
    return m;
  };
  // "15 se 20 hazar", "15-20k", "between 20 and 30 lakh", "50 lakh to 1 cr"
  const range = take(
    new RegExp(
      String.raw`(?:between|from|budget)?\s*${AMOUNT}\s*(?:-|to|se|and|aur|–)\s*${AMOUNT}(?:\s*(?:ke beech|tak|range))?`,
    ),
  );
  if (range) {
    const hi = toRupees(range[3]!, range[4]);
    let lo = toRupees(range[1]!, range[2] ?? range[4]);
    if (lo && hi && lo > hi && !range[2]) lo = toRupees(range[1]!, range[4]);
    if (lo && hi && hi > lo && hi >= 1000) return { min: lo, max: hi, rest };
    rest = t;
  }
  let max: number | undefined;
  let min: number | undefined;
  // English order: "under 15k"; Hinglish order: "15k tak", "15000 ke andar", "20 lakh se kam"
  const under =
    take(
      new RegExp(
        String.raw`(?:under|below|upto|up to|within|max|maximum|less than|budget(?: of| hai| is)?)\s*${AMOUNT}`,
      ),
    ) ??
    take(
      new RegExp(
        String.raw`${AMOUNT}\s*(?:tak|takk|ke andar|ke under|andar|se kam|or less|max|budget)\b`,
      ),
    );
  if (under) max = toRupees(under[1]!, under[2]);
  const over =
    take(
      new RegExp(
        String.raw`(?:above|over|more than|min|minimum|starting|at least|atleast)\s*${AMOUNT}`,
      ),
    ) ??
    take(
      new RegExp(String.raw`${AMOUNT}\s*(?:se zyada|se jyada|se upar|se oopar|or more|plus|\+)`),
    );
  if (over) min = toRupees(over[1]!, over[2]);
  if (max === undefined && min === undefined) {
    // A bare "15000" or "50 lakh" is almost always the budget.
    for (const m of rest.matchAll(new RegExp(AMOUNT, 'g'))) {
      const v = toRupees(m[1]!, m[2]);
      if (v && (m[2] || v >= 1000)) {
        max = v;
        rest = rest.replace(m[0], ' ');
        break;
      }
    }
  }
  return { min, max, rest };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const TYPE_RULES: [RegExp, PropertyType[], string][] = [
  [/\b(pg|paying guest|hostel)\b/, ['pg'], 'PG'],
  [/\bco-?working\b/, ['coworking'], 'Co-working'],
  [/\bshowrooms?\b/, ['showroom'], 'Showroom'],
  [/\b(shops?|dukaa?n)\b/, ['shop'], 'Shop'],
  [/\b(offices?)\b/, ['office', 'coworking'], 'Office'],
  [/\b(warehouse|godown|godam)\b/, ['warehouse'], 'Warehouse'],
  [/\b(factory|shed)\b/, ['factory-shed'], 'Factory / shed'],
  [/\bfarm ?houses?\b/, ['farmhouse'], 'Farmhouse'],
  [
    /\b(farm ?lands?|kheti|khet|khetee|krishi|krishi bhoomi|agricultural land|agri land|agriculture land)\b/,
    ['farm-land'],
    'Farm land',
  ],
  [/\bfarms?\b/, ['farmhouse', 'farm-land'], 'Farm'],
  [/\bbuilder floor\b/, ['builder-floor'], 'Builder floor'],
  [/\b(villas?|bungalows?)\b/, ['villa'], 'Villa'],
  [/\b(independent house|houses?|kothi|makaa?n|ghar)\b/, ['independent-house', 'villa'], 'House'],
  [/\bstudio\b/, ['studio'], 'Studio'],
  [/\bplots?\b/, ['plot'], 'Plot'],
  [/\b(land|zameen|jameen|zamin|jamin)\b/, ['plot', 'farm-land'], 'Plot or land'],
  [/\b(flats?|apartments?)\b/, ['apartment', 'builder-floor', 'studio'], 'Flat'],
  [/\b(rooms?|kamra|kamre|1 ?rk)\b/, ['studio', 'pg', 'apartment'], 'Room'],
  [
    /\bcommercial\b/,
    ['office', 'shop', 'showroom', 'commercial-building', 'coworking', 'other-commercial'],
    'Commercial',
  ],
];

const AMENITY_RULES: [RegExp, Amenity][] = [
  [/\b(lift|elevator)\b/, 'lift'],
  [/\b(power backup|backup|generator|inverter)\b/, 'power-backup'],
  [/\b(security|guard|chowkidar)\b/, 'security'],
  [/\bcctv\b/, 'cctv'],
  [/\b(gated|society)\b/, 'gated-community'],
  [/\b(24 ?x ?7 water|24 hour water|water supply)\b/, 'water-supply-24x7'],
  [/\bgas pipeline\b/, 'gas-pipeline'],
  [/\b(ac|a c|air condition(ed|er|ing)?)\b/, 'air-conditioning'],
  [/\bmodular kitchen\b/, 'modular-kitchen'],
  [/\b(wifi|wi-fi|internet)\b/, 'wifi'],
  [/\bgym\b/, 'gym'],
  [/\b(swimming pool|pool)\b/, 'swimming-pool'],
  [/\bclub ?house\b/, 'clubhouse'],
  [/\b(garden|park facing)\b/, 'park'],
  [/\b(pets?|dogs?|pet friendly)\b/, 'pet-friendly'],
];

export function parseQuery(input: string, ctx: SearchContext): Intent {
  const hindiScript = hasDevanagari(input);
  const latin = ` ${toLatin(input).replace(/\s+/g, ' ')} `;
  const tokens = tokenize(latin);

  const places = findPlaces(tokens, ctx.localities);
  // Cut the place names out so "22 Godam" or "200 feet road" are not read as prices.
  let rest = latin;
  for (const [a, b] of [...places.spans].sort((x, y) => y[0] - x[0]))
    rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
  rest = ` ${rest
    .replace(/[^a-z0-9₹.,+\-/ ]/g, ' ')
    .split(/\s+/)
    .map((w) => (/^[a-z]+$/.test(w) ? correctWord(ABBREVIATIONS[w] ?? w) : w))
    .join(' ')} `;

  const hinglish =
    hindiScript ||
    /\b(tak|mein|me|chahiye|chaiye|ke|ka|ki|paas|wala|wali|hazaa?r|kiraa?ye|kiraya|ghar|makaa?n|ya|aur|se|kam|andar|hai|dikhao|batao|liye|wale|accha|sasta)\b/.test(
      rest,
    );

  const intent: Intent = {
    listingType: ctx.deal ?? 'rent',
    listingTypeFrom: ctx.deal ? 'page' : 'guess',
    localities: places.localities,
    near: places.near,
    amenities: [],
    hinglish,
  };

  // Area first, so "1200 sqft" or "200 gaj" is not read as a price.
  const area = rest.match(
    /(\d+(?:\.\d+)?)\s*(sq\.? ?ft|sqft|sft|square feet|sq feet|gaj|gaz|sq\.? ?yards?|sq\.? ?yd|sqyd|yards?)\b/,
  );
  if (area) {
    const n = Number(area[1]);
    intent.areaSqft = Math.round(/gaj|gaz|yard|yd/.test(area[2]!) ? n * 9 : n);
    rest = rest.replace(area[0], ' ');
  }

  // "2bhk", "2 bhk", "do bhk", "2/3 bhk", "3 bedroom", "1rk"
  const bhk = rest.match(
    /\b(\d|one|two|three|four|five|ek|do|teen|tin|char|chaar|paanch|panch)\s*(?:(?:\/|or|ya|-|,)\s*(\d))?\s*(bhk|bed|beds|bedroom|bedrooms|bed room|rk|room set)\b/,
  );
  if (bhk) {
    const a = /^\d$/.test(bhk[1]!) ? Number(bhk[1]) : NUMBER_WORDS[bhk[1]!]!;
    const list = [a];
    if (bhk[2]) for (let n = a + 1; n <= Number(bhk[2]); n++) list.push(n);
    intent.bedrooms = list;
    if (bhk[3] === 'rk') {
      intent.types = ['studio', 'apartment'];
      intent.typeLabel = '1 RK';
    }
    rest = rest.replace(bhk[0], ' ');
  }

  if (!intent.types) {
    for (const [re, types, label] of TYPE_RULES) {
      if (re.test(rest)) {
        intent.types = types;
        intent.typeLabel = label;
        if (label === 'Room' && !intent.bedrooms) intent.bedrooms = [1];
        break;
      }
    }
  }

  const rentWords =
    /\b(rent|rental|lease|kiraa?ye|kiraya|to let|tolet|on rent|rent pe|rent par)\b/.test(rest);
  const buyWords =
    /\b(buy|sale|purchase|resale|kharid\w*|khareed\w*|bikau|for sale|lena hai)\b/.test(rest);
  if (rentWords !== buyWords) {
    intent.listingType = rentWords ? 'rent' : 'sale';
    intent.listingTypeFrom = 'text';
  } else if (intent.types?.[0] === 'pg') {
    intent.listingType = 'rent';
    intent.listingTypeFrom = 'text';
  }
  // Farms are listed for sale only.
  if (intent.types?.length && intent.types.every((t) => isFarmType(t))) {
    intent.listingType = 'sale';
    intent.listingTypeFrom = 'text';
  }

  const prices = parsePrices(rest);
  rest = prices.rest;
  intent.minPrice = prices.min;
  intent.maxPrice = prices.max;
  if (intent.minPrice && intent.maxPrice && intent.minPrice > intent.maxPrice)
    [intent.minPrice, intent.maxPrice] = [intent.maxPrice, intent.minPrice];
  // Without a deal word, the budget tells us: ₹15,000 is rent, ₹50 lakh is a purchase.
  if (intent.listingTypeFrom !== 'text') {
    const budget = intent.maxPrice ?? intent.minPrice;
    if (budget !== undefined && intent.types?.[0] !== 'pg') {
      const guess: ListingType =
        budget >= 5 * LAKH ? 'sale' : budget <= 2 * LAKH ? 'rent' : intent.listingType;
      if (guess !== intent.listingType || intent.listingTypeFrom === 'guess') {
        intent.listingType = guess;
        intent.listingTypeFrom = 'guess';
      }
    }
  }

  intent.furnishing = /\bsemi\b/.test(rest)
    ? 'semi-furnished'
    : /\b(unfurnished|un furnished|without furniture|bina furniture|khali)\b/.test(rest)
      ? 'unfurnished'
      : /\b(fully furnished|furnished|furniture ke sath|furniture wala|with furniture)\b/.test(rest)
        ? 'furnished'
        : undefined;

  for (const [re, a] of AMENITY_RULES) if (re.test(rest)) intent.amenities.push(a);
  if (/\b(parking|car parking|garage|gaadi|gadi|car)\b/.test(rest)) intent.parking = true;

  if (/\b(girls?|ladies|women|female|ladkiyo\w*|ladki)\b/.test(rest)) intent.pgGender = 'female';
  else if (/\b(boys?|gents|men|male|ladko\w*|ladke)\b/.test(rest)) intent.pgGender = 'male';
  if (intent.pgGender && !intent.types) {
    intent.types = ['pg'];
    intent.typeLabel = 'PG';
    intent.listingType = 'rent';
  }
  if (/\b(meals?|food|khana|tiffin|bhojan|with food)\b/.test(rest)) intent.pgFood = true;

  if (/\b(family|families|parivar)\b/.test(rest)) intent.tenant = 'family';
  else if (/\b(bachelors?|singles?)\b/.test(rest)) intent.tenant = 'bachelors';
  else if (/\b(students?)\b/.test(rest)) intent.tenant = 'students';
  else if (/\b(company lease|corporate)\b/.test(rest)) intent.tenant = 'company';

  if (/\b(owner|no broker|without broker|bina broker|bina dalal|direct)\b/.test(rest))
    intent.ownerOnly = true;
  if (/\bverified\b/.test(rest)) intent.verified = true;
  if (/\bjda\b/.test(rest)) intent.plotApproval = 'jda';
  else if (/\brhb\b/.test(rest)) intent.plotApproval = 'rhb';
  if (intent.plotApproval && !intent.types) {
    intent.types = ['plot'];
    intent.typeLabel = 'Plot';
  }
  if (/\b(immediate\w*|turant|abhi|available now|asap)\b/.test(rest)) intent.availableNow = true;
  if (/\bready to move\b|\bready\b/.test(rest)) intent.readyToMove = true;
  if (/\b(cheap|cheapest|sasta|saste|sasti|low budget|budget wala|affordable)\b/.test(rest))
    intent.cheap = true;
  if (/\b(new projects?|under construction|pre-?launch|new launch)\b/.test(rest))
    intent.wantsProject = true;

  return intent;
}

/** Keys of what we understood, for logging and the "nothing understood" check. */
export function understoodKeys(i: Intent): string[] {
  const k: string[] = [];
  if (i.listingTypeFrom === 'text') k.push('deal');
  if (i.types) k.push('type');
  if (i.bedrooms) k.push('bedrooms');
  if (i.minPrice || i.maxPrice) k.push('budget');
  if (i.furnishing) k.push('furnishing');
  for (const l of i.localities) k.push(`locality:${l.slug}`);
  if (i.near) k.push('near');
  if (i.areaSqft) k.push('area');
  for (const a of i.amenities) k.push(`amenity:${a}`);
  if (i.parking) k.push('parking');
  if (i.pgGender) k.push('pgGender');
  if (i.pgFood) k.push('pgFood');
  if (i.tenant) k.push('tenant');
  if (i.ownerOnly) k.push('owner');
  if (i.verified) k.push('verified');
  if (i.plotApproval) k.push('plotApproval');
  if (i.availableNow) k.push('availableNow');
  if (i.readyToMove) k.push('ready');
  if (i.cheap) k.push('cheap');
  return k;
}
