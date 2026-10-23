import { AREA_TO_SQFT, AREA_UNIT_LABELS, type AreaUnit } from './constants.js';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** ₹25,000 — Indian digit grouping, no paise. */
export function formatINR(amount: number): string {
  return inr.format(amount);
}

const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, '');

/** Indian short form: ₹85,000 · ₹45 L · ₹1.25 Cr. */
export function formatINRShort(amount: number): string {
  if (amount >= 10_000_000) return `₹${trim(amount / 10_000_000)} Cr`;
  if (amount >= 100_000) return `₹${trim(amount / 100_000)} L`;
  return formatINR(amount);
}

/** Compact rent label: ₹25,000/month, or ₹1.2 L/month for large values. */
export function formatRent(amount: number): string {
  return `${formatINRShort(amount)}/month`;
}

/** Price label for a listing: "₹25,000/month" for rent, "₹45 L" for sale. */
export function formatPrice(amount: number, listingType: 'rent' | 'sale'): string {
  return listingType === 'rent' ? formatRent(amount) : formatINRShort(amount);
}

/** Price per square foot for sale listings, rounded to the rupee. */
export function pricePerSqft(price: number, areaSqft: number): number | null {
  return areaSqft > 0 ? Math.round(price / areaSqft) : null;
}

export function formatArea(value: number, unit: AreaUnit): string {
  return `${new Intl.NumberFormat('en-IN').format(value)} ${AREA_UNIT_LABELS[unit]}`;
}

export function toSqft(value: number, unit: AreaUnit): number {
  return Math.round(value * AREA_TO_SQFT[unit]);
}

export function floorLabel(floor: number | null | undefined, total?: number | null): string | null {
  if (floor === null || floor === undefined) return null;
  const name =
    floor === 0
      ? 'Ground floor'
      : floor < 0
        ? `Basement ${Math.abs(floor)}`
        : `${ordinal(floor)} floor`;
  return total ? `${name} of ${total}` : name;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "₹45 L – ₹1.2 Cr", or a single value when both ends match. */
export function formatPriceRange(min: number, max: number): string {
  const a = formatINRShort(min);
  const b = formatINRShort(max);
  return a === b ? a : `${a} – ${b}`;
}

/** Monthly EMI for a loan, rounded to the rupee. `annualRatePct` e.g. 8.5. */
export function emi(principal: number, annualRatePct: number, years: number): number {
  const n = Math.round(years * 12);
  if (principal <= 0 || n <= 0) return 0;
  const r = annualRatePct / 12 / 100;
  if (r === 0) return Math.round(principal / n);
  const f = Math.pow(1 + r, n);
  return Math.round((principal * r * f) / (f - 1));
}

/** The video id from a YouTube watch, share or shorts link; null for anything else. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{6,20})/);
  return m ? m[1]! : null;
}

/** Median of a list of numbers; null when empty. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}
