import { listCampaigns, onAllPosts, type Campaign } from "../campaigns";
import type { Ctx } from "../context";
import { explainError, type Media } from "../meta/client";
import { alertStates } from "../alerts";
import { postTimes, type PostTimes } from "../insights";
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
 * How often a watched post's comments are read, by the post's age. Meta's webhooks
 * bring comments as they are written (over 99% of them since 2026-11-06), so polling is
 * only the backup for one Meta never delivers. A post gets most of its comments in its
 * first days, so a new post is read every 15 minutes and an older one less and less,
 * which keeps watched Reels from costing most of the app's Meta calls. A post of unknown
 * age counts as new. While the webhooks look unhealthy (webhookTrouble), a new post is
 * read every run instead, until they recover.
 */
export function pollEvery(postedAt: number | null, now: number, webhooksDown = false): number {
  const age = postedAt === null ? 0 : now - postedAt;
  if (age < YOUNG) return webhooksDown ? 0 : BACKUP_EVERY;
  if (age < 8 * DAY) return 30 * MINUTE;
  if (age < 30 * DAY) return HOUR;
  return 3 * HOUR;
}

/** A post younger than this counts as new: polled most often, and kept polled while Meta's limit is near. */
export const YOUNG = 2 * DAY;
/** How often a new post is polled while the webhooks work. */
export const BACKUP_EVERY = 15 * MINUTE;
/** At most this much is added to a post's wait, the same each time for a given post, so posts don't all fall on the same minute. */
export const JITTER = 4 * MINUTE;

/** A post's own share of JITTER, from its id: steady from run to run, different from post to post. */
export function jitterFor(mediaId: string): number {
  let h = 0;
  for (let i = 0; i < mediaId.length; i++) h = (h * 31 + mediaId.charCodeAt(i)) >>> 0;
  return (h % (JITTER / MINUTE + 1)) * MINUTE;
}

/** Comments found only by the poll over FALLBACK_WINDOW that send new posts back to every run... */
export const FALLBACK_FOUND = 2;
/** ...and the window, which is also how long polling stays fast after the last such comment. */
export const FALLBACK_WINDOW = HOUR;

/**
 * Why Meta's webhooks look unhealthy for comments, or null while they look fine. Read from
 * what OwnChats already records, so it costs one D1 query and no Meta call:
 *  - OwnChats is refusing Meta's webhooks (the app secret doesn't match);
 *  - the account's webhook subscription lacks the comments field (read daily);
 *  - the poll found FALLBACK_FOUND comments or more over the last hour that no webhook brought
 *    (one alone can be a webhook a few seconds behind the poll);
 *  - an owner alert says comments or taps stopped arriving and hasn't closed yet.
 * Each clears by itself once the webhooks work again: the last poll-only comment ages
 * out of the window, and an alert closes 30 minutes after its problem goes.
 */
export async function webhookTrouble(ctx: Ctx): Promise<string | null> {
  const s = ctx.settings;
  const [refusedAt, refusedWhy] = (s.last_webhook_problem ?? "").split("|");
  if (refusedWhy && Number(refusedAt) > Number(s.last_webhook_at ?? 0)) return "webhooks refused";
  if (s.subscribed_fields !== undefined && !s.subscribed_fields.split(",").includes("comments")) return "comments field unsubscribed";
  const alerts = alertStates(ctx);
  if (alerts.comments?.open || alerts.taps?.open) return "alert open";
  const now = ctx.now();
  const row = await ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM comments
       WHERE source = 'poll' AND received_at > ?1 AND commented_at > ?1 AND parent_id IS NULL AND (from_id IS NULL OR from_id <> ?2)`,
    )
    .bind(now - FALLBACK_WINDOW, s.ig_user_id ?? "")
    .first<{ n: number }>();
  return Number(row?.n ?? 0) >= FALLBACK_FOUND ? "comments found only by the poll" : null;
}

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
 * The backup for missed webhooks: reads the newest comments on the posts that
 * campaigns watch, those that are due by their age (pollEvery), most overdue first,
 * and feeds unseen ones into the comment pipeline. While Meta's rate limit is near
 * only new posts are read, and none during a pause (throttle.ts).
 */
export async function pollComments(ctx: Ctx, active?: Campaign[], times?: PostTimes[]): Promise<void> {
  if (!ctx.meta) return;
  const campaigns = active ?? (await listCampaigns(ctx.db, true));
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
  for (const r of times ?? (await postTimes(ctx))) if (r.posted_at && watched.has(r.media_id)) watched.set(r.media_id, r.posted_at);

  const now = ctx.now();
  const before = lastPolled(ctx);
  const young = (postedAt: number | null) => postedAt === null || now - postedAt < YOUNG;
  // Only worth a D1 query when a new post is watched: older ones keep their cadence either way.
  const down = [...watched.values()].some(young) && (await webhookTrouble(ctx)) !== null;
  const due = [...watched]
    .map(([id, postedAt]) => {
      const every = pollEvery(postedAt, now, down);
      return { id, young: young(postedAt), at: before[id] ? before[id] + every + (every ? jitterFor(id) : 0) : 0 };
    })
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
