import { Schema, model, type InferSchemaType } from 'mongoose';
import { BLOG_CATEGORIES, BLOG_STATUSES } from '@nexus/shared';

const coverSchema = new Schema(
  {
    url: { type: String, required: true, maxlength: 1000 },
    publicId: { type: String, maxlength: 300 },
    alt: { type: String, default: '', maxlength: 160 },
    width: Number,
    height: Number,
  },
  { _id: false },
);

/** A blog article written by staff in the admin panel. Content is Markdown. */
const blogPostSchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 140 },
    slug: { type: String, required: true, lowercase: true, maxlength: 100 },
    /** Earlier slugs of a published post; old links redirect to the current slug. */
    previousSlugs: { type: [String], default: [] },
    excerpt: { type: String, default: '', maxlength: 300 },
    content: { type: String, required: true, maxlength: 100_000 },
    coverImage: { type: coverSchema, default: null },
    category: { type: String, enum: BLOG_CATEGORIES, default: 'buying' },
    tags: { type: [String], default: [] },
    authorName: { type: String, default: '', maxlength: 80 },
    status: { type: String, enum: BLOG_STATUSES, default: 'draft' },
    featured: { type: Boolean, default: false },
    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },
    readingMinutes: { type: Number, default: 1 },
    /** Set the first time the post is published; kept when it is unpublished and republished. */
    publishedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);
blogPostSchema.index({ slug: 1 }, { unique: true });
blogPostSchema.index({ previousSlugs: 1 });
blogPostSchema.index({ status: 1, publishedAt: -1 });
blogPostSchema.index({ status: 1, category: 1, publishedAt: -1 });
blogPostSchema.index({ status: 1, tags: 1, publishedAt: -1 });

export type BlogPostRaw = InferSchemaType<typeof blogPostSchema>;
export const BlogPost = model('BlogPost', blogPostSchema);

/**
 * One reading session of one article in one browser tab. The page sends cumulative
 * numbers, so a session is a single row that only ever grows. No personal data:
 * the visitor id is a random value kept in the reader's browser.
 */
const blogReadSchema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: 'BlogPost', required: true },
    sessionId: { type: String, required: true, maxlength: 64 },
    visitorId: { type: String, required: true, maxlength: 64 },
    startedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    /** Active reading seconds (tab visible, reader not idle). */
    seconds: { type: Number, default: 0 },
    /** Furthest point of the article reached, 0-100. */
    scroll: { type: Number, default: 0 },
    device: { type: String, enum: ['mobile', 'tablet', 'desktop'], default: 'desktop' },
    /** Referrer host, e.g. google.com; '' for direct visits. */
    source: { type: String, default: '', maxlength: 120 },
    /** This browser had read an article before this session. */
    returning: { type: Boolean, default: false },
  },
  { versionKey: false },
);
blogReadSchema.index({ post: 1, sessionId: 1 }, { unique: true });
blogReadSchema.index({ post: 1, startedAt: -1 });
blogReadSchema.index({ startedAt: -1 });
blogReadSchema.index({ visitorId: 1, startedAt: 1 });

export type BlogReadRaw = InferSchemaType<typeof blogReadSchema>;
export const BlogRead = model('BlogRead', blogReadSchema);
