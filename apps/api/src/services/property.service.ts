import type { FilterQuery, SortOrder } from 'mongoose';
import { Types } from 'mongoose';
import {
  PUBLIC_DETAIL_STATUSES,
  propertyValidateMerged,
  pricePerSqft,
  slugify,
  toSqft,
  type AdminProperty,
  type ListingPoster,
  type OwnListing,
  type PaginationMeta,
  type PosterType,
  type PropertyCard,
  type PropertyCreate,
  type PropertySearch,
  type PropertyStatus,
  type PropertyUpdate,
  type PublicProperty,
  type UserPropertyCreate,
  type UserPropertyUpdate,
  type UserRole,
  coverFirst,
  isBusinessRole,
} from '@nexus/shared';
import type { z } from 'zod';
import type { adminPropertyQuerySchema } from '@nexus/shared';
import { Property, type PropertyAttrs } from '../models/property.model.js';
import { claimListingSlot, listingLimitFor } from './billing.service.js';
import { businessAlert } from './notification.service.js';
import { Project } from '../models/project.model.js';
import { Enquiry, PropertyViewDay, SlugRedirect } from '../models/misc.models.js';
import { indiaDay } from '../lib/india-day.js';
import { User } from '../models/user.model.js';
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { env } from '../config/env.js';
import { resolveLocation } from './location.service.js';
import { deleteImages } from './upload.service.js';
import { sendMail } from './mail.service.js';

type Lean = PropertyAttrs & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

type PosterUser = {
  _id: Types.ObjectId;
  name: string;
  role: UserRole;
  companyName?: string | null;
  verified?: boolean;
  premiumUntil?: Date | null;
  showPhone?: boolean;
  email?: string;
  phone?: string;
  createdAt?: Date;
  profileSlug?: string | null;
};

/** /agents/<slug> or /builders/<slug>; null for owners and users without a slug. */
export function profilePathFor(role: string, slug?: string | null): string | null {
  if (!slug) return null;
  if (role === 'agent') return `/agents/${slug}`;
  if (role === 'builder') return `/builders/${slug}`;
  return null;
}

type GeoField = { type?: string | null; coordinates?: number[] | null } | null | undefined;

/** GeoJSON stores [lng, lat]; the API speaks { lat, lng }. */
export function fromGeo(g: GeoField) {
  const c = g?.coordinates;
  return c && c.length === 2 ? { lat: c[1]!, lng: c[0]! } : null;
}

export function toGeo(p: { lat: number; lng: number } | null | undefined) {
  return p ? { type: 'Point', coordinates: [p.lng, p.lat] } : undefined;
}

const PLOT_TYPES = ['plot', 'industrial-land'];

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export const isPremium = (until?: Date | null) => Boolean(until && new Date(until) > new Date());

export const posterTypeFor = (role: UserRole): PosterType =>
  role === 'agent' || role === 'builder' ? role : 'owner';

const NEXUS_POSTER: ListingPoster = {
  type: 'nexus',
  name: null,
  companyName: null,
  verified: true,
  premium: false,
  canRevealPhone: false,
  memberSince: null,
  profilePath: null,
};

function posterFrom(p: Lean, u: PosterUser | null | undefined): ListingPoster {
  if (!p.postedBy || !u) return NEXUS_POSTER;
  return {
    type: (p.posterType as PosterType) ?? posterTypeFor(u.role),
    // Owners are shown by first name only; agents and builders by their business name.
    name: isBusinessRole(u.role as UserRole) ? u.name : u.name.split(' ')[0]!,
    companyName: u.companyName ?? null,
    verified: Boolean(u.verified),
    premium: isPremium(u.premiumUntil),
    canRevealPhone: Boolean(u.showPhone),
    memberSince: iso(u.createdAt ?? null),
    profilePath: profilePathFor(u.role, u.profileSlug),
  };
}

function cover(p: Lean) {
  const img = p.images[p.coverImageIndex] ?? p.images[0];
  return img
    ? {
        url: img.url,
        alt: img.alt || p.title,
        width: img.width ?? undefined,
        height: img.height ?? undefined,
        isDemo: img.isDemo ?? false,
      }
    : null;
}

type ListingCore = Omit<PublicProperty, 'status' | 'poster'>;

function core(p: Lean): ListingCore {
  const listingType = (p.listingType ?? 'rent') as PublicProperty['listingType'];
  return {
    id: String(p._id),
    slug: p.slug,
    listingType,
    title: p.title,
    description: p.description,
    highlights: p.highlights ?? [],
    category: p.category as PublicProperty['category'],
    propertyType: p.propertyType as PublicProperty['propertyType'],
    city: { slug: p.citySlug, name: p.cityName },
    locality: { slug: p.localitySlug, name: p.localityName },
    state: p.state ?? '',
    approvedAddress: p.approvedAddress ?? '',
    projectName: p.projectName ?? null,
    price: p.price,
    priceNegotiable: p.priceNegotiable ?? false,
    pricePerSqft: listingType === 'sale' ? pricePerSqft(p.price, p.areaSqft) : null,
    securityDeposit: p.securityDeposit ?? null,
    maintenanceCharges: p.maintenanceCharges ?? null,
    maintenanceIncluded: p.maintenanceIncluded ?? false,
    brokerage: p.brokerage ?? null,
    lockInMonths: p.lockInMonths ?? null,
    rentalTerms: p.rentalTerms ?? null,
    possessionStatus: (p.possessionStatus as PublicProperty['possessionStatus']) ?? null,
    possessionDate: iso(p.possessionDate),
    transactionType: (p.transactionType as PublicProperty['transactionType']) ?? null,
    ownershipType: (p.ownershipType as PublicProperty['ownershipType']) ?? null,
    reraId: p.reraId ?? null,
    areaValue: p.areaValue,
    areaUnit: p.areaUnit as PublicProperty['areaUnit'],
    areaType: (p.areaType ?? 'carpet') as PublicProperty['areaType'],
    areaSqft: p.areaSqft,
    bedrooms: p.bedrooms ?? null,
    bathrooms: p.bathrooms ?? null,
    balconies: p.balconies ?? null,
    washrooms: p.washrooms ?? null,
    floorNumber: p.floorNumber ?? null,
    totalFloors: p.totalFloors ?? null,
    facing: p.facing ?? null,
    ageOfPropertyYears: p.ageOfPropertyYears ?? null,
    furnishingStatus: p.furnishingStatus as PublicProperty['furnishingStatus'],
    amenities: (p.amenities ?? []) as PublicProperty['amenities'],
    parking: (p.parking ?? 'none') as PublicProperty['parking'],
    preferredTenants: (p.preferredTenants ?? []) as PublicProperty['preferredTenants'],
    suitableFor: p.suitableFor ?? [],
    // The cover photo always leads the gallery, so the property page and the
    // cards show the same first photo.
    images: coverFirst(p.images ?? [], p.coverImageIndex).map((i) => ({
      url: i.url,
      alt: i.alt || p.title,
      width: i.width ?? undefined,
      height: i.height ?? undefined,
      isDemo: i.isDemo ?? false,
    })),
    coverImage: cover(p),
    location: fromGeo(p.geo as GeoField),
    videoUrl: p.videoUrl ?? null,
    project: null,
    plotApproval: (p.plotApproval as PublicProperty['plotApproval']) ?? null,
    cornerPlot: p.cornerPlot ?? false,
    roadWidthFt: p.roadWidthFt ?? null,
    openSides: p.openSides ?? null,
    boundaryWall: p.boundaryWall ?? false,
    pgSharing: (p.pgSharing ?? []) as PublicProperty['pgSharing'],
    pgGender: (p.pgGender as PublicProperty['pgGender']) ?? null,
    pgFoodIncluded: p.pgFoodIncluded ?? false,
    views: p.views ?? 0,
    availableFrom: iso(p.availableFrom),
    featured: p.featured ?? false,
    verified: p.verified ?? false,
    isDemo: p.isDemo ?? false,
    seoTitle: p.seoTitle ?? null,
    seoDescription: p.seoDescription ?? null,
    publishedAt: iso(p.publishedAt),
    updatedAt: iso(p.updatedAt)!,
  };
}

export function toPublic(p: Lean, poster: ListingPoster): PublicProperty {
  const status: PublicProperty['status'] =
    p.status === 'rented' ? 'rented' : p.status === 'sold' ? 'sold' : 'published';
  return { ...core(p), status, poster };
}

export function toCard(p: Lean): PropertyCard {
  const c = core(p);
  return {
    id: c.id,
    slug: c.slug,
    listingType: c.listingType,
    title: c.title,
    category: c.category,
    propertyType: c.propertyType,
    status: p.status === 'rented' ? 'rented' : p.status === 'sold' ? 'sold' : 'published',
    city: c.city,
    locality: c.locality,
    projectName: c.projectName,
    price: c.price,
    pricePerSqft: c.pricePerSqft,
    areaValue: c.areaValue,
    areaUnit: c.areaUnit,
    bedrooms: c.bedrooms,
    bathrooms: c.bathrooms,
    furnishingStatus: c.furnishingStatus,
    possessionStatus: c.possessionStatus,
    coverImage: c.coverImage,
    featured: c.featured,
    verified: c.verified,
    isDemo: c.isDemo,
    availableFrom: c.availableFrom,
    publishedAt: c.publishedAt,
    posterType: (p.posterType as PosterType) ?? 'nexus',
    imageCount: p.images?.length ?? 0,
    areaSqft: c.areaSqft,
    location: c.location,
    plotApproval: c.plotApproval,
    pgGender: c.pgGender,
  };
}

function toOwn(p: Lean, enquiryCount = 0): OwnListing {
  return {
    ...core(p),
    // Owners see their own original images with storage ids so they can edit.
    images: (p.images ?? []).map((i) => ({
      url: i.url,
      publicId: i.publicId ?? undefined,
      alt: i.alt ?? '',
      width: i.width ?? undefined,
      height: i.height ?? undefined,
      isDemo: i.isDemo ?? false,
    })),
    status: p.status as PropertyStatus,
    citySlug: p.citySlug,
    localitySlug: p.localitySlug,
    pincode: p.pincode ?? null,
    coverImageIndex: p.coverImageIndex ?? 0,
    moderationNote: p.moderationNote ?? null,
    createdAt: iso(p.createdAt)!,
    enquiryCount,
    projectId: p.projectId ? String(p.projectId) : null,
    awaitingPlan: Boolean(p.awaitingPlan),
    featuredUntil: iso(p.featuredUntil ?? null),
  };
}

function toAdmin(p: Lean, u: PosterUser | null, enquiryCount = 0): AdminProperty {
  return {
    ...toOwn(p, enquiryCount),
    listingVisibility: (p.listingVisibility ?? 'public') as AdminProperty['listingVisibility'],
    ownerReference: p.ownerReference ?? null,
    internalNotes: p.internalNotes ?? null,
    postedBy: u
      ? {
          id: String(u._id),
          name: u.name,
          role: u.role,
          email: u.email ?? '',
          phone: u.phone ?? '',
        }
      : null,
    poster: posterFrom(p, u),
  };
}

async function postersById(ids: (Types.ObjectId | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (!unique.length) return new Map<string, PosterUser>();
  const users = await User.find({ _id: { $in: unique } })
    .select(
      'name role companyName verified premiumUntil showPhone email phone createdAt profileSlug',
    )
    .lean<PosterUser[]>();
  return new Map(users.map((u) => [String(u._id), u]));
}

async function enquiryCounts(ids: Types.ObjectId[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await Enquiry.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { property: { $in: ids }, status: { $ne: 'spam' } } },
    { $group: { _id: '$property', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/* ------------------------------------------------------------------ */
/* Public search                                                       */
/* ------------------------------------------------------------------ */

const CARD_FIELDS =
  'slug listingType title category propertyType status citySlug cityName localitySlug localityName projectName price areaValue areaUnit areaSqft bedrooms bathrooms furnishingStatus possessionStatus images coverImageIndex featured verified isDemo availableFrom publishedAt updatedAt description posterType geo plotApproval pgGender';

const VISIBLE = { status: 'published', listingVisibility: 'public' } as const;

export function buildPublicFilter(
  q: PropertySearch,
  projectId?: Types.ObjectId | null,
): FilterQuery<PropertyAttrs> {
  const f: FilterQuery<PropertyAttrs> = { ...VISIBLE };
  if (q.listingType) f.listingType = q.listingType;
  if (q.category) f.category = q.category;
  if (q.propertyType?.length) f.propertyType = { $in: q.propertyType };
  if (q.city) f.citySlug = q.city;
  if (q.locality) f.localitySlug = q.locality;
  if (q.minPrice !== undefined || q.maxPrice !== undefined) {
    f.price = {
      ...(q.minPrice !== undefined ? { $gte: q.minPrice } : {}),
      ...(q.maxPrice !== undefined ? { $lte: q.maxPrice } : {}),
    };
  }
  if (q.furnishing?.length) f.furnishingStatus = { $in: q.furnishing };
  // Bedrooms/bathrooms are minimums ("2+ BHK"), matching how people search.
  if (q.bedrooms) f.bedrooms = { $gte: q.bedrooms };
  if (q.bathrooms) f.bathrooms = { $gte: q.bathrooms };
  if (q.minArea !== undefined || q.maxArea !== undefined) {
    f.areaSqft = {
      ...(q.minArea !== undefined ? { $gte: q.minArea } : {}),
      ...(q.maxArea !== undefined ? { $lte: q.maxArea } : {}),
    };
  }
  if (q.amenities?.length) f.amenities = { $all: q.amenities };
  if (q.parking) f.parking = { $nin: ['none', null] };
  if (q.availableNow) f.$or = [{ availableFrom: null }, { availableFrom: { $lte: new Date() } }];
  if (q.possession) f.possessionStatus = q.possession;
  if (q.postedBy) f.posterType = q.postedBy;
  if (q.verified) f.verified = true;
  if (q.featured) f.featured = true;
  if (q.withPhotos) f['images.0'] = { $exists: true };
  if (q.rera) f.reraId = { $nin: [null, ''], $exists: true };
  if (q.plotApproval?.length) f.plotApproval = { $in: q.plotApproval };
  if (q.pgGender) f.pgGender = { $in: [q.pgGender, 'any'] };
  if (q.pgFood) f.pgFoodIncluded = true;
  if (q.postedWithin) f.publishedAt = { $gte: new Date(Date.now() - q.postedWithin * 86_400_000) };
  if (q.poster) f.postedBy = new Types.ObjectId(q.poster);
  if (q.project) f.projectId = projectId ?? new Types.ObjectId('000000000000000000000000');
  if (q.q) f.$text = { $search: q.q };
  return f;
}

const SORTS: Record<PropertySearch['sort'], Record<string, SortOrder>> = {
  newest: { featured: -1, publishedAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
  area_desc: { areaSqft: -1, _id: -1 },
};

export async function searchPublic(
  q: PropertySearch,
): Promise<{ items: PropertyCard[]; meta: PaginationMeta }> {
  const projectId = q.project
    ? ((await Project.findOne({ slug: q.project, status: 'published' }).select('_id').lean())
        ?._id ?? null)
    : null;
  const filter = buildPublicFilter(q, projectId as Types.ObjectId | null);
  const [rows, total] = await Promise.all([
    Property.find(filter)
      .select(CARD_FIELDS)
      .sort(SORTS[q.sort])
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    Property.countDocuments(filter),
  ]);
  return { items: rows.map(toCard), meta: paginate(q.page, q.limit, total) };
}

export type PublicDetailResult =
  | { kind: 'found'; property: PublicProperty; similar: PropertyCard[] }
  | { kind: 'redirect'; slug: string };

export async function getPublicBySlug(slug: string): Promise<PublicDetailResult> {
  const p = await Property.findOne({ slug, status: { $in: PUBLIC_DETAIL_STATUSES } }).lean<Lean>();
  if (p) {
    const [posters, project] = await Promise.all([
      postersById([p.postedBy]),
      p.projectId
        ? Project.findOne({ _id: p.projectId, status: 'published' }).select('slug name').lean()
        : null,
    ]);
    const poster = posterFrom(p, p.postedBy ? posters.get(String(p.postedBy)) : null);
    const property = toPublic(p, poster);
    if (project)
      property.project = { id: String(project._id), slug: project.slug, name: project.name };
    return { kind: 'found', property, similar: await findSimilar(p) };
  }
  const redirect = await SlugRedirect.findOne({ fromSlug: slug }).lean();
  if (redirect) {
    const target = await Property.findOne({
      _id: redirect.property,
      status: { $in: PUBLIC_DETAIL_STATUSES },
    })
      .select('slug')
      .lean();
    if (target) return { kind: 'redirect', slug: target.slug };
  }
  throw notFound('Property not found');
}

async function findSimilar(p: Lean, limit = 4): Promise<PropertyCard[]> {
  const base: FilterQuery<PropertyAttrs> = {
    ...VISIBLE,
    _id: { $ne: p._id },
    listingType: p.listingType,
    category: p.category,
    citySlug: p.citySlug,
  };
  const close = await Property.find({
    ...base,
    price: { $gte: Math.round(p.price * 0.6), $lte: Math.round(p.price * 1.4) },
  })
    .select(CARD_FIELDS)
    .sort({ publishedAt: -1 })
    .limit(limit * 3)
    .lean<Lean[]>();
  // Prefer listings in the same locality, then the rest of the city.
  close.sort(
    (a, b) => Number(b.localitySlug === p.localitySlug) - Number(a.localitySlug === p.localitySlug),
  );
  close.splice(limit);
  if (close.length >= limit) return close.map(toCard);
  const more = await Property.find({ ...base, _id: { $nin: [p._id, ...close.map((c) => c._id)] } })
    .select(CARD_FIELDS)
    .sort({ publishedAt: -1 })
    .limit(limit - close.length)
    .lean<Lean[]>();
  return [...close, ...more].map(toCard);
}

export async function listHomeSections() {
  const [featured, recentSale, recentRent, counts] = await Promise.all([
    Property.find({ ...VISIBLE, featured: true })
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1 })
      .limit(6)
      .lean<Lean[]>(),
    Property.find({ ...VISIBLE, listingType: 'sale' })
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1 })
      .limit(6)
      .lean<Lean[]>(),
    Property.find({ ...VISIBLE, listingType: 'rent' })
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1 })
      .limit(6)
      .lean<Lean[]>(),
    Property.aggregate<{ _id: string; n: number }>([
      { $match: VISIBLE },
      { $group: { _id: '$listingType', n: { $sum: 1 } } },
    ]),
  ]);
  const byType = Object.fromEntries(counts.map((c) => [c._id, c.n]));
  return {
    featured: featured.map(toCard),
    recentSale: recentSale.map(toCard),
    recentRent: recentRent.map(toCard),
    counts: { sale: byType.sale ?? 0, rent: byType.rent ?? 0 },
  };
}

/** Counts a detail-page view. Called from the browser so cached pages still count. */
export async function recordView(id: string) {
  const doc = await Property.findOneAndUpdate(
    { _id: id, ...VISIBLE },
    { $inc: { views: 1 } },
    { projection: { postedBy: 1 } },
  ).lean<{ _id: Types.ObjectId; postedBy?: Types.ObjectId | null }>();
  if (!doc) return;
  await PropertyViewDay.updateOne(
    { property: doc._id, day: indiaDay() },
    { $inc: { n: 1 }, $setOnInsert: { owner: doc.postedBy ?? null } },
    { upsert: true },
  );
}

/** Lightweight list for the XML sitemap. Demo listings are noindex, so they are excluded. */
export async function sitemapEntries() {
  const rows = await Property.find({ ...VISIBLE, isDemo: { $ne: true } })
    .select('slug updatedAt')
    .sort({ updatedAt: -1 })
    .limit(45_000)
    .lean();
  return rows.map((r) => ({ slug: r.slug, updatedAt: iso(r.updatedAt as Date)! }));
}

/* ------------------------------------------------------------------ */
/* Shared write logic                                                  */
/* ------------------------------------------------------------------ */

export async function uniqueSlug(
  base: string,
  excludeId?: Types.ObjectId | string,
): Promise<string> {
  const root = slugify(base) || 'property';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const exists = await Property.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    const redirected = await SlugRedirect.exists({ fromSlug: candidate });
    if (!exists && !redirected) return candidate;
  }
  return `${root}-${new Types.ObjectId().toString().slice(-6)}`;
}

async function ensureSlugFree(slug: string, excludeId?: Types.ObjectId | string) {
  const taken = await Property.exists({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) });
  if (taken) throw conflict('That URL slug is already used by another property');
  const redirect = await SlugRedirect.findOne({ fromSlug: slug }).lean();
  if (redirect && String(redirect.property) !== String(excludeId)) {
    throw conflict('That URL slug was used by another property and still redirects to it');
  }
  return slug;
}

/** Clears fields that don't apply to the listing type so stale values never show. */
function normaliseForType<T extends Record<string, unknown>>(data: T, listingType: string): T {
  const out: Record<string, unknown> = { ...data };
  if (listingType === 'sale') {
    for (const k of ['securityDeposit', 'lockInMonths', 'availableFrom']) out[k] = null;
    out.preferredTenants = [];
    out.rentalTerms = undefined;
  } else {
    for (const k of ['possessionStatus', 'possessionDate', 'transactionType', 'ownershipType']) {
      out[k] = null;
    }
    out.reraId = undefined;
  }
  return out as T;
}

/** Clears plot or PG fields on other property types, and maps the pin to GeoJSON. */
function normaliseExtras<T extends Record<string, unknown>>(data: T, propertyType?: string): T {
  const out: Record<string, unknown> = { ...data };
  if ('location' in out) {
    const loc = out.location as { lat: number; lng: number } | null | undefined;
    delete out.location;
    if (loc) out.geo = toGeo(loc);
    else if (loc === null) out.geo = undefined;
  }
  if (propertyType && !PLOT_TYPES.includes(propertyType)) {
    Object.assign(out, {
      plotApproval: null,
      cornerPlot: false,
      roadWidthFt: null,
      openSides: null,
      boundaryWall: false,
    });
  }
  if (propertyType && propertyType !== 'pg') {
    Object.assign(out, { pgSharing: [], pgGender: null, pgFoodIncluded: false });
  }
  return out as T;
}

/** A listing may point at a published project in the same city. */
async function checkProject(projectId: string | null | undefined, citySlug: string) {
  if (!projectId) return;
  const ok = await Project.exists({ _id: projectId, status: 'published', citySlug });
  if (!ok) {
    throw badRequest('Unknown project', { projectId: ['Choose a live project in this city'] });
  }
}

function statusSideEffects(current: Partial<Lean>, next: PropertyStatus) {
  const out: Record<string, unknown> = { status: next };
  if (next === 'published') {
    if (!current.publishedAt) out.publishedAt = new Date();
    out.moderationNote = undefined;
  }
  if (next === 'pending') out.submittedAt = new Date();
  if (next === 'rented' || next === 'sold') out.closedAt = new Date();
  if (next === 'archived' || next === 'inactive' || next === 'rejected' || next === 'pending') {
    out.featured = false;
    out.featuredUntil = null;
  }
  return out;
}

function stripNulls<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null)) as Partial<T>;
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export async function listAdmin(q: z.output<typeof adminPropertyQuerySchema>) {
  const f: FilterQuery<PropertyAttrs> = {};
  if (q.status) f.status = q.status;
  if (q.listingType) f.listingType = q.listingType;
  if (q.category) f.category = q.category;
  if (q.city) f.citySlug = q.city;
  if (q.featured) f.featured = true;
  if (q.demo) f.isDemo = true;
  if (q.postedBy === 'nexus') f.postedBy = null;
  if (q.postedBy === 'users') f.postedBy = { $ne: null };
  if (q.userId) f.postedBy = new Types.ObjectId(q.userId);
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [
      { title: rx },
      { slug: rx },
      { localityName: rx },
      { projectName: rx },
      { ownerReference: rx },
    ];
  }
  // The review queue is oldest-first so nothing waits too long.
  const sort: Record<string, SortOrder> =
    q.status === 'pending' ? { submittedAt: 1, _id: 1 } : { updatedAt: -1 };
  const [rows, total] = await Promise.all([
    Property.find(f)
      .sort(sort)
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    Property.countDocuments(f),
  ]);
  const [counts, posters] = await Promise.all([
    enquiryCounts(rows.map((r) => r._id)),
    postersById(rows.map((r) => r.postedBy)),
  ]);
  return {
    items: rows.map((r) =>
      toAdmin(
        r,
        r.postedBy ? (posters.get(String(r.postedBy)) ?? null) : null,
        counts.get(String(r._id)) ?? 0,
      ),
    ),
    meta: paginate(q.page, q.limit, total),
  };
}

export async function getAdmin(id: string): Promise<AdminProperty> {
  const p = await Property.findById(id).lean<Lean>();
  if (!p) throw notFound('Property not found');
  const [posters, counts] = await Promise.all([postersById([p.postedBy]), enquiryCounts([p._id])]);
  return toAdmin(
    p,
    p.postedBy ? (posters.get(String(p.postedBy)) ?? null) : null,
    counts.get(String(p._id)) ?? 0,
  );
}

export async function createProperty(
  input: PropertyCreate,
  adminId: string,
): Promise<AdminProperty> {
  const loc = await resolveLocation(input.citySlug, input.localitySlug);
  const slug = input.slug
    ? await ensureSlugFree(input.slug)
    : await uniqueSlug(`${input.title} ${loc.localityName}`);
  await checkProject(input.projectId, input.citySlug);
  const doc = await Property.create({
    ...normaliseExtras(normaliseForType(input, input.listingType), input.propertyType),
    slug,
    cityName: loc.cityName,
    localityName: loc.localityName,
    state: input.state || loc.state,
    areaSqft: toSqft(input.areaValue, input.areaUnit),
    posterType: 'nexus',
    ...statusSideEffects({}, input.status),
    createdBy: adminId,
    updatedBy: adminId,
  });
  return getAdmin(String(doc._id));
}

/** Core update shared by admin and user edits. */
async function applyUpdate(
  doc: InstanceType<typeof Property>,
  patch: PropertyUpdate | UserPropertyUpdate,
  actorId: string,
) {
  const current = doc.toObject() as unknown as Lean;
  const merged = { ...current, ...patch };
  const check = propertyValidateMerged(
    stripNulls(JSON.parse(JSON.stringify(merged))) as Parameters<typeof propertyValidateMerged>[0],
  );
  if (!check.success) throw validationError(check.error);

  let set: Record<string, unknown> = { ...patch, updatedBy: actorId };
  if (patch.listingType && patch.listingType !== current.listingType) {
    set = normaliseForType(set, patch.listingType);
  }
  set = normaliseExtras(set, patch.propertyType);
  if (patch.projectId !== undefined || patch.citySlug) {
    await checkProject(merged.projectId ? String(merged.projectId) : null, merged.citySlug);
  }

  if (patch.citySlug || patch.localitySlug) {
    const loc = await resolveLocation(merged.citySlug, merged.localitySlug);
    Object.assign(set, {
      cityName: loc.cityName,
      localityName: loc.localityName,
      state: loc.state,
    });
  }
  if (patch.areaValue !== undefined || patch.areaUnit !== undefined) {
    set.areaSqft = toSqft(merged.areaValue, merged.areaUnit as PropertyCreate['areaUnit']);
  }
  if ('status' in patch && patch.status)
    Object.assign(set, statusSideEffects(current, patch.status));

  const oldSlug = current.slug;
  if ('slug' in patch && patch.slug && patch.slug !== oldSlug) {
    await ensureSlugFree(patch.slug, doc._id);
    await SlugRedirect.deleteOne({ fromSlug: patch.slug });
    await SlugRedirect.updateOne(
      { fromSlug: oldSlug },
      { $set: { fromSlug: oldSlug, property: doc._id } },
      { upsert: true },
    );
  }

  // Remove stored images that were dropped from the gallery.
  if (patch.images) {
    const keep = new Set(patch.images.map((i) => i.publicId).filter(Boolean));
    const removed = current.images
      .map((i) => i.publicId)
      .filter((p): p is string => !!p && !keep.has(p));
    if (removed.length) void deleteImages(removed);
  }

  doc.set(set);
  await doc.save();
}

export async function updateProperty(id: string, patch: PropertyUpdate, adminId: string) {
  const doc = await Property.findById(id);
  if (!doc) throw notFound('Property not found');
  await applyUpdate(doc, patch, adminId);
  return getAdmin(id);
}

/** Status change by staff, including approving or rejecting user submissions. */
export async function changeStatus(
  id: string,
  status: PropertyStatus,
  adminId: string,
  note?: string,
) {
  const doc = await Property.findById(id);
  if (!doc) throw notFound('Property not found');
  const before = doc.status;
  if (status === 'rejected' && !note?.trim()) {
    throw badRequest('Tell the poster what to change', { note: ['Add a note for the poster'] });
  }
  await applyUpdate(doc, { status }, adminId);
  if (status === 'rejected') {
    doc.moderationNote = note!.trim();
    await doc.save();
  }
  if (doc.postedBy && before === 'pending' && (status === 'published' || status === 'rejected')) {
    void notifyPoster(doc.postedBy, doc.title, doc.slug, status, note);
  }
  return getAdmin(id);
}

async function notifyPoster(
  userId: Types.ObjectId,
  title: string,
  slug: string,
  status: 'published' | 'rejected',
  note?: string,
) {
  const u = await User.findById(userId).select('email name').lean();
  if (!u) return;
  if (status === 'published') {
    await sendMail(
      u.email,
      `Your listing is live: ${title}`,
      [
        `Hi ${u.name},`,
        `Your listing “${title}” has been approved and is now live on NEXUS Estate.`,
      ],
      { label: 'View listing', url: `${env.PUBLIC_SITE_URL}/properties/${slug}` },
    );
  } else {
    await sendMail(
      u.email,
      `Changes needed: ${title}`,
      [
        `Hi ${u.name},`,
        `Our team reviewed “${title}” and needs a few changes before it can go live:`,
        note ?? '',
      ],
      { label: 'Edit listing', url: `${env.PUBLIC_SITE_URL}/dashboard/listings` },
    );
  }
}

export async function deleteProperty(id: string) {
  const doc = await Property.findById(id);
  if (!doc) throw notFound('Property not found');
  const publicIds = doc.images.map((i) => i.publicId).filter((p): p is string => !!p);
  await SlugRedirect.deleteMany({ property: doc._id });
  await User.updateMany({ saved: doc._id }, { $pull: { saved: doc._id } });
  await doc.deleteOne();
  if (publicIds.length) void deleteImages(publicIds);
  return { id, title: doc.title };
}

/* ------------------------------------------------------------------ */
/* Listings owned by website users                                     */
/* ------------------------------------------------------------------ */

async function ownedDoc(userId: string, id: string) {
  const doc = await Property.findOne({ _id: id, postedBy: userId });
  if (!doc) throw notFound('Listing not found');
  return doc;
}

/**
 * What happens when the user sends a listing for review. A listing that already used a
 * slot goes straight to review. Otherwise it takes one slot from the plan or the free
 * allowance; with none left and no plan it is saved and waits for a plan ("hold").
 */
async function reviewOrHold(
  userId: string,
  role: UserRole,
  doc?: { slotUsed?: boolean | null; submittedAt?: Date | null },
) {
  if (doc?.slotUsed || doc?.submittedAt) return 'review' as const;
  const r = await claimListingSlot(userId, role);
  if (r === 'claimed') return 'claimed' as const;
  if (r === 'hold') return 'hold' as const;
  const limit = await listingLimitFor(userId, role);
  throw new AppError(
    403,
    'LISTING_LIMIT',
    `You have posted all ${limit} listings in your plan. Your next plan adds more.`,
  );
}

/** Tells the team a listing is waiting in the review queue. */
function reviewAlert(doc: { _id: unknown; title: string; status: string }) {
  if (doc.status !== 'pending') return;
  void businessAlert('listing', {
    title: `Listing waiting for review: ${doc.title}`,
    link: '/admin/review',
  });
}

export async function listMine(userId: string, status?: PropertyStatus) {
  const rows = await Property.find({ postedBy: userId, ...(status ? { status } : {}) })
    .sort({ updatedAt: -1 })
    .limit(500)
    .lean<Lean[]>();
  const counts = await enquiryCounts(rows.map((r) => r._id));
  return rows.map((r) => toOwn(r, counts.get(String(r._id)) ?? 0));
}

export async function getMine(userId: string, id: string) {
  const doc = await ownedDoc(userId, id);
  const counts = await enquiryCounts([doc._id]);
  return toOwn(doc.toObject() as unknown as Lean, counts.get(String(doc._id)) ?? 0);
}

export async function createMine(
  user: { id: string; role: UserRole },
  input: UserPropertyCreate,
): Promise<OwnListing> {
  const loc = await resolveLocation(input.citySlug, input.localitySlug, { activeOnly: true });
  await checkProject(input.projectId, input.citySlug);
  const outcome = input.status === 'pending' ? await reviewOrHold(user.id, user.role) : null;
  const hold = outcome === 'hold';
  if (hold) input = { ...input, status: 'draft' };
  const doc = await Property.create({
    ...normaliseExtras(normaliseForType(input, input.listingType), input.propertyType),
    slug: await uniqueSlug(`${input.title} ${loc.localityName}`),
    cityName: loc.cityName,
    localityName: loc.localityName,
    state: loc.state,
    areaSqft: toSqft(input.areaValue, input.areaUnit),
    postedBy: user.id,
    posterType: posterTypeFor(user.role),
    ...statusSideEffects({}, input.status),
    awaitingPlan: hold,
    slotUsed: outcome === 'claimed',
    createdBy: user.id,
    updatedBy: user.id,
  });
  reviewAlert(doc);
  return getMine(user.id, String(doc._id));
}

/**
 * Users may edit drafts, rejected listings and listings in review freely. Editing a
 * live listing sends it back for review so every public change is checked.
 */
export async function updateMine(
  user: { id: string; role: UserRole },
  id: string,
  patch: UserPropertyUpdate,
): Promise<OwnListing> {
  const doc = await ownedDoc(user.id, id);
  if (['rented', 'sold', 'archived'].includes(doc.status)) {
    throw forbidden('This listing is closed. Reactivate it before editing.');
  }
  if (patch.citySlug || patch.localitySlug) {
    await resolveLocation(patch.citySlug ?? doc.citySlug, patch.localitySlug ?? doc.localitySlug, {
      activeOnly: true,
    });
  }
  const next: UserPropertyUpdate = { ...patch };
  const wasLive = doc.status === 'published';
  let hold = false;
  if (wasLive) {
    next.status = 'pending';
  } else if (patch.status === 'pending') {
    const outcome = await reviewOrHold(user.id, user.role, doc);
    hold = outcome === 'hold';
    if (hold) next.status = 'draft';
    if (outcome === 'claimed') doc.slotUsed = true;
  }
  await applyUpdate(doc, next, user.id);
  if ((patch.status || wasLive) && hold !== Boolean(doc.awaitingPlan)) {
    doc.awaitingPlan = hold;
    await doc.save();
  }
  if (wasLive || next.status === 'pending') {
    doc.moderationNote = undefined;
    await doc.save();
    reviewAlert(doc);
  }
  return getMine(user.id, id);
}

const USER_TRANSITIONS: Record<string, PropertyStatus[]> = {
  draft: ['pending'],
  rejected: ['pending', 'draft'],
  pending: ['draft'],
  published: ['rented', 'sold', 'inactive'],
  inactive: ['pending'],
  rented: ['pending', 'inactive'],
  sold: ['inactive'],
};

export async function setMyStatus(
  user: { id: string; role: UserRole },
  id: string,
  status: PropertyStatus,
): Promise<OwnListing> {
  const doc = await ownedDoc(user.id, id);
  const allowed = USER_TRANSITIONS[doc.status] ?? [];
  if (!allowed.includes(status)) {
    throw badRequest(`A listing that is ${doc.status} cannot be changed to ${status}`);
  }
  if (status === 'pending') {
    const outcome = await reviewOrHold(user.id, user.role, doc);
    if (outcome === 'hold') {
      doc.awaitingPlan = true;
      await doc.save();
      return getMine(user.id, id);
    }
    if (outcome === 'claimed') doc.slotUsed = true;
  }
  await applyUpdate(doc, { status } as PropertyUpdate, user.id);
  if (doc.awaitingPlan) {
    doc.awaitingPlan = false;
    await doc.save();
  }
  reviewAlert(doc);
  return getMine(user.id, id);
}

export async function deleteMine(userId: string, id: string) {
  const doc = await ownedDoc(userId, id);
  if (doc.status === 'published') {
    throw badRequest('Mark the listing as rented, sold or inactive before deleting it');
  }
  return deleteProperty(String(doc._id));
}
