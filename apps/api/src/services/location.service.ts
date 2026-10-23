import { slugify, type City as CityDto } from '@nexus/shared';
import { City } from '../models/misc.models.js';
import { Property } from '../models/property.model.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import type { z } from 'zod';
import type { cityCreateSchema, cityUpdateSchema } from '@nexus/shared';

type CityLean = {
  _id: unknown;
  name: string;
  slug: string;
  state: string;
  active: boolean;
  sortOrder: number;
  intro: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  localities: {
    name: string;
    slug: string;
    active: boolean;
    intro: string;
    seoTitle?: string | null;
    seoDescription?: string | null;
  }[];
};

function toDto(c: CityLean, counts?: Map<string, number>): CityDto {
  return {
    id: String(c._id),
    name: c.name,
    slug: c.slug,
    state: c.state,
    active: c.active,
    sortOrder: c.sortOrder,
    intro: c.intro,
    seoTitle: c.seoTitle ?? undefined,
    seoDescription: c.seoDescription ?? undefined,
    publishedCount: counts?.get(c.slug) ?? undefined,
    localities: c.localities.map((l) => ({
      name: l.name,
      slug: l.slug,
      active: l.active,
      intro: l.intro,
      seoTitle: l.seoTitle ?? undefined,
      seoDescription: l.seoDescription ?? undefined,
      publishedCount: counts?.get(`${c.slug}/${l.slug}`) ?? undefined,
    })),
  };
}

/** Counts of publicly visible listings per city and per city/locality. */
async function visibleCounts(): Promise<Map<string, number>> {
  const rows = await Property.aggregate<{ _id: { c: string; l: string }; n: number }>([
    { $match: { status: 'published', listingVisibility: 'public' } },
    { $group: { _id: { c: '$citySlug', l: '$localitySlug' }, n: { $sum: 1 } } },
  ]);
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(r._id.c, (map.get(r._id.c) ?? 0) + r.n);
    map.set(`${r._id.c}/${r._id.l}`, r.n);
  }
  return map;
}

export async function listPublicLocations(): Promise<CityDto[]> {
  const [cities, counts] = await Promise.all([
    City.find({ active: true }).sort({ sortOrder: 1, name: 1 }).lean<CityLean[]>(),
    visibleCounts(),
  ]);
  return cities.map((c) => {
    const dto = toDto({ ...c, localities: c.localities.filter((l) => l.active) }, counts);
    dto.publishedCount = counts.get(c.slug) ?? 0;
    for (const l of dto.localities) l.publishedCount = counts.get(`${c.slug}/${l.slug}`) ?? 0;
    return dto;
  });
}

export async function listAllLocations(): Promise<CityDto[]> {
  const [cities, counts] = await Promise.all([
    City.find().sort({ sortOrder: 1, name: 1 }).lean<CityLean[]>(),
    visibleCounts(),
  ]);
  return cities.map((c) => toDto(c, counts));
}

export async function getPublicCity(slug: string): Promise<CityDto> {
  const c = await City.findOne({ slug, active: true }).lean<CityLean>();
  if (!c) throw notFound('City not found');
  const counts = await visibleCounts();
  const dto = toDto({ ...c, localities: c.localities.filter((l) => l.active) }, counts);
  dto.publishedCount = counts.get(c.slug) ?? 0;
  for (const l of dto.localities) l.publishedCount = counts.get(`${c.slug}/${l.slug}`) ?? 0;
  return dto;
}

/** Resolve slugs to display names for a property. Throws 400 if the location isn't configured. */
/**
 * Resolve slugs to display names. Staff may use inactive locations (to prepare
 * listings before an area launches); users may only post in active ones.
 */
export async function resolveLocation(
  citySlug: string,
  localitySlug: string,
  opts: { activeOnly?: boolean } = {},
) {
  const city = await City.findOne({ slug: citySlug }).lean<CityLean>();
  if (!city || (opts.activeOnly && !city.active)) {
    throw badRequest('Unknown city', {
      citySlug: [
        opts.activeOnly ? 'Choose a city from the list' : 'Add this city under Locations first',
      ],
    });
  }
  const locality = city.localities.find((l) => l.slug === localitySlug);
  if (!locality || (opts.activeOnly && !locality.active)) {
    throw badRequest('Unknown locality', {
      localitySlug: [
        opts.activeOnly
          ? 'Choose a locality from the list'
          : 'Add this locality under Locations first',
      ],
    });
  }
  return { cityName: city.name, localityName: locality.name, state: city.state };
}

function normaliseLocalities<T extends { name: string; slug?: string }>(list: T[]) {
  const seen = new Set<string>();
  return list.map((l) => {
    const slug = l.slug || slugify(l.name);
    if (seen.has(slug)) throw badRequest(`Duplicate locality "${l.name}"`);
    seen.add(slug);
    return { ...l, slug };
  });
}

export async function createCity(input: z.output<typeof cityCreateSchema>) {
  const slug = input.slug || slugify(input.name);
  if (await City.exists({ slug })) throw conflict('A city with this slug already exists');
  const doc = await City.create({
    ...input,
    slug,
    localities: normaliseLocalities(input.localities),
  });
  return toDto(doc.toObject() as unknown as CityLean);
}

export async function updateCity(id: string, patch: z.output<typeof cityUpdateSchema>) {
  const city = await City.findById(id);
  if (!city) throw notFound('City not found');
  if (patch.slug && patch.slug !== city.slug) {
    const inUse = await Property.exists({ citySlug: city.slug });
    if (inUse) throw conflict('Cannot change the slug of a city that has listings');
  }
  if (patch.localities) {
    const next = normaliseLocalities(patch.localities);
    const removed = city.localities
      .map((l) => l.slug)
      .filter((s) => !next.some((n) => n.slug === s));
    if (removed.length) {
      const inUse = await Property.exists({ citySlug: city.slug, localitySlug: { $in: removed } });
      if (inUse)
        throw conflict('A locality you removed still has listings. Deactivate it instead.');
    }
    patch = { ...patch, localities: next };
  }
  city.set(patch);
  await city.save();
  // Keep denormalised names on listings in sync.
  await Property.updateMany(
    { citySlug: city.slug },
    { $set: { cityName: city.name, state: city.state } },
  );
  for (const l of city.localities) {
    await Property.updateMany(
      { citySlug: city.slug, localitySlug: l.slug },
      { $set: { localityName: l.name } },
    );
  }
  return toDto(city.toObject() as unknown as CityLean);
}

export async function deleteCity(id: string) {
  const city = await City.findById(id);
  if (!city) throw notFound('City not found');
  if (await Property.exists({ citySlug: city.slug })) {
    throw conflict('This city has listings. Deactivate it instead of deleting.');
  }
  await city.deleteOne();
}
