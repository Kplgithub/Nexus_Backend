import { Types, type PipelineStage } from 'mongoose';
import type {
  BlogAnalyticsCount,
  BlogAnalyticsDay,
  BlogAnalyticsOverview,
  BlogAnalyticsRange,
  BlogPostAnalytics,
  BlogReadInput,
  BlogReadStats,
  BlogStatus,
} from '@nexus/shared';
import { env } from '../config/env.js';
import { BlogPost, BlogRead } from '../models/blog.model.js';
import { notFound } from '../lib/errors.js';

const TZ = 'Asia/Kolkata';
/** Scroll % that counts as "read to the end". */
const COMPLETE_AT = 90;
const BOT_UA =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview|headless|lighthouse|pagespeed|curl|wget|python|axios|node-fetch|go-http/i;

export const isBot = (ua: string | undefined) => !ua || BOT_UA.test(ua);

export function deviceOf(ua: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  if (!ua) return 'desktop';
  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

const ownHost = (() => {
  try {
    return new URL(env.PUBLIC_SITE_URL).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
})();

/** Referrer URL -> host without "www."; '' for direct visits or links within our own site. */
export function sourceOf(referrer: string | undefined): string {
  if (!referrer) return '';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
    if (!host) return '';
    if (host === ownHost) return 'internal';
    return host.slice(0, 120);
  } catch {
    return '';
  }
}

/**
 * Records progress of one reading session. Repeated beacons for the same session only
 * raise the time and scroll numbers, so retries and out-of-order beacons are harmless.
 * Returns false when the post is not published (nothing is stored).
 */
export async function recordRead(
  postId: string,
  input: BlogReadInput,
  meta: { userAgent?: string },
): Promise<boolean> {
  const post = await BlogPost.exists({ _id: postId, status: 'published' });
  if (!post) return false;
  const now = new Date();
  const filter = { post: post._id, sessionId: input.sessionId };
  const grow = {
    $max: { seconds: input.seconds, scroll: input.scroll },
    $set: { lastSeenAt: now },
  };
  const existing = await BlogRead.updateOne(filter, grow);
  if (existing.matchedCount) return true;

  const returning = !!(await BlogRead.exists({ visitorId: input.visitorId }));
  try {
    await BlogRead.create({
      ...filter,
      visitorId: input.visitorId,
      startedAt: now,
      lastSeenAt: now,
      seconds: input.seconds,
      scroll: input.scroll,
      device: deviceOf(meta.userAgent),
      source: sourceOf(input.referrer),
      returning,
    });
  } catch (err) {
    // Two beacons of a new session raced; the other one created the row.
    if ((err as { code?: number }).code !== 11000) throw err;
    await BlogRead.updateOne(filter, grow);
  }
  return true;
}

/* ---------------- Reporting ---------------- */

const statsGroup = {
  views: { $sum: 1 },
  visitors: { $addToSet: '$visitorId' },
  totalSeconds: { $sum: '$seconds' },
  completed: { $sum: { $cond: [{ $gte: ['$scroll', COMPLETE_AT] }, 1, 0] } },
};

type RawStats = { views: number; visitors: string[]; totalSeconds: number; completed: number };

export const emptyStats = () => toStats(null);

function toStats(r?: Partial<RawStats> | null): BlogReadStats {
  const views = r?.views ?? 0;
  const totalSeconds = r?.totalSeconds ?? 0;
  const completed = r?.completed ?? 0;
  return {
    views,
    readers: r?.visitors?.length ?? 0,
    totalSeconds,
    avgSeconds: views ? Math.round(totalSeconds / views) : 0,
    completed,
    completionRate: views ? Math.round((completed / views) * 100) : 0,
  };
}

const dayKey = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);

function rangeOf(days: number): { range: BlogAnalyticsRange; since: Date; keys: string[] } {
  const now = new Date();
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(new Date(now.getTime() - i * 86_400_000)));
  // Start of the first day in India time (IST has no DST, +05:30).
  const since = new Date(`${keys[0]}T00:00:00+05:30`);
  return { range: { days, from: keys[0]!, to: keys[keys.length - 1]! }, since, keys };
}

async function daily(match: Record<string, unknown>, keys: string[]): Promise<BlogAnalyticsDay[]> {
  const rows = await BlogRead.aggregate<{ _id: string } & RawStats>([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$startedAt', timezone: TZ } },
        ...statsGroup,
      },
    },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, toStats(r)]));
  return keys.map((date) => {
    const s = byDay.get(date);
    return { date, views: s?.views ?? 0, readers: s?.readers ?? 0, avgSeconds: s?.avgSeconds ?? 0 };
  });
}

async function totalsOf(match: Record<string, unknown>) {
  const [row] = await BlogRead.aggregate<RawStats>([
    { $match: match },
    { $group: { _id: null, ...statsGroup } },
  ]);
  return toStats(row);
}

/** All-time numbers for a set of posts (admin list). */
export async function statsForPosts(ids: string[]): Promise<Map<string, BlogReadStats>> {
  if (!ids.length) return new Map();
  const rows = await BlogRead.aggregate<{ _id: Types.ObjectId } & RawStats>([
    { $match: { post: { $in: ids.map((id) => new Types.ObjectId(id)) } } },
    { $group: { _id: '$post', ...statsGroup } },
  ]);
  return new Map(rows.map((r) => [String(r._id), toStats(r)]));
}

/** Whole-blog report: totals, daily trend and every post ranked by views in the period. */
export async function overview(days: number): Promise<BlogAnalyticsOverview> {
  const { range, since, keys } = rangeOf(days);
  const match = { startedAt: { $gte: since } };
  const [totals, trend, perPost] = await Promise.all([
    totalsOf(match),
    daily(match, keys),
    BlogRead.aggregate<{ _id: Types.ObjectId } & RawStats>([
      { $match: match },
      { $group: { _id: '$post', ...statsGroup } },
    ]),
  ]);
  const posts = await BlogPost.find({ _id: { $in: perPost.map((p) => p._id) } })
    .select('title slug status publishedAt')
    .lean<
      {
        _id: Types.ObjectId;
        title: string;
        slug: string;
        status: BlogStatus;
        publishedAt: Date | null;
      }[]
    >();
  const byId = new Map(posts.map((p) => [String(p._id), p]));
  const rows = perPost
    .flatMap((r) => {
      const p = byId.get(String(r._id));
      if (!p) return []; // deleted post
      return [
        {
          id: String(p._id),
          title: p.title,
          slug: p.slug,
          status: p.status,
          publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
          ...toStats(r),
        },
      ];
    })
    .sort((a, b) => b.views - a.views || b.totalSeconds - a.totalSeconds);
  return { range, totals, daily: trend, posts: rows };
}

const TIME_BUCKETS: [string, number, number][] = [
  ['Under 10 sec', 0, 10],
  ['10–30 sec', 10, 30],
  ['30 sec – 1 min', 30, 60],
  ['1–3 min', 60, 180],
  ['3–5 min', 180, 300],
  ['5 min +', 300, Infinity],
];

const countBy = (field: string): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  { $sort: { count: -1 } },
];

/** One article's report for the last `days` days, plus all-time totals. */
export async function postReport(id: string, days: number): Promise<BlogPostAnalytics> {
  const post = await BlogPost.findById(id).select('title slug status readingMinutes').lean<{
    _id: Types.ObjectId;
    title: string;
    slug: string;
    status: BlogStatus;
    readingMinutes?: number;
  }>();
  if (!post) throw notFound('Article not found');
  const { range, since, keys } = rangeOf(days);
  const match = { post: post._id, startedAt: { $gte: since } };

  const [facets] = await BlogRead.aggregate<{
    totals: (RawStats & { engaged: number; quickExits: number; returning: string[] })[];
    scroll: { s25: number; s50: number; s75: number; s100: number }[];
    time: { _id: number | string; count: number }[];
    devices: { _id: string; count: number }[];
    sources: { _id: string; count: number }[];
    recent: {
      startedAt: Date;
      seconds: number;
      scroll: number;
      device: string;
      source: string;
      returning: boolean;
    }[];
  }>([
    { $match: match },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              ...statsGroup,
              engaged: { $sum: { $cond: [{ $gte: ['$seconds', 30] }, 1, 0] } },
              quickExits: { $sum: { $cond: [{ $lt: ['$seconds', 10] }, 1, 0] } },
              returning: { $addToSet: { $cond: ['$returning', '$visitorId', '$$REMOVE'] } },
            },
          },
        ],
        scroll: [
          {
            $group: {
              _id: null,
              s25: { $sum: { $cond: [{ $gte: ['$scroll', 25] }, 1, 0] } },
              s50: { $sum: { $cond: [{ $gte: ['$scroll', 50] }, 1, 0] } },
              s75: { $sum: { $cond: [{ $gte: ['$scroll', 75] }, 1, 0] } },
              s100: { $sum: { $cond: [{ $gte: ['$scroll', COMPLETE_AT] }, 1, 0] } },
            },
          },
        ],
        time: [
          {
            $bucket: {
              groupBy: '$seconds',
              boundaries: [0, 10, 30, 60, 180, 300],
              default: 'more',
              output: { count: { $sum: 1 } },
            },
          },
        ],
        devices: countBy('device'),
        sources: [...countBy('source'), { $limit: 10 }],
        recent: [
          { $sort: { startedAt: -1 } },
          { $limit: 25 },
          {
            $project: {
              _id: 0,
              startedAt: 1,
              seconds: 1,
              scroll: 1,
              device: 1,
              source: 1,
              returning: 1,
            },
          },
        ],
      },
    },
  ]);

  const [trend, allTime] = await Promise.all([daily(match, keys), totalsOf({ post: post._id })]);
  const t = facets?.totals[0];
  const sc = facets?.scroll[0];
  const timeMap = new Map(
    (facets?.time ?? []).map((b) => [b._id === 'more' ? 300 : Number(b._id), b.count]),
  );
  const sourceLabel = (s: string) =>
    s === '' ? 'Direct / unknown' : s === 'internal' ? 'NEXUS website' : s;

  return {
    post: {
      id: String(post._id),
      title: post.title,
      slug: post.slug,
      status: post.status,
      readingMinutes: post.readingMinutes ?? 1,
    },
    range,
    totals: {
      ...toStats(t),
      engaged: t?.engaged ?? 0,
      quickExits: t?.quickExits ?? 0,
      returningReaders: t?.returning?.length ?? 0,
    },
    allTime,
    daily: trend,
    scrollDepth: [
      { label: '25%', count: sc?.s25 ?? 0 },
      { label: '50%', count: sc?.s50 ?? 0 },
      { label: '75%', count: sc?.s75 ?? 0 },
      { label: 'End', count: sc?.s100 ?? 0 },
    ],
    timeBuckets: TIME_BUCKETS.map(([label, from]) => ({ label, count: timeMap.get(from) ?? 0 })),
    devices: (facets?.devices ?? []).map((d) => ({ label: d._id, count: d.count })),
    sources: (facets?.sources ?? []).map((s) => ({
      label: sourceLabel(s._id),
      count: s.count,
    })) as BlogAnalyticsCount[],
    recent: (facets?.recent ?? []).map((r) => ({
      at: r.startedAt.toISOString(),
      seconds: r.seconds,
      scroll: r.scroll,
      device: r.device,
      source: sourceLabel(r.source),
      returning: r.returning,
    })),
  };
}

/** Removes the reading history of a deleted article. */
export async function deleteReadsFor(postId: string) {
  await BlogRead.deleteMany({ post: new Types.ObjectId(postId) });
}
