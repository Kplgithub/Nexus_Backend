import { siteSettingsSchema, type SiteSettings } from '@nexus/shared';
import { SiteSettings as SiteSettingsModel } from '../models/misc.models.js';

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
  },
  allowInternationalEnquiries: false,
  enquiryNotificationEmail: undefined,
};

let cache: { value: SiteSettings; at: number } | null = null;
const TTL_MS = 30_000;

export async function getSettings(): Promise<SiteSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const doc = await SiteSettingsModel.findOne({ key: 'site' }).lean();
  const merged = { ...DEFAULT_SETTINGS, ...((doc?.data as Partial<SiteSettings>) ?? {}) };
  merged.home = { ...DEFAULT_SETTINGS.home, ...(merged.home ?? {}) };
  cache = { value: merged, at: Date.now() };
  return merged;
}

/** Public projection — strips admin-only fields and hides the address unless enabled. */
export async function getPublicSettings(): Promise<Omit<SiteSettings, 'enquiryNotificationEmail'>> {
  const s = await getSettings();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { enquiryNotificationEmail: _hidden, ...rest } = s;
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

export async function updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const current = await getSettings();
  const next = siteSettingsSchema.parse({
    ...current,
    ...patch,
    home: { ...current.home, ...(patch.home ?? {}) },
    address: { ...current.address, ...(patch.address ?? {}) },
    social: patch.social ?? current.social,
  });
  await SiteSettingsModel.updateOne({ key: 'site' }, { $set: { data: next } }, { upsert: true });
  cache = null;
  return next as SiteSettings;
}

export function clearSettingsCache() {
  cache = null;
}
