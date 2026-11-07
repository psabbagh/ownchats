import { listCampaigns } from "./campaigns";
import type { Ctx } from "./context";
import { explainError, MetaError, type Media, type MediaInsights } from "./meta/client";
import { MEDIA_PAGES } from "./meta/graph";
import { saveSettings } from "./settings";
import { DAY, HOUR, MINUTE } from "./time";

/** How often the post of an active campaign is read again, whatever its age. */
export const STATS_EVERY = 15 * MINUTE;
/** Posts younger than this are kept and read; older ones only while a campaign watches them. */
export const POST_DAYS = 90;
/** The account's post list and its follower count are read this often. */
export const LIST_EVERY = HOUR;
/** Meta reads of post numbers per Cron run, at most. */
const READS_PER_RUN = 2;
/** Posts listed per run, at most: three pages of 50. */
const LIST_MAX = 150;

/** Stored as the problem when Meta refuses for lack of instagram_manage_insights: the pages explain the fix. */
export const MISSING_PERMISSION = "missing permission";

export interface MediaStats extends MediaInsights {
  mediaId: string;
  /** Last attempt, Unix ms; 0 until the first. */
  fetchedAt: number;
  /** Last successful read, Unix ms; null until one worked. */
  updatedAt: number | null;
  problem: string | null;
  /** From the account's post list; null for a campaign post older than the list reaches. */
  postedAt: number | null;
  caption: string | null;
  permalink: string | null;
  mediaType: string | null;
  thumbnailUrl: string | null;
}

interface Row {
  media_id: string;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saved: number | null;
  fetched_at: number;
  updated_at: number | null;
  problem: string | null;
  posted_at: number | null;
  caption: string | null;
  permalink: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
}

const orUndefined = (n: number | null) => n ?? undefined;

function fromRow(r: Row): MediaStats {
  return {
    mediaId: r.media_id,
    views: orUndefined(r.views),
    reach: orUndefined(r.reach),
    likes: orUndefined(r.likes),
    comments: orUndefined(r.comments),
    shares: orUndefined(r.shares),
    saved: orUndefined(r.saved),
    fetchedAt: r.fetched_at,
    updatedAt: r.updated_at,
    problem: r.problem,
    postedAt: r.posted_at,
    caption: r.caption,
    permalink: r.permalink,
    mediaType: r.media_type,
    thumbnailUrl: r.thumbnail_url,
  };
}

export async function readMediaStats(ctx: Ctx, mediaIds: string[]): Promise<Map<string, MediaStats>> {
  if (!mediaIds.length) return new Map();
  const { results } = await ctx.db
    .prepare("SELECT * FROM media_stats WHERE media_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(mediaIds))
    .all<Row>();
  return new Map(results.map((r) => [r.media_id, fromRow(r)]));
}

/** The account's posts, newest first, for the API. With `since`, only posts from then on. */
export async function listPosts(ctx: Ctx, opts: { since?: number; limit: number }): Promise<MediaStats[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT * FROM media_stats WHERE posted_at IS NOT NULL AND posted_at >= ?1
       ORDER BY posted_at DESC LIMIT ?2`,
    )
    .bind(opts.since ?? 0, opts.limit)
    .all<Row>();
  return results.map(fromRow);
}

/**
 * How long a post's numbers count as fresh. New posts move fast, so they are read
 * often; a post that has settled is read daily. A campaign's post stays frequent.
 */
export function refreshEvery(postedAt: number | null, watched: boolean, now: number): number {
  if (watched) return STATS_EVERY;
  if (postedAt === null) return DAY;
  const age = now - postedAt;
  if (age < 2 * DAY) return 15 * MINUTE;
  if (age < 8 * DAY) return HOUR;
  if (age < 30 * DAY) return 6 * HOUR;
  return DAY;
}

function problemText(err: unknown): string {
  // Code 10 is Meta's "Application does not have permission for this action"; 200 to 299 are permission errors too.
  if (err instanceof MetaError && !err.transient && (err.code === 10 || (err.code !== undefined && err.code >= 200 && err.code < 300))) {
    return MISSING_PERMISSION;
  }
  const { reason, detail } = explainError(err);
  return reason === "Meta refused" || reason === "error" ? detail : reason;
}

/** Stores a post from the account's post list; its numbers are due at once if it is new. */
export function listedStatement(ctx: Ctx, m: Media, now: number): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO media_stats (media_id, fetched_at, posted_at, caption, permalink, media_type, thumbnail_url, listed_at)
       VALUES (?1, 0, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (media_id) DO UPDATE SET posted_at = ?2, caption = ?3, permalink = ?4, media_type = ?5,
         thumbnail_url = ?6, listed_at = ?7`,
    )
    .bind(m.id, m.timestamp || null, m.caption || null, m.permalink || null, m.mediaType || null, m.thumbnailUrl ?? null, now);
}

/** Called by the Cron, hourly: stores the account's posts from the last POST_DAYS days. */
export async function refreshPostList(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  if (!ctx.meta || now - Number(ctx.settings.posts_listed_at ?? 0) < LIST_EVERY) return;
  if (ctx.budget.queriesLeft < 12 || !ctx.budget.take(MEDIA_PAGES)) return;
  let problem = "";
  try {
    const media = await ctx.meta.listMediaSince(now - POST_DAYS * DAY, LIST_MAX);
    if (media.length) await ctx.db.batch(media.map((m) => listedStatement(ctx, m, now)));
  } catch (err) {
    problem = explainError(err).detail;
  }
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { posts_listed_at: String(now), posts_problem: problem });
}

/**
 * Called by the Cron: reads Instagram's numbers for the posts that are most
 * overdue, up to READS_PER_RUN. Posts of active campaigns are due every 15
 * minutes; other posts by their age (refreshEvery). A failed read keeps the
 * last numbers.
 */
export async function refreshMediaStats(ctx: Ctx): Promise<void> {
  // A few queries, leaving room for the daily upkeep that runs after this.
  if (!ctx.meta || ctx.budget.queriesLeft < 10) return;
  const watched = new Set((await listCampaigns(ctx.db, true)).flatMap((c) => (c.mediaId ? [c.mediaId] : [])));
  const { results } = await ctx.db.prepare("SELECT media_id, posted_at, fetched_at FROM media_stats").all<{ media_id: string; posted_at: number | null; fetched_at: number }>();
  const now = ctx.now();
  const known = new Map(results.map((r) => [r.media_id, r]));
  for (const id of watched) if (!known.has(id)) known.set(id, { media_id: id, posted_at: null, fetched_at: 0 });
  const due = [...known.values()]
    .filter((p) => watched.has(p.media_id) || (p.posted_at !== null && now - p.posted_at < POST_DAYS * DAY))
    .map((p) => ({ id: p.media_id, at: p.fetched_at + refreshEvery(p.posted_at, watched.has(p.media_id), now) }))
    .filter((p) => p.at <= now)
    .sort((a, b) => a.at - b.at)
    .slice(0, READS_PER_RUN);
  for (const post of due) {
    if (ctx.budget.queriesLeft < 8 || !ctx.budget.take()) return;
    await readOne(ctx, post.id, now);
  }
}

async function readOne(ctx: Ctx, mediaId: string, now: number): Promise<void> {
  try {
    const n = await ctx.meta!.mediaInsights(mediaId);
    await ctx.db
      .prepare(
        `INSERT INTO media_stats (media_id, views, reach, likes, comments, shares, saved, fetched_at, updated_at, problem)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL)
         ON CONFLICT (media_id) DO UPDATE SET views = ?2, reach = ?3, likes = ?4, comments = ?5, shares = ?6, saved = ?7,
           fetched_at = ?8, updated_at = ?8, problem = NULL`,
      )
      .bind(mediaId, n.views ?? null, n.reach ?? null, n.likes ?? null, n.comments ?? null, n.shares ?? null, n.saved ?? null, now)
      .run();
  } catch (err) {
    await ctx.db
      .prepare(
        `INSERT INTO media_stats (media_id, fetched_at, problem) VALUES (?1, ?2, ?3)
         ON CONFLICT (media_id) DO UPDATE SET fetched_at = ?2, problem = ?3`,
      )
      .bind(mediaId, now, problemText(err))
      .run();
  }
}

/** Called by the Cron, hourly: the account's follower, following and post counts. */
export async function refreshAccountStats(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  if (!ctx.meta || now - Number(ctx.settings.account_stats_at ?? 0) < LIST_EVERY) return;
  if (ctx.budget.queriesLeft < 4 || !ctx.budget.take()) return;
  try {
    const a = await ctx.meta.getAccountStats();
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
      followers_count: a.followers === null ? "" : String(a.followers),
      follows_count: a.follows === null ? "" : String(a.follows),
      media_count: a.mediaCount === null ? "" : String(a.mediaCount),
      account_stats_at: String(now),
      account_problem: "",
    });
  } catch (err) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { account_stats_at: String(now), account_problem: explainError(err).detail });
  }
}

/** After a reconnect the permissions may have changed: every post's numbers are due again, from the next Cron run. */
export async function refreshMediaStatsSoon(ctx: Ctx): Promise<void> {
  await ctx.db.prepare("UPDATE media_stats SET fetched_at = 0").run();
}
