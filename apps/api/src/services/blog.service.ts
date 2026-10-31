import { Types } from 'mongoose';
import {
  BLOG_RESERVED_SLUGS,
  slugify,
  type AdminBlogPost,
  type BlogPostCard,
  type BlogPostInput,
  type BlogSearch,
  type PublicBlogPost,
  type adminBlogQuerySchema,
} from '@nexus/shared';
import type { z } from 'zod';
import { BlogPost, type BlogPostRaw } from '../models/blog.model.js';
import { conflict, notFound } from '../lib/errors.js';
import { escapeRegex, paginate } from '../lib/respond.js';
import { deleteImages } from './upload.service.js';

type Lean = BlogPostRaw & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};

const PUBLISHED = { status: 'published' } as const;
const CARD_FIELDS = '-content -previousSlugs -createdBy -updatedBy';
const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);

/** About 200 words a minute; Markdown syntax is stripped before counting. */
export function readingMinutes(markdown: string): number {
  const words = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

function toCard(p: Lean): BlogPostCard {
  return {
    id: String(p._id),
    slug: p.slug,
    title: p.title,
    excerpt: p.excerpt ?? '',
    coverImage: p.coverImage
      ? {
          url: p.coverImage.url,
          publicId: p.coverImage.publicId ?? undefined,
          alt: p.coverImage.alt ?? '',
          width: p.coverImage.width ?? undefined,
          height: p.coverImage.height ?? undefined,
        }
      : null,
    category: p.category!,
    tags: p.tags ?? [],
    authorName: p.authorName ?? '',
    featured: !!p.featured,
    readingMinutes: p.readingMinutes ?? 1,
    publishedAt: iso(p.publishedAt),
    updatedAt: iso(p.updatedAt)!,
  };
}

function toPublic(p: Lean): PublicBlogPost {
  return {
    ...toCard(p),
    content: p.content,
    seoTitle: p.seoTitle ?? undefined,
    seoDescription: p.seoDescription ?? undefined,
  };
}

function toAdmin(p: Lean): AdminBlogPost {
  return { ...toPublic(p), status: p.status!, createdAt: iso(p.createdAt)! };
}

/* ---------------- Public ---------------- */

export async function listPublic(q: BlogSearch) {
  const filter: Record<string, unknown> = { ...PUBLISHED };
  if (q.category) filter.category = q.category;
  if (q.tag) filter.tags = q.tag;
  const [rows, total] = await Promise.all([
    BlogPost.find(filter)
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    BlogPost.countDocuments(filter),
  ]);
  return { items: rows.map(toCard), meta: paginate(q.page, q.limit, total) };
}

export async function getPublicBySlug(
  slug: string,
): Promise<
  | { kind: 'post'; post: PublicBlogPost; related: BlogPostCard[] }
  | { kind: 'redirect'; slug: string }
> {
  const post = await BlogPost.findOne({ ...PUBLISHED, slug }).lean<Lean>();
  if (!post) {
    const moved = await BlogPost.findOne({ ...PUBLISHED, previousSlugs: slug })
      .select('slug')
      .lean<Pick<Lean, 'slug'>>();
    if (moved) return { kind: 'redirect', slug: moved.slug };
    throw notFound('Article not found');
  }
  // Same category first, then the latest posts, never the post itself.
  const sameCategory = await BlogPost.find({
    ...PUBLISHED,
    category: post.category,
    _id: { $ne: post._id },
  })
    .select(CARD_FIELDS)
    .sort({ publishedAt: -1 })
    .limit(3)
    .lean<Lean[]>();
  let related = sameCategory;
  if (related.length < 3) {
    const more = await BlogPost.find({
      ...PUBLISHED,
      _id: { $nin: [post._id, ...related.map((r) => r._id)] },
    })
      .select(CARD_FIELDS)
      .sort({ publishedAt: -1 })
      .limit(3 - related.length)
      .lean<Lean[]>();
    related = [...related, ...more];
  }
  return { kind: 'post', post: toPublic(post), related: related.map(toCard) };
}

export async function sitemapBlog() {
  const rows = await BlogPost.find(PUBLISHED)
    .select('slug updatedAt')
    .sort({ publishedAt: -1 })
    .limit(10_000)
    .lean<Pick<Lean, 'slug' | 'updatedAt'>[]>();
  return rows.map((r) => ({ slug: r.slug, updatedAt: iso(r.updatedAt)! }));
}

/* ---------------- Admin ---------------- */

export async function listAdmin(q: z.output<typeof adminBlogQuerySchema>) {
  const filter: Record<string, unknown> = {};
  if (q.status) filter.status = q.status;
  if (q.category) filter.category = q.category;
  if (q.q) filter.title = { $regex: escapeRegex(q.q), $options: 'i' };
  const [rows, total] = await Promise.all([
    BlogPost.find(filter)
      .select('-content -previousSlugs')
      .sort({ updatedAt: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<Lean[]>(),
    BlogPost.countDocuments(filter),
  ]);
  return {
    items: rows.map((r) => toAdmin({ ...r, content: '' })),
    meta: paginate(q.page, q.limit, total),
  };
}

export async function getAdmin(id: string) {
  const p = await BlogPost.findById(id).lean<Lean>();
  if (!p) throw notFound('Article not found');
  return toAdmin(p);
}

const isReserved = (slug: string) => (BLOG_RESERVED_SLUGS as readonly string[]).includes(slug);

async function slugTaken(slug: string, excludeId?: string) {
  const notSelf = excludeId ? { _id: { $ne: new Types.ObjectId(excludeId) } } : {};
  return !!(await BlogPost.exists({ $or: [{ slug }, { previousSlugs: slug }], ...notSelf }));
}

async function uniqueSlug(base: string, excludeId?: string) {
  const root = slugify(base) || 'article';
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 && !isReserved(root) ? root : `${root}-${i + 1}`;
    if (!(await slugTaken(candidate, excludeId))) return candidate;
  }
  return `${root}-${new Types.ObjectId().toString().slice(-6)}`;
}

async function ensureSlugFree(slug: string, excludeId?: string) {
  if (isReserved(slug)) throw conflict('That URL is reserved. Choose another slug.');
  if (await slugTaken(slug, excludeId))
    throw conflict('That URL slug is already used by another article');
}

export async function createPost(input: BlogPostInput, adminId: string) {
  let slug: string;
  if (input.slug) {
    await ensureSlugFree(input.slug);
    slug = input.slug;
  } else slug = await uniqueSlug(input.title);
  const doc = await BlogPost.create({
    ...input,
    slug,
    readingMinutes: readingMinutes(input.content),
    publishedAt: input.status === 'published' ? new Date() : null,
    createdBy: adminId,
    updatedBy: adminId,
  });
  return toAdmin(doc.toObject() as unknown as Lean);
}

export async function updatePost(id: string, patch: Partial<BlogPostInput>, adminId: string) {
  const current = await BlogPost.findById(id);
  if (!current) throw notFound('Article not found');

  const set: Record<string, unknown> = { ...patch, updatedBy: adminId };
  if (patch.slug && patch.slug !== current.slug) {
    await ensureSlugFree(patch.slug, id);
    // Keep old links of a live post working.
    if (current.status === 'published' || current.publishedAt) {
      set.previousSlugs = [...new Set([...(current.previousSlugs ?? []), current.slug])].filter(
        (s) => s !== patch.slug,
      );
    }
  }
  if (patch.content !== undefined) set.readingMinutes = readingMinutes(patch.content);
  if (patch.status === 'published' && !current.publishedAt) set.publishedAt = new Date();

  const replacedCover =
    patch.coverImage !== undefined &&
    current.coverImage?.publicId &&
    current.coverImage.publicId !== patch.coverImage?.publicId
      ? current.coverImage.publicId
      : null;

  const doc = await BlogPost.findByIdAndUpdate(
    id,
    { $set: set },
    { new: true, runValidators: true },
  ).lean<Lean>();
  if (!doc) throw notFound('Article not found');
  if (replacedCover) await deleteImages([replacedCover]);
  return toAdmin(doc);
}

export async function deletePost(id: string) {
  const doc = await BlogPost.findByIdAndDelete(id).lean<Lean>();
  if (!doc) throw notFound('Article not found');
  if (doc.coverImage?.publicId) await deleteImages([doc.coverImage.publicId]);
  return { title: doc.title };
}
