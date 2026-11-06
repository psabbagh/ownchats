import { listCampaigns } from "./campaigns";
import type { Ctx } from "./context";
import { explainError, MetaError, type MediaInsights } from "./meta/client";
import { MINUTE } from "./time";

/** How often each active campaign's post is read again. The Cron reads one post per run at most. */
export const STATS_EVERY = 15 * MINUTE;

/** Stored as the problem when Meta refuses for lack of instagram_manage_insights: the pages explain the fix. */
export const MISSING_PERMISSION = "missing permission";

export interface MediaStats extends MediaInsights {
  mediaId: string;
  /** Last attempt, Unix ms. */
  fetchedAt: number;
  /** Last successful read, Unix ms; null until one worked. */
  updatedAt: number | null;
  problem: string | null;
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
}

const orUndefined = (n: number | null) => n ?? undefined;

export async function readMediaStats(ctx: Ctx, mediaIds: string[]): Promise<Map<string, MediaStats>> {
  if (!mediaIds.length) return new Map();
  const { results } = await ctx.db
    .prepare("SELECT * FROM media_stats WHERE media_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(mediaIds))
    .all<Row>();
  return new Map(
    results.map((r) => [
      r.media_id,
      {
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
      },
    ]),
  );
}

function problemText(err: unknown): string {
  // Code 10 is Meta's "Application does not have permission for this action"; 200 to 299 are permission errors too.
  if (err instanceof MetaError && !err.transient && (err.code === 10 || (err.code !== undefined && err.code >= 200 && err.code < 300))) {
    return MISSING_PERMISSION;
  }
  const { reason, detail } = explainError(err);
  return reason === "Meta refused" || reason === "error" ? detail : reason;
}

/**
 * Called by the Cron: reads Instagram's numbers for the active campaign's post
 * that waited longest, once it is due. Posts of campaigns that are off keep
 * their last numbers.
 */
export async function refreshMediaStats(ctx: Ctx): Promise<void> {
  // Three queries, leaving room for the daily upkeep that runs after this.
  if (!ctx.meta || ctx.budget.queriesLeft < 10) return;
  const ids = [...new Set((await listCampaigns(ctx.db, true)).flatMap((c) => (c.mediaId ? [c.mediaId] : [])))];
  if (!ids.length) return;
  const known = await readMediaStats(ctx, ids);
  const now = ctx.now();
  const due = ids
    .map((id) => ({ id, at: known.get(id)?.fetchedAt ?? 0 }))
    .filter((p) => now - p.at >= STATS_EVERY)
    .sort((a, b) => a.at - b.at)[0];
  if (!due || !ctx.budget.take()) return;
  try {
    const n = await ctx.meta.mediaInsights(due.id);
    await ctx.db
      .prepare(
        `INSERT INTO media_stats (media_id, views, reach, likes, comments, shares, saved, fetched_at, updated_at, problem)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL)
         ON CONFLICT (media_id) DO UPDATE SET views = ?2, reach = ?3, likes = ?4, comments = ?5, shares = ?6, saved = ?7,
           fetched_at = ?8, updated_at = ?8, problem = NULL`,
      )
      .bind(due.id, n.views ?? null, n.reach ?? null, n.likes ?? null, n.comments ?? null, n.shares ?? null, n.saved ?? null, now)
      .run();
  } catch (err) {
    await ctx.db
      .prepare(
        `INSERT INTO media_stats (media_id, fetched_at, problem) VALUES (?1, ?2, ?3)
         ON CONFLICT (media_id) DO UPDATE SET fetched_at = ?2, problem = ?3`,
      )
      .bind(due.id, now, problemText(err))
      .run();
  }
}

/** After a reconnect the permissions may have changed: read every post again, one per Cron run. */
export async function refreshMediaStatsSoon(ctx: Ctx): Promise<void> {
  await ctx.db.prepare("UPDATE media_stats SET fetched_at = 0").run();
}
