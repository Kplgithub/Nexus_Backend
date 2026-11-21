import type { Types } from 'mongoose';
import type { FeaturedListing, ListingType, PropertyStatus } from '@nexus/shared';
import { Property } from '../models/property.model.js';
import { badRequest, notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const DAY = 86_400_000;

type Lean = {
  _id: Types.ObjectId;
  title: string;
  slug: string;
  status: PropertyStatus;
  listingType: ListingType;
  localityName: string;
  price: number;
  featuredUntil?: Date | null;
  postedBy?: { _id: Types.ObjectId; name: string } | null;
};

const toDto = (p: Lean): FeaturedListing => ({
  id: String(p._id),
  title: p.title,
  slug: p.slug,
  status: p.status,
  listingType: p.listingType,
  localityName: p.localityName,
  price: p.price,
  featuredUntil: p.featuredUntil ? p.featuredUntil.toISOString() : null,
  postedBy: p.postedBy ? { id: String(p.postedBy._id), name: p.postedBy.name } : null,
});

const FIELDS = 'title slug status listingType localityName price featuredUntil postedBy';

export async function listFeatured() {
  const rows = await Property.find({ featured: true })
    .sort({ featuredUntil: 1 })
    .select(FIELDS)
    .populate('postedBy', 'name')
    .lean<Lean[]>();
  return rows.map(toDto);
}

/** Feature a live listing for `days` days (extends from today), or remove it with 0. */
export async function setFeatured(id: string, days: number) {
  const p = await Property.findById(id);
  if (!p) throw notFound('Property not found');
  if (days > 0 && p.status !== 'published') throw badRequest('Only live listings can be featured');
  p.featured = days > 0;
  p.featuredUntil = days > 0 ? new Date(Date.now() + days * DAY) : null;
  await p.save();
  const fresh = await Property.findById(id)
    .select(FIELDS)
    .populate('postedBy', 'name')
    .lean<Lean>();
  return toDto(fresh!);
}

/** Ends featured placements whose time is up. Safe to run often. */
export async function expireFeatured(now = new Date()) {
  const r = await Property.updateMany(
    { featured: true, featuredUntil: { $ne: null, $lte: now } },
    { $set: { featured: false, featuredUntil: null } },
  );
  if (r.modifiedCount) logger.info({ n: r.modifiedCount }, 'featured listings expired');
  return r.modifiedCount;
}
