import type { FilterQuery, SortOrder } from 'mongoose';
import { Types } from 'mongoose';
import {
  LISTING_LIMITS,
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
} from '@nexus/shared';
import type { z } from 'zod';
import type { adminPropertyQuerySchema } from '@nexus/shared';
import { Property, type PropertyAttrs } from '../models/property.model.js';
import { Enquiry, SlugRedirect } from '../models/misc.models.js';
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
  showPhone?: boolean;
  email?: string;
  phone?: string;
  createdAt?: Date;
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export const posterTypeFor = (role: UserRole): PosterType =>
  role === 'individual' ? 'owner' : role;

const NEXUS_POSTER: ListingPoster = {
  type: 'nexus',
  name: null,
  companyName: null,
  verified: true,
  canRevealPhone: false,
  memberSince: null,
};

function posterFrom(p: Lean, u: PosterUser | null | undefined): ListingPoster {
  if (!p.postedBy || !u) return NEXUS_POSTER;
  return {
    type: (p.posterType as PosterType) ?? posterTypeFor(u.role),
    // Owners are shown by first name only; agents and builders by their business name.
    name: u.role === 'individual' ? u.name.split(' ')[0]! : u.name,
    companyName: u.companyName ?? null,
    verified: Boolean(u.verified),
    canRevealPhone: Boolean(u.showPhone),
    memberSince: iso(u.createdAt ?? null),
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
    images: (p.images ?? []).map((i) => ({
      url: i.url,
      alt: i.alt || p.title,
      width: i.width ?? undefined,
      height: i.height ?? undefined,
      isDemo: i.isDemo ?? false,
    })),
    coverImage: cover(p),
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
    .select('name role companyName verified showPhone email phone createdAt')
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
  'slug listingType title category propertyType status citySlug cityName localitySlug localityName projectName price areaValue areaUnit areaSqft bedrooms bathrooms furnishingStatus possessionStatus images coverImageIndex featured verified isDemo availableFrom publishedAt updatedAt description posterType';

const VISIBLE = { status: 'published', listingVisibility: 'public' } as const;

export function buildPublicFilter(q: PropertySearch): FilterQuery<PropertyAttrs> {
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
  if (q.q) f.$text = { $search: q.q };
  return f;
}

const SORTS: Record<PropertySearch['sort'], Record<string, SortOrder>> = {
  newest: { featured: -1, publishedAt: -1, _id: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: -1 },
};

export async function searchPublic(
  q: PropertySearch,
): Promise<{ items: PropertyCard[]; meta: PaginationMeta }> {
  const filter = buildPublicFilter(q);
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
    const posters = await postersById([p.postedBy]);
    const poster = posterFrom(p, p.postedBy ? posters.get(String(p.postedBy)) : null);
    return { kind: 'found', property: toPublic(p, poster), similar: await findSimilar(p) };
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
  const doc = await Property.create({
    ...normaliseForType(input, input.listingType),
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

const ACTIVE_FOR_LIMIT: PropertyStatus[] = ['pending', 'published'];

async function ownedDoc(userId: string, id: string) {
  const doc = await Property.findOne({ _id: id, postedBy: userId });
  if (!doc) throw notFound('Listing not found');
  return doc;
}

async function assertUnderLimit(userId: string, role: UserRole, excludeId?: Types.ObjectId) {
  const active = await Property.countDocuments({
    postedBy: userId,
    status: { $in: ACTIVE_FOR_LIMIT },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (active >= LISTING_LIMITS[role]) {
    throw new AppError(
      403,
      'LISTING_LIMIT',
      `You can have up to ${LISTING_LIMITS[role]} live or in-review listings. Mark some as rented, sold or inactive first.`,
    );
  }
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
  if (input.status === 'pending') await assertUnderLimit(user.id, user.role);
  const loc = await resolveLocation(input.citySlug, input.localitySlug, { activeOnly: true });
  const doc = await Property.create({
    ...normaliseForType(input, input.listingType),
    slug: await uniqueSlug(`${input.title} ${loc.localityName}`),
    cityName: loc.cityName,
    localityName: loc.localityName,
    state: loc.state,
    areaSqft: toSqft(input.areaValue, input.areaUnit),
    postedBy: user.id,
    posterType: posterTypeFor(user.role),
    ...statusSideEffects({}, input.status),
    createdBy: user.id,
    updatedBy: user.id,
  });
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
  if (patch.status === 'pending' || wasLive) {
    await assertUnderLimit(user.id, user.role, doc._id);
    next.status = 'pending';
  }
  await applyUpdate(doc, next, user.id);
  if (wasLive || next.status === 'pending') {
    doc.moderationNote = undefined;
    await doc.save();
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
  if (status === 'pending') await assertUnderLimit(user.id, user.role, doc._id);
  await applyUpdate(doc, { status } as PropertyUpdate, user.id);
  return getMine(user.id, id);
}

export async function deleteMine(userId: string, id: string) {
  const doc = await ownedDoc(userId, id);
  if (doc.status === 'published') {
    throw badRequest('Mark the listing as rented, sold or inactive before deleting it');
  }
  return deleteProperty(String(doc._id));
}
