import { Types } from 'mongoose';
import type { ProfileCard, PublicProfile } from '@nexus/shared';
import { User } from '../models/user.model.js';
import { City } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { Project } from '../models/project.model.js';
import { notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';

type Role = 'agent' | 'builder';

type ProfileUser = {
  _id: Types.ObjectId;
  role: Role;
  name: string;
  companyName?: string | null;
  about?: string | null;
  reraNumber?: string | null;
  verified?: boolean;
  premiumUntil?: Date | null;
  experienceYears?: number | null;
  website?: string | null;
  logoUrl?: string | null;
  citySlug?: string | null;
  localities?: string[];
  profileSlug: string;
  showPhone?: boolean;
  createdAt: Date;
};

const LIVE = { status: 'published', listingVisibility: 'public' } as const;
const FIELDS =
  'role name companyName about reraNumber verified premiumUntil experienceYears website logoUrl citySlug localities profileSlug showPhone createdAt';

/** Public page for an agent or builder. Blocked accounts and owners have no public profile. */
export async function getProfile(role: Role, slug: string): Promise<PublicProfile> {
  const u = await User.findOne({ role, profileSlug: slug, status: 'active' })
    .select(FIELDS)
    .lean<ProfileUser>();
  if (!u) throw notFound('Profile not found');
  const [counts, projects, city] = await Promise.all([
    Property.aggregate<{ _id: string; n: number }>([
      { $match: { ...LIVE, postedBy: u._id } },
      { $group: { _id: '$listingType', n: { $sum: 1 } } },
    ]),
    Project.countDocuments({ builder: u._id, status: 'published' }),
    u.citySlug ? City.findOne({ slug: u.citySlug, active: true }).lean() : null,
  ]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  const names = new Map((city?.localities ?? []).map((l) => [l.slug, l.name]));
  return {
    id: String(u._id),
    slug: u.profileSlug,
    role: u.role,
    name: u.name,
    companyName: u.companyName ?? null,
    about: u.about ?? null,
    reraNumber: u.reraNumber ?? null,
    verified: Boolean(u.verified),
    premium: Boolean(u.premiumUntil && new Date(u.premiumUntil) > new Date()),
    experienceYears: u.experienceYears ?? null,
    website: u.website ?? null,
    logoUrl: u.logoUrl ?? null,
    city: city ? { slug: city.slug, name: city.name } : null,
    localities: (u.localities ?? [])
      .filter((l) => names.has(l))
      .map((l) => ({ slug: l, name: names.get(l)! })),
    memberSince: new Date(u.createdAt).toISOString(),
    counts: { sale: by.sale ?? 0, rent: by.rent ?? 0, projects },
    canRevealPhone: Boolean(u.showPhone),
  };
}

/** Directory of agents or builders, verified and busiest first. */
export async function listProfiles(q: {
  role: Role;
  city?: string;
  locality?: string;
  q?: string;
  page: number;
  limit: number;
}): Promise<{ items: ProfileCard[]; meta: ReturnType<typeof paginate> }> {
  const filter: Record<string, unknown> = {
    role: q.role,
    status: 'active',
    profileSlug: { $exists: true, $ne: null },
  };
  if (q.city) filter.citySlug = q.city;
  if (q.locality) filter.localities = q.locality;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { companyName: rx }];
  }
  const users = await User.find(filter)
    .select('role name companyName verified logoUrl experienceYears profileSlug createdAt')
    .lean<ProfileUser[]>();
  const counts = await Property.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { ...LIVE, postedBy: { $in: users.map((u) => u._id) } } },
    { $group: { _id: '$postedBy', n: { $sum: 1 } } },
  ]);
  const n = new Map(counts.map((c) => [String(c._id), c.n]));
  // Profiles with nothing live are hidden from the directory (the page itself still works).
  const ranked = users
    .map((u) => ({ u, listings: n.get(String(u._id)) ?? 0 }))
    .filter((r) => r.listings > 0 || q.role === 'builder')
    .sort(
      (a, b) =>
        Number(Boolean(b.u.verified)) - Number(Boolean(a.u.verified)) || b.listings - a.listings,
    );
  const page = ranked.slice((q.page - 1) * q.limit, q.page * q.limit);
  return {
    items: page.map(({ u, listings }) => ({
      id: String(u._id),
      slug: u.profileSlug,
      role: u.role,
      name: u.name,
      companyName: u.companyName ?? null,
      verified: Boolean(u.verified),
      logoUrl: u.logoUrl ?? null,
      experienceYears: u.experienceYears ?? null,
      listings,
    })),
    meta: paginate(q.page, q.limit, ranked.length),
  };
}

/** Agent and builder pages for the sitemap: only profiles with something live. */
export async function sitemapProfiles() {
  const [posters, builders] = await Promise.all([
    Property.distinct('postedBy', LIVE),
    Project.distinct('builder', { status: 'published' }),
  ]);
  const users = await User.find({
    _id: { $in: [...posters, ...builders] },
    role: { $in: ['agent', 'builder'] },
    status: 'active',
    profileSlug: { $exists: true, $ne: null },
  })
    .select('role profileSlug updatedAt')
    .limit(10_000)
    .lean<{ role: Role; profileSlug: string; updatedAt: Date }[]>();
  return users.map((u) => ({
    path: `/${u.role === 'agent' ? 'agents' : 'builders'}/${u.profileSlug}`,
    updatedAt: new Date(u.updatedAt).toISOString(),
  }));
}
