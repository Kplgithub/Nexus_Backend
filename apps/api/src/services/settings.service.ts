import {
  DEFAULT_HOME_LOAN,
  DEFAULT_SITE_SECTIONS,
  hiddenListingConditions,
  siteSettingsSchema,
  type SiteSection,
  type SiteSettings,
} from '@nexus/shared';
import { SiteSettings as SiteSettingsModel } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { Project } from '../models/project.model.js';

/** Defaults hold only facts the business supplied. Everything else stays empty until approved. */
export const DEFAULT_SETTINGS: SiteSettings = {
  businessName: 'NEXUS Estate',
  tagline: 'Rentals | Properties',
  phone: '+919521750202',
  whatsapp: '+919521750202',
  email: undefined,
  address: { line1: '', line2: '', city: '', state: '', pincode: '' },
  showAddress: false,
  businessHours: '',
  social: {},
  home: {
    heroHeadline: 'Find the Right Space for Your Next Chapter',
    heroSubheadline:
      'Explore residential homes and commercial spaces that fit your needs, lifestyle, and business goals.',
    heroImageUrl: undefined,
    showRecent: true,
    showFeatured: true,
    banners: [],
  },
  allowInternationalEnquiries: false,
  featurePrices: { days7: 49, days30: 99 },
  invoice: { legalName: '', address: '', state: 'Rajasthan', sacCode: '' },
  enquiryNotificationEmail: undefined,
  homeLoan: { ...DEFAULT_HOME_LOAN, lenders: [] },
  sections: { ...DEFAULT_SITE_SECTIONS },
  sectionOffAction: 'redirect',
};

let cache: { value: SiteSettings; at: number } | null = null;
const TTL_MS = 30_000;

export async function getSettings(): Promise<SiteSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const doc = await SiteSettingsModel.findOne({ key: 'site' }).lean();
  const merged = { ...DEFAULT_SETTINGS, ...((doc?.data as Partial<SiteSettings>) ?? {}) };
  merged.home = { ...DEFAULT_SETTINGS.home, ...(merged.home ?? {}) };
  merged.home.banners ??= [];
  merged.featurePrices = { ...DEFAULT_SETTINGS.featurePrices, ...(merged.featurePrices ?? {}) };
  merged.homeLoan = { ...DEFAULT_SETTINGS.homeLoan, ...(merged.homeLoan ?? {}) };
  merged.homeLoan.lenders ??= [];
  merged.homeLoan.ratesCheckedAt ??= null;
  merged.invoice = { ...DEFAULT_SETTINGS.invoice, ...(merged.invoice ?? {}) };
  merged.sections = { ...DEFAULT_SITE_SECTIONS, ...(merged.sections ?? {}) };
  merged.sectionOffAction ??= 'redirect';
  cache = { value: merged, at: Date.now() };
  return merged;
}

/** Public projection — strips admin-only fields and hides the address unless enabled. */
export async function getPublicSettings(): Promise<
  Omit<SiteSettings, 'enquiryNotificationEmail' | 'invoice'>
> {
  const s = await getSettings();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { enquiryNotificationEmail: _hidden, invoice: _invoice, ...rest } = s;
  return s.showAddress
    ? rest
    : {
        ...rest,
        address: {
          line1: '',
          line2: '',
          city: s.address.city,
          state: s.address.state,
          pincode: '',
        },
      };
}

/** The database stores empty optional fields as null; the schema expects them missing. */
function dropNulls<T>(v: T): T {
  if (Array.isArray(v)) return v.map(dropNulls) as T;
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null)
        .map(([k, x]) => [k, dropNulls(x)]),
    ) as T;
  }
  return v;
}

export async function updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const current = dropNulls(await getSettings());
  const next = siteSettingsSchema.parse({
    ...current,
    ...patch,
    home: { ...current.home, ...(patch.home ?? {}) },
    address: { ...current.address, ...(patch.address ?? {}) },
    social: patch.social ?? current.social,
    featurePrices: { ...current.featurePrices, ...(patch.featurePrices ?? {}) },
    homeLoan: { ...current.homeLoan, ...(patch.homeLoan ?? {}) },
    invoice: { ...current.invoice, ...(patch.invoice ?? {}) },
    sections: { ...current.sections, ...(patch.sections ?? {}) },
  });
  await SiteSettingsModel.updateOne({ key: 'site' }, { $set: { data: next } }, { upsert: true });
  cache = null;
  return next as SiteSettings;
}

export function clearSettingsCache() {
  cache = null;
}

/**
 * Extra filter that hides listings of switched-off site sections (Admin → Settings →
 * Site sections). Spread it into every public listing query. Empty when all are on.
 */
export async function sectionListingFilter(): Promise<{ $nor?: Record<string, string>[] }> {
  const hidden = hiddenListingConditions((await getSettings()).sections);
  return hidden.length ? { $nor: hidden } : {};
}

/** Whether the New projects section is on. */
export async function projectsOn(): Promise<boolean> {
  return (await getSettings()).sections.projects !== false;
}

/**
 * Live (published) listings and projects in each site section, for the admin switch panel:
 * how much a switch hides. Counted whether the section is on or off.
 */
export async function sectionCounts(): Promise<Record<SiteSection, number>> {
  const live = { status: 'published' };
  const [buy, rent, pg, plot, commercial, projects] = await Promise.all([
    Property.countDocuments({ ...live, category: 'residential', listingType: 'sale' }),
    Property.countDocuments({ ...live, category: 'residential', listingType: 'rent' }),
    Property.countDocuments({ ...live, propertyType: 'pg' }),
    Property.countDocuments({ ...live, propertyType: 'plot' }),
    Property.countDocuments({ ...live, category: 'commercial' }),
    Project.countDocuments({ status: 'published' }),
  ]);
  return { buy, rent, projects, pg, plot, commercial };
}
