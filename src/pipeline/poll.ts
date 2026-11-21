import { listCampaigns, onAllPosts } from "../campaigns";
import type { Ctx } from "../context";
import { explainError, type Media } from "../meta/client";
import { saveSettings } from "../settings";
import { backgroundAllowed, paused } from "../throttle";
import { DAY, HOUR, MINUTE, PRIVATE_REPLY_WINDOW } from "../time";
import { QUERIES_PER_COMMENT, receiveComments } from "./comments";

/** Posts an all-posts campaign polls: the most recent ones. */
const RECENT_POSTS = 10;
/** Posts polled per Cron run at most, most overdue first, so polling stays inside the request budget. */
const POSTS_PER_RUN = 6;
export const MEDIA_CACHE_TTL = 10 * MINUTE;

/**
 * Recent posts, cached for ten minutes. `force` reads past the cache: the campaign
 * form, so a Reel posted a minute ago is listed, and the Cron when a comment shows a
 * post it has never seen (nextpost.ts). Without it, the Cron leaves the cache as it is
 * while Meta's rate limit is near.
 */
export async function recentMedia(ctx: Ctx, force = false): Promise<Media[]> {
  const cachedAt = Number(ctx.settings.media_cache_at ?? 0);
  const cached = () => (ctx.settings.media_cache ? (JSON.parse(ctx.settings.media_cache) as Media[]) : []);
  if (!force && ctx.settings.media_cache && ctx.now() - cachedAt < MEDIA_CACHE_TTL) return cached();
  if (!force && !backgroundAllowed(ctx.load, ctx.now(), "high")) return cached();
  if (!ctx.meta || !ctx.budget.take()) return cached();
  const media = await ctx.meta.listMedia(25);
  const cache = JSON.stringify(media);
  ctx.settings.media_cache = cache;
  ctx.settings.media_cache_at = String(ctx.now());
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { media_cache: cache, media_cache_at: String(ctx.now()) });
  return media;
}

/**
 * How often a watched post's comments are read, by the post's age. Webhooks bring
 * comments as they are written; polling is the backstop for the ones Meta never
 * delivers, and a post gets most of its comments in its first days. So a new post is
 * read every run and an older one less and less, which keeps 18 watched Reels from
 * costing hundreds of Meta calls an hour. A post of unknown age counts as new.
 */
export function pollEvery(postedAt: number | null, now: number): number {
  if (postedAt === null) return 0;
  const age = now - postedAt;
  if (age < YOUNG) return 0;
  if (age < 8 * DAY) return 15 * MINUTE;
  if (age < 30 * DAY) return HOUR;
  return 3 * HOUR;
}

/** A post younger than this is polled every run, and keeps being polled while Meta's limit is near. */
export const YOUNG = 2 * DAY;

/** When each watched post was last polled, from settings. */
function lastPolled(ctx: Ctx): Record<string, number> {
  try {
    const parsed = JSON.parse(ctx.settings.poll_at ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * The backstop for missed webhooks: reads the newest comments on the posts that
 * campaigns watch, those that are due by their age (pollEvery), most overdue first,
 * and feeds unseen ones into the comment pipeline. While Meta's rate limit is near
 * only new posts are read, and none during a pause (throttle.ts).
 */
export async function pollComments(ctx: Ctx): Promise<void> {
  if (!ctx.meta) return;
  const campaigns = await listCampaigns(ctx.db, true);
  if (!campaigns.length) return;

  const watched = new Map<string, number | null>();
  for (const c of campaigns) if (c.mediaId) watched.set(c.mediaId, null);
  try {
    if (campaigns.some(onAllPosts)) {
      for (const m of (await recentMedia(ctx)).slice(0, RECENT_POSTS)) watched.set(m.id, m.timestamp || null);
    }
  } catch (err) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { last_poll_problem: `${ctx.now()}|${explainError(err).detail}` });
  }
  if (!watched.size) return;

  // Ages from the account's post list, read hourly; the recent posts' own timestamps where it has none.
  const { results } = await ctx.db
    .prepare("SELECT media_id, posted_at FROM media_stats WHERE media_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...watched.keys()]))
    .all<{ media_id: string; posted_at: number | null }>();
  for (const r of results) if (r.posted_at) watched.set(r.media_id, r.posted_at);

  const now = ctx.now();
  const before = lastPolled(ctx);
  const due = [...watched]
    .map(([id, postedAt]) => ({ id, young: postedAt === null || now - postedAt < YOUNG, at: (before[id] ?? 0) + pollEvery(postedAt, now) }))
    .filter((p) => p.at <= now && backgroundAllowed(ctx.load, now, p.young ? "high" : "low"))
    .sort((a, b) => a.at - b.at)
    .slice(0, POSTS_PER_RUN);
  if (!due.length) return;

  let problem = "";
  const polledAt: Record<string, number> = {};
  for (const { id: mediaId } of due) {
    // A rate-limit refusal in this run pauses the rest.
    if (paused(ctx.load, ctx.now())) break;
    if (ctx.budget.queriesLeft < QUERIES_PER_COMMENT + 2 || !ctx.budget.take()) break;
    polledAt[mediaId] = now;
    try {
      const { comments } = await ctx.meta.listComments(mediaId);
      const recent = comments
        .filter((c) => ctx.now() - c.timestamp <= PRIVATE_REPLY_WINDOW)
        .map((c) => ({ ...c, mediaId: c.mediaId || mediaId }));
      await receiveComments(ctx, recent, "poll", campaigns);
    } catch (err) {
      problem = explainError(err).detail;
    }
  }
  // Only posts still watched are remembered, so the setting can't grow.
  const kept = Object.fromEntries([...watched.keys()].flatMap((id) => (polledAt[id] ?? before[id] ? [[id, polledAt[id] ?? before[id]]] : [])));
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
    poll_at: JSON.stringify(kept),
    last_poll_at: String(now),
    last_poll_problem: problem ? `${now}|${problem}` : "",
  });
}
