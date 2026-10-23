import type { FilterQuery } from 'mongoose';
import { Types } from 'mongoose';
import type { z } from 'zod';
import {
  PROPERTY_TYPE_LABELS,
  slugify,
  type AdminProject,
  type OwnProject,
  type PaginationMeta,
  type ProjectCard,
  type ProjectConfiguration,
  type ProjectCreate,
  type ProjectSearch,
  type ProjectStatus,
  type ProjectUpdate,
  type PublicProject,
  type adminProjectQuerySchema,
  type adminProjectUpdateSchema,
} from '@nexus/shared';
import { Project, type ProjectAttrs } from '../models/project.model.js';
import { Enquiry } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { User } from '../models/user.model.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { env } from '../config/env.js';
import { resolveLocation } from './location.service.js';
import { deleteImages } from './upload.service.js';
import { sendMail } from './mail.service.js';
import { fromGeo, profilePathFor, toGeo } from './property.service.js';

type Lean = ProjectAttrs & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };

type Builder = {
  _id: Types.ObjectId;
  name: string;
  companyName?: string | null;
  verified?: boolean;
  profileSlug?: string | null;
  logoUrl?: string | null;
  email?: string;
  phone?: string;
  role: string;
};

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

function configLabel(c: { unitType: string; bedrooms?: number | null }) {
  const type = PROPERTY_TYPE_LABELS[c.unitType as keyof typeof PROPERTY_TYPE_LABELS] ?? c.unitType;
  return c.bedrooms ? `${c.bedrooms} BHK ${type}` : type;
}

/** "2, 3 BHK Apartments · Plots" for cards. */
function unitSummary(configs: Lean['configurations']) {
  const groups = new Map<string, Set<number>>();
  for (const c of configs) {
    const set = groups.get(c.unitType) ?? new Set<number>();
    if (c.bedrooms) set.add(c.bedrooms);
    groups.set(c.unitType, set);
  }
  return [...groups.entries()]
    .map(([type, beds]) => {
      const label = PROPERTY_TYPE_LABELS[type as keyof typeof PROPERTY_TYPE_LABELS] ?? type;
      return beds.size ? `${[...beds].sort((a, b) => a - b).join(', ')} BHK ${label}` : label;
    })
    .join(' · ');
}

function images(p: Lean) {
  return (p.images ?? []).map((i) => ({
    url: i.url,
    alt: i.alt || p.name,
    width: i.width ?? undefined,
    height: i.height ?? undefined,
    isDemo: i.isDemo ?? false,
  }));
}

type Core = Omit<PublicProject, 'builder'>;

function core(p: Lean): Core {
  const imgs = images(p);
  return {
    id: String(p._id),
    slug: p.slug,
    name: p.name,
    description: p.description,
    highlights: p.highlights ?? [],
    city: { slug: p.citySlug, name: p.cityName },
    locality: { slug: p.localitySlug, name: p.localityName },
    address: p.address ?? '',
    location: fromGeo(p.geo as Parameters<typeof fromGeo>[0]),
    stage: p.stage as PublicProject['stage'],
    launchDate: iso(p.launchDate),
    possessionDate: iso(p.possessionDate),
    reraId: p.reraId ?? null,
    totalUnits: p.totalUnits ?? null,
    totalTowers: p.totalTowers ?? null,
    landAreaAcres: p.landAreaAcres ?? null,
    configurations: (p.configurations ?? []).map((c) => ({
      unitType: c.unitType as PublicProject['configurations'][number]['unitType'],
      bedrooms: c.bedrooms ?? null,
      minAreaSqft: c.minAreaSqft,
      maxAreaSqft: c.maxAreaSqft,
      minPrice: c.minPrice,
      maxPrice: c.maxPrice,
      floorPlanUrl: c.floorPlanUrl ?? null,
      label: configLabel(c),
    })),
    priceRange: { min: p.minPrice ?? 0, max: p.maxPrice ?? 0 },
    amenities: (p.amenities ?? []) as PublicProject['amenities'],
    images: imgs,
    coverImage: imgs[p.coverImageIndex ?? 0] ?? imgs[0] ?? null,
    brochureUrl: p.brochureUrl ?? null,
    videoUrl: p.videoUrl ?? null,
    featured: p.featured ?? false,
    seoTitle: p.seoTitle ?? null,
    seoDescription: p.seoDescription ?? null,
    publishedAt: iso(p.publishedAt),
    updatedAt: iso(p.updatedAt)!,
  };
}

function builderRef(b: Builder | null | undefined): PublicProject['builder'] {
  return {
    id: b ? String(b._id) : '',
    name: b?.name ?? 'Builder',
    companyName: b?.companyName ?? null,
    verified: Boolean(b?.verified),
    profilePath: b ? profilePathFor(b.role, b.profileSlug) : null,
    logoUrl: b?.logoUrl ?? null,
  };
}

function toCard(p: Lean, b?: Builder | null): ProjectCard {
  const c = core(p);
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    city: c.city,
    locality: c.locality,
    stage: c.stage,
    possessionDate: c.possessionDate,
    reraId: c.reraId,
    priceRange: c.priceRange,
    coverImage: c.coverImage,
    featured: c.featured,
    location: c.location,
    builderName: b?.companyName || b?.name || 'Builder',
    unitSummary: unitSummary(p.configurations ?? []),
  };
}

function toOwn(p: Lean, enquiryCount = 0): OwnProject {
  return {
    ...core(p),
    images: (p.images ?? []).map((i) => ({
      url: i.url,
      publicId: i.publicId ?? undefined,
      alt: i.alt ?? '',
      width: i.width ?? undefined,
      height: i.height ?? undefined,
      isDemo: i.isDemo ?? false,
    })),
    status: p.status as ProjectStatus,
    citySlug: p.citySlug,
    localitySlug: p.localitySlug,
    coverImageIndex: p.coverImageIndex ?? 0,
    moderationNote: p.moderationNote ?? null,
    createdAt: iso(p.createdAt)!,
    enquiryCount,
  };
}

async function buildersById(ids: Types.ObjectId[]) {
  const unique = [...new Set(ids.map(String))];
  if (!unique.length) return new Map<string, Builder>();
  const rows = await User.find({ _id: { $in: unique } })
    .select('name companyName verified profileSlug logoUrl email phone role')
    .lean<Builder[]>();
  return new Map(rows.map((b) => [String(b._id), b]));
}

async function enquiryCounts(ids: Types.ObjectId[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = await Enquiry.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { project: { $in: ids }, status: { $ne: 'spam' } } },
    { $group: { _id: '$project', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** Denormalised price range and unit types, kept in step with configurations. */
function derived(configs: ProjectConfiguration[] | undefined) {
  if (!configs?.length) return {};
  return {
    minPrice: Math.min(...configs.map((c) => c.minPrice)),
    maxPrice: Math.max(...configs.map((c) => c.maxPrice)),
    unitTypes: [...new Set(configs.map((c) => c.unitType))],
    bedroomOptions: [
      ...new Set(configs.map((c) => c.bedrooms).filter((b): b is number => !!b)),
    ].sort((a, b) => a - b),
  };
}

function writable<T extends { location?: { lat: number; lng: number } | null }>(input: T) {
  const { location, ...rest } = input;
  return {
    ...rest,
    ...(location !== undefined ? { geo: location ? toGeo(location) : undefined } : {}),
  };
}

async function uniqueSlug(base: string, excludeId?: Types.ObjectId) {
  const root = slugify(base) || 'project';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const taken = await Project.exists({
      slug: candidate,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    });
    if (!taken) return candidate;
  }
  return `${root}-${new Types.ObjectId().toString().slice(-6)}`;
}

function statusSideEffects(current: Partial<Lean>, next: ProjectStatus) {
  const out: Record<string, unknown> = { status: next };
  if (next === 'published') {
    if (!current.publishedAt) out.publishedAt = new Date();
    out.moderationNote = undefined;
  }
  if (next === 'pending') out.submittedAt = new Date();
  if (next !== 'published') out.featured = false;
  return out;
}

function checkCover(p: { images?: unknown[]; coverImageIndex?: number }) {
  if (
    p.images &&
    p.coverImageIndex !== undefined &&
    p.images.length &&
    p.coverImageIndex >= p.images.length
  ) {
    throw badRequest('Cover image must be one of the uploaded images', {
      coverImageIndex: ['Choose one of the uploaded images'],
    });
  }
}

function requireImagesForReview(status: string | undefined, imgs: unknown[] | undefined) {
  if ((status === 'pending' || status === 'published') && !imgs?.length) {
    throw badRequest('Add at least one photo', {
      images: ['Add at least one photo before submitting'],
    });
  }
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

const LIVE = { status: 'published' } as const;

export async function searchProjects(
  q: Partial<ProjectSearch> & Pick<ProjectSearch, 'page' | 'limit'>,
): Promise<{ items: ProjectCard[]; meta: PaginationMeta }> {
  const f: FilterQuery<ProjectAttrs> = { ...LIVE };
  if (q.city) f.citySlug = q.city;
  if (q.locality) f.localitySlug = q.locality;
  if (q.stage) f.stage = q.stage;
  if (q.unitType) f.unitTypes = q.unitType;
  if (q.bedrooms) f.bedroomOptions = q.bedrooms;
  if (q.maxPrice) f.minPrice = { $lte: q.maxPrice };
  if (q.builder) f.builder = new Types.ObjectId(q.builder);
  const [rows, total] = await Promise.all([
    Project.find(f)
      .sort({ featured: -1, publishedAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    Project.countDocuments(f),
  ]);
  const builders = await buildersById(rows.map((r) => r.builder));
  return {
    items: rows.map((r) => toCard(r, builders.get(String(r.builder)))),
    meta: paginate(q.page, q.limit, total),
  };
}

export async function getPublicProject(slug: string): Promise<PublicProject> {
  const p = await Project.findOne({ slug, ...LIVE }).lean<Lean>();
  if (!p) throw notFound('Project not found');
  const builders = await buildersById([p.builder]);
  const b = builders.get(String(p.builder));
  if (!b) throw notFound('Project not found');
  return { ...core(p), builder: builderRef(b) };
}

export async function recordProjectView(id: string) {
  await Project.updateOne({ _id: id, ...LIVE }, { $inc: { views: 1 } });
}

export async function sitemapProjects() {
  const rows = await Project.find({ ...LIVE, isDemo: { $ne: true } })
    .select('slug updatedAt')
    .sort({ updatedAt: -1 })
    .limit(10_000)
    .lean();
  return rows.map((r) => ({ slug: r.slug, updatedAt: iso(r.updatedAt as Date)! }));
}

/** Live projects for a city (used by the listing form's "part of a project" picker). */
export async function projectOptions(citySlug: string) {
  const rows = await Project.find({ ...LIVE, citySlug })
    .select('name slug localitySlug')
    .sort({ name: 1 })
    .limit(500)
    .lean();
  return rows.map((r) => ({
    id: String(r._id),
    name: r.name,
    slug: r.slug,
    localitySlug: r.localitySlug,
  }));
}

/* ------------------------------------------------------------------ */
/* Builders' own projects                                              */
/* ------------------------------------------------------------------ */

async function owned(userId: string, id: string) {
  const doc = await Project.findOne({ _id: id, builder: userId });
  if (!doc) throw notFound('Project not found');
  return doc;
}

export async function listMyProjects(userId: string) {
  const rows = await Project.find({ builder: userId })
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean<Lean[]>();
  const counts = await enquiryCounts(rows.map((r) => r._id));
  return rows.map((r) => toOwn(r, counts.get(String(r._id)) ?? 0));
}

export async function getMyProject(userId: string, id: string) {
  const doc = await owned(userId, id);
  const counts = await enquiryCounts([doc._id]);
  return toOwn(doc.toObject() as unknown as Lean, counts.get(String(doc._id)) ?? 0);
}

export async function createMyProject(user: { id: string; role: string }, input: ProjectCreate) {
  if (user.role !== 'builder') throw forbidden('Only builder accounts can add projects');
  const loc = await resolveLocation(input.citySlug, input.localitySlug, { activeOnly: true });
  checkCover(input);
  requireImagesForReview(input.status, input.images);
  const doc = await Project.create({
    ...writable(input),
    ...derived(input.configurations),
    slug: await uniqueSlug(`${input.name} ${loc.localityName}`),
    cityName: loc.cityName,
    localityName: loc.localityName,
    state: loc.state,
    builder: user.id,
    ...statusSideEffects({}, input.status),
  });
  return getMyProject(user.id, String(doc._id));
}

/** Editing a live project sends it back for review, like listings. */
export async function updateMyProject(user: { id: string }, id: string, patch: ProjectUpdate) {
  const doc = await owned(user.id, id);
  const current = doc.toObject() as unknown as Lean;
  if (patch.citySlug || patch.localitySlug) {
    const loc = await resolveLocation(
      patch.citySlug ?? current.citySlug,
      patch.localitySlug ?? current.localitySlug,
      { activeOnly: true },
    );
    doc.set({ cityName: loc.cityName, localityName: loc.localityName, state: loc.state });
  }
  const next = { ...patch } as ProjectUpdate & { status?: ProjectStatus };
  if (
    current.status === 'published' ||
    current.status === 'rejected' ||
    patch.status === 'pending'
  ) {
    next.status = 'pending';
  }
  const merged = { ...current, ...patch };
  checkCover(merged);
  requireImagesForReview(next.status ?? current.status, merged.images as unknown[]);
  dropRemovedImages(current, patch);
  doc.set({ ...writable(next), ...derived(patch.configurations) });
  if (next.status) doc.set(statusSideEffects(current, next.status));
  await doc.save();
  return getMyProject(user.id, id);
}

export async function setMyProjectStatus(user: { id: string }, id: string, status: ProjectStatus) {
  const doc = await owned(user.id, id);
  const allowed: Record<string, ProjectStatus[]> = {
    draft: ['pending'],
    rejected: ['pending', 'draft'],
    pending: ['draft'],
    published: ['inactive'],
    inactive: ['pending'],
  };
  if (!(allowed[doc.status] ?? []).includes(status)) {
    throw badRequest(`A project that is ${doc.status} cannot be changed to ${status}`);
  }
  requireImagesForReview(status, doc.images);
  doc.set(statusSideEffects(doc.toObject() as unknown as Lean, status));
  await doc.save();
  return getMyProject(user.id, id);
}

export async function deleteMyProject(userId: string, id: string) {
  const doc = await owned(userId, id);
  if (doc.status === 'published') throw badRequest('Mark the project inactive before deleting it');
  return deleteProject(String(doc._id));
}

function dropRemovedImages(current: Lean, patch: { images?: { publicId?: string }[] }) {
  if (!patch.images) return;
  const keep = new Set(patch.images.map((i) => i.publicId).filter(Boolean));
  const removed = (current.images ?? [])
    .map((i) => i.publicId)
    .filter((p): p is string => !!p && !keep.has(p));
  if (removed.length) void deleteImages(removed);
}

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

function toAdmin(p: Lean, b: Builder | null | undefined, enquiries = 0): AdminProject {
  return {
    ...toOwn(p, enquiries),
    builder: b
      ? {
          id: String(b._id),
          name: b.companyName || b.name,
          email: b.email ?? '',
          phone: b.phone ?? '',
        }
      : null,
  };
}

export async function listAdminProjects(q: z.output<typeof adminProjectQuerySchema>) {
  const f: FilterQuery<ProjectAttrs> = {};
  if (q.status) f.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    f.$or = [{ name: rx }, { slug: rx }, { localityName: rx }];
  }
  const sort: Record<string, 1 | -1> =
    q.status === 'pending' ? { submittedAt: 1 } : { updatedAt: -1 };
  const [rows, total] = await Promise.all([
    Project.find(f)
      .sort(sort)
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    Project.countDocuments(f),
  ]);
  const [builders, counts] = await Promise.all([
    buildersById(rows.map((r) => r.builder)),
    enquiryCounts(rows.map((r) => r._id)),
  ]);
  return {
    items: rows.map((r) =>
      toAdmin(r, builders.get(String(r.builder)), counts.get(String(r._id)) ?? 0),
    ),
    meta: paginate(q.page, q.limit, total),
  };
}

export async function getAdminProject(id: string) {
  const p = await Project.findById(id).lean<Lean>();
  if (!p) throw notFound('Project not found');
  const [builders, counts] = await Promise.all([buildersById([p.builder]), enquiryCounts([p._id])]);
  return toAdmin(p, builders.get(String(p.builder)), counts.get(String(p._id)) ?? 0);
}

export async function updateAdminProject(
  id: string,
  patch: z.output<typeof adminProjectUpdateSchema>,
) {
  const doc = await Project.findById(id);
  if (!doc) throw notFound('Project not found');
  const current = doc.toObject() as unknown as Lean;
  if (patch.slug && patch.slug !== current.slug) {
    if (await Project.exists({ slug: patch.slug, _id: { $ne: doc._id } })) {
      throw conflict('That URL slug is already used by another project');
    }
  }
  if (patch.citySlug || patch.localitySlug) {
    const loc = await resolveLocation(
      patch.citySlug ?? current.citySlug,
      patch.localitySlug ?? current.localitySlug,
    );
    doc.set({ cityName: loc.cityName, localityName: loc.localityName, state: loc.state });
  }
  checkCover({ ...current, ...patch });
  dropRemovedImages(current, patch);
  if (patch.featured && current.status !== 'published') {
    throw badRequest('Only live projects can be featured');
  }
  doc.set({ ...writable(patch), ...derived(patch.configurations) });
  await doc.save();
  return getAdminProject(id);
}

export async function changeProjectStatus(id: string, status: ProjectStatus, note?: string) {
  const doc = await Project.findById(id);
  if (!doc) throw notFound('Project not found');
  if (status === 'rejected' && !note?.trim()) {
    throw badRequest('Tell the builder what to change', { note: ['Add a note for the builder'] });
  }
  requireImagesForReview(status, doc.images);
  const before = doc.status;
  doc.set(statusSideEffects(doc.toObject() as unknown as Lean, status));
  if (status === 'rejected') doc.moderationNote = note!.trim();
  await doc.save();
  if (before === 'pending' && (status === 'published' || status === 'rejected')) {
    void notifyBuilder(doc.builder, doc.name, doc.slug, status, note);
  }
  return getAdminProject(id);
}

async function notifyBuilder(
  userId: Types.ObjectId,
  name: string,
  slug: string,
  status: 'published' | 'rejected',
  note?: string,
) {
  const u = await User.findById(userId).select('email name').lean();
  if (!u) return;
  if (status === 'published') {
    await sendMail(
      u.email,
      `Your project is live: ${name}`,
      [`Hi ${u.name},`, `“${name}” has been approved and is now live on NEXUS Estate.`],
      { label: 'View project', url: `${env.PUBLIC_SITE_URL}/projects/${slug}` },
    );
  } else {
    await sendMail(
      u.email,
      `Changes needed: ${name}`,
      [`Hi ${u.name},`, `Our team reviewed “${name}” and needs a few changes:`, note ?? ''],
      { label: 'Edit project', url: `${env.PUBLIC_SITE_URL}/dashboard/projects` },
    );
  }
}

export async function deleteProject(id: string) {
  const doc = await Project.findById(id);
  if (!doc) throw notFound('Project not found');
  const ids = doc.images.map((i) => i.publicId).filter((p): p is string => !!p);
  await Property.updateMany({ projectId: doc._id }, { $set: { projectId: null } });
  await doc.deleteOne();
  if (ids.length) void deleteImages(ids);
  return { id, name: doc.name };
}
