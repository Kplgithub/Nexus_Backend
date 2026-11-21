import { AMENITY_LABELS, type PropertyType } from '@nexus/shared';
import type { Intent, Point } from './parse.js';
import { km } from './text.js';

/**
 * Scores each listing against the intent instead of filtering it out: a flat
 * ₹1,000 over budget or one street outside the locality is still a good answer.
 */

export type MatchLevel = 'yes' | 'near' | 'no';
export type MatchReason = { label: string; level: MatchLevel };

export type Candidate = {
  price: number;
  localitySlug: string;
  localityName: string;
  geo?: { coordinates?: number[] | null } | null;
  bedrooms?: number | null;
  propertyType: PropertyType;
  furnishingStatus?: string | null;
  areaSqft?: number | null;
  amenities?: string[] | null;
  parking?: string | null;
  pgGender?: string | null;
  pgFoodIncluded?: boolean | null;
  preferredTenants?: string[] | null;
  posterType?: string | null;
  verified?: boolean | null;
  plotApproval?: string | null;
  availableFrom?: Date | null;
  possessionStatus?: string | null;
};

export type Scored = {
  /** 0 to 1: share of what was asked that this listing meets. */
  score: number;
  exact: boolean;
  /** Far outside the budget: only shown when nothing better exists. */
  outOfBudget: boolean;
  /** Fails only on budget, and by at most 25%: the "raise your budget" suggestion. */
  onlyBudgetMiss?: number;
  reasons: MatchReason[];
};

const fmt = (n: number) =>
  n >= 10_000_000
    ? `₹${+(n / 10_000_000).toFixed(2)} Cr`
    : n >= 100_000
      ? `₹${+(n / 100_000).toFixed(2)} L`
      : `₹${n.toLocaleString('en-IN')}`;

const HOME_TYPES = new Set<PropertyType>([
  'apartment',
  'builder-floor',
  'independent-house',
  'villa',
  'studio',
]);

export function scoreListing(
  c: Candidate,
  intent: Intent,
  localityCenters: Map<string, Point>,
): Scored {
  let got = 0;
  let max = 0;
  let budgetMiss: number | undefined;
  let otherMiss = false;
  let outOfBudget = false;
  const reasons: MatchReason[] = [];
  const add = (weight: number, share: number, reason?: MatchReason, isBudget = false) => {
    max += weight;
    got += weight * share;
    if (reason) reasons.push(reason);
    if (share < 1 && !isBudget) otherMiss = true;
  };

  /* Location */
  if (intent.localities.length || intent.near) {
    const where =
      (c.geo?.coordinates?.length === 2
        ? { lat: c.geo.coordinates[1]!, lng: c.geo.coordinates[0]! }
        : null) ??
      localityCenters.get(c.localitySlug) ??
      null;
    if (intent.localities.some((l) => l.slug === c.localitySlug)) {
      add(30, 1, { label: c.localityName, level: 'yes' });
    } else {
      const targets: { name: string; p: Point; landmark: boolean }[] = [];
      for (const l of intent.localities)
        if (l.center) targets.push({ name: l.name, p: l.center, landmark: false });
      if (intent.near) targets.push({ name: intent.near.name, p: intent.near, landmark: true });
      let best: { d: number; name: string; landmark: boolean } | null = null;
      if (where)
        for (const t of targets) {
          const d = km(where, t.p);
          if (!best || d < best.d) best = { d, name: t.name, landmark: t.landmark };
        }
      if (!best) add(30, 0, { label: c.localityName, level: 'no' });
      else {
        const d = best.d;
        // Being 1 km from a landmark is a full match; 1 km outside a locality is close.
        const share = best.landmark
          ? d <= 1.5
            ? 1
            : d <= 3
              ? 0.75
              : d <= 5
                ? 0.45
                : 0
          : d <= 1.5
            ? 0.8
            : d <= 3
              ? 0.6
              : d <= 5
                ? 0.35
                : 0;
        const label = `${d < 1 ? `${Math.max(1, Math.round(d * 10)) * 100} m` : `${d.toFixed(1)} km`} from ${best.name}`;
        add(30, share, { label, level: share >= 1 ? 'yes' : share > 0 ? 'near' : 'no' });
      }
    }
  }

  /* Budget */
  if (intent.maxPrice || intent.minPrice) {
    const hi = intent.maxPrice;
    const lo = intent.minPrice;
    let share = 1;
    let label = 'In budget';
    if (hi && c.price > hi) {
      const over = (c.price - hi) / hi;
      share = over <= 0.1 ? 0.7 : over <= 0.2 ? 0.45 : over <= 0.35 ? 0.2 : 0;
      label = `${fmt(c.price - hi)} over budget`;
      if (over <= 0.25) budgetMiss = c.price;
    } else if (lo && c.price < lo) {
      const under = (lo - c.price) / lo;
      share = under <= 0.15 ? 0.7 : under <= 0.3 ? 0.4 : 0.1;
      label = `${fmt(lo - c.price)} below your range`;
    }
    if (share === 0) outOfBudget = true;
    add(30, share, { label, level: share >= 1 ? 'yes' : share > 0.3 ? 'near' : 'no' }, true);
  }

  /* Bedrooms */
  if (intent.bedrooms?.length && c.propertyType !== 'pg') {
    const b = c.bedrooms ?? 0;
    const want = intent.bedrooms;
    const share = want.includes(b)
      ? 1
      : b === Math.max(...want) + 1
        ? 0.5
        : b === Math.min(...want) - 1
          ? 0.35
          : 0;
    add(20, share, {
      label: b ? `${b} BHK` : 'Bedrooms not listed',
      level: share >= 1 ? 'yes' : share > 0 ? 'near' : 'no',
    });
  }

  /* Type */
  if (intent.types?.length) {
    const exact = intent.types.includes(c.propertyType);
    const sibling =
      !exact && HOME_TYPES.has(c.propertyType) && intent.types.some((t) => HOME_TYPES.has(t));
    add(10, exact ? 1 : sibling ? 0.5 : 0);
  }

  /* Furnishing */
  if (intent.furnishing) {
    const f = c.furnishingStatus;
    const share =
      f === intent.furnishing
        ? 1
        : (f === 'semi-furnished' && intent.furnishing === 'furnished') ||
            (f === 'furnished' && intent.furnishing === 'semi-furnished')
          ? 0.5
          : 0;
    const label =
      f === 'furnished'
        ? 'Furnished'
        : f === 'semi-furnished'
          ? 'Semi-furnished'
          : f === 'unfurnished'
            ? 'Unfurnished'
            : 'Furnishing not listed';
    add(10, share, { label, level: share >= 1 ? 'yes' : share > 0 ? 'near' : 'no' });
  }

  /* Area */
  if (intent.areaSqft && c.areaSqft) {
    const diff = Math.abs(c.areaSqft - intent.areaSqft) / intent.areaSqft;
    const share = diff <= 0.15 ? 1 : diff <= 0.3 ? 0.5 : 0;
    add(10, share, {
      label: `${c.areaSqft.toLocaleString('en-IN')} sq ft`,
      level: share >= 1 ? 'yes' : share > 0 ? 'near' : 'no',
    });
  }

  /* Smaller asks: each is worth a little */
  for (const a of intent.amenities) {
    const has = Boolean(c.amenities?.includes(a));
    add(4, has ? 1 : 0, has ? { label: AMENITY_LABELS[a], level: 'yes' } : undefined);
  }
  if (intent.parking) {
    const has = Boolean(c.parking && c.parking !== 'none');
    add(6, has ? 1 : 0, { label: has ? 'Parking' : 'No parking', level: has ? 'yes' : 'no' });
  }
  if (intent.pgGender && c.propertyType === 'pg') {
    const ok = c.pgGender === intent.pgGender || c.pgGender === 'any';
    add(12, ok ? 1 : 0, {
      label: intent.pgGender === 'female' ? 'For girls' : 'For boys',
      level: ok ? 'yes' : 'no',
    });
  }
  if (intent.pgFood)
    add(
      6,
      c.pgFoodIncluded ? 1 : 0,
      c.pgFoodIncluded ? { label: 'Meals included', level: 'yes' } : undefined,
    );
  if (intent.tenant) {
    const ok =
      !c.preferredTenants?.length ||
      c.preferredTenants.includes('any') ||
      c.preferredTenants.includes(intent.tenant);
    add(6, ok ? 1 : 0);
  }
  if (intent.ownerOnly)
    add(
      6,
      c.posterType === 'owner' ? 1 : 0,
      c.posterType === 'owner' ? { label: 'Direct owner', level: 'yes' } : undefined,
    );
  if (intent.verified)
    add(4, c.verified ? 1 : 0, c.verified ? { label: 'Verified', level: 'yes' } : undefined);
  if (intent.plotApproval) {
    const ok = c.plotApproval === intent.plotApproval;
    add(
      8,
      ok ? 1 : 0,
      ok ? { label: `${intent.plotApproval.toUpperCase()} approved`, level: 'yes' } : undefined,
    );
  }
  if (intent.availableNow) {
    const ok = !c.availableFrom || new Date(c.availableFrom) <= new Date();
    add(4, ok ? 1 : 0, ok ? { label: 'Available now', level: 'yes' } : undefined);
  }
  if (intent.readyToMove && intent.listingType === 'sale')
    add(6, c.possessionStatus !== 'under-construction' ? 1 : 0);

  if (max === 0) return { score: 1, exact: true, outOfBudget, reasons };
  const score = got / max;
  const exact = got >= max - 1e-9;
  // Show what matched first, then what is close, then what does not.
  const order: Record<MatchLevel, number> = { yes: 0, near: 1, no: 2 };
  reasons.sort((a, b) => order[a.level] - order[b.level]);
  return {
    score,
    exact,
    outOfBudget,
    reasons,
    onlyBudgetMiss: !exact && !otherMiss && budgetMiss !== undefined ? budgetMiss : undefined,
  };
}
