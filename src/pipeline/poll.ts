import { listCampaigns, onAllPosts } from "../campaigns";
import type { Ctx } from "../context";
import { explainError, type Media } from "../meta/client";
import { saveSettings } from "../settings";
import { MINUTE, PRIVATE_REPLY_WINDOW } from "../time";
import { QUERIES_PER_COMMENT, receiveComments } from "./comments";

/** Posts an all-posts campaign polls: the most recent ones. */
const RECENT_POSTS = 10;
/** Posts polled per Cron run, taken in turn, so polling stays inside the request budget. */
const POSTS_PER_RUN = 6;
const MEDIA_CACHE_TTL = 10 * MINUTE;

/** Recent posts, cached for ten minutes. */
export async function recentMedia(ctx: Ctx, force = false): Promise<Media[]> {
  const cachedAt = Number(ctx.settings.media_cache_at ?? 0);
  if (!force && ctx.settings.media_cache && ctx.now() - cachedAt < MEDIA_CACHE_TTL) {
    return JSON.parse(ctx.settings.media_cache) as Media[];
  }
  if (!ctx.meta || !ctx.budget.take()) return ctx.settings.media_cache ? (JSON.parse(ctx.settings.media_cache) as Media[]) : [];
  const media = await ctx.meta.listMedia(25);
  const cache = JSON.stringify(media);
  ctx.settings.media_cache = cache;
  ctx.settings.media_cache_at = String(ctx.now());
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { media_cache: cache, media_cache_at: String(ctx.now()) });
  return media;
}

/**
 * The backstop for missed webhooks: reads the newest comments on the posts that
 * campaigns watch and feeds unseen ones into the comment pipeline.
 */
export async function pollComments(ctx: Ctx): Promise<void> {
  if (!ctx.meta) return;
  const campaigns = await listCampaigns(ctx.db, true);
  if (!campaigns.length) return;

  const watched = new Set<string>();
  for (const c of campaigns) if (c.mediaId) watched.add(c.mediaId);
  try {
    if (campaigns.some(onAllPosts)) {
      for (const m of (await recentMedia(ctx)).slice(0, RECENT_POSTS)) watched.add(m.id);
    }
  } catch (err) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { last_poll_problem: `${ctx.now()}|${explainError(err).detail}` });
  }

  const all = [...watched];
  if (!all.length) return;
  const cursor = Number(ctx.settings.poll_cursor ?? 0) % all.length;
  const turn = [...all.slice(cursor), ...all.slice(0, cursor)].slice(0, POSTS_PER_RUN);

  let problem = "";
  let polled = 0;
  for (const mediaId of turn) {
    if (ctx.budget.queriesLeft < QUERIES_PER_COMMENT + 2 || !ctx.budget.take()) break;
    try {
      const { comments } = await ctx.meta.listComments(mediaId);
      polled++;
      const recent = comments
        .filter((c) => ctx.now() - c.timestamp <= PRIVATE_REPLY_WINDOW)
        .map((c) => ({ ...c, mediaId: c.mediaId || mediaId }));
      await receiveComments(ctx, recent, "poll", campaigns);
    } catch (err) {
      polled++;
      problem = explainError(err).detail;
    }
  }
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
    poll_cursor: String((cursor + polled) % all.length),
    last_poll_at: String(ctx.now()),
    last_poll_problem: problem ? `${ctx.now()}|${problem}` : "",
  });
}
