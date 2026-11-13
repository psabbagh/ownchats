import type { Ctx } from "./context";
import { oldestKeptDay, POST_DAYS, refreshAccountDays, refreshAccountStats, refreshMediaStats, refreshPostList } from "./insights";
import { handleComment, pendingCommentIds, QUERIES_PER_COMMENT } from "./pipeline/comments";
import { listCampaigns } from "./campaigns";
import { deliverDue, KEEP_DELIVERIES } from "./leadwebhook";
import { attachNextPosts } from "./nextpost";
import { pollComments } from "./pipeline/poll";
import { saveSettings } from "./settings";
import { DAY } from "./time";
import { checkToken } from "./token";

/** Activity older than this is deleted. Leads are kept until you delete them. */
const KEEP_ACTIVITY = 90 * DAY;
/** Comment ids are kept past Meta's 7-day window, so polling never handles one twice. */
const KEEP_COMMENTS = 30 * DAY;

/**
 * Runs every minute: attach campaigns waiting for the next post, retry what waited,
 * poll for missed comments, read Instagram's numbers that are due (posts and the
 * account's days), send what the lead webhook has waiting, and once a day, upkeep.
 */
export async function runCron(ctx: Ctx): Promise<void> {
  // Leads already saved still go to the webhook while Instagram is disconnected.
  if (!ctx.meta) return deliverDue(ctx);
  // First, so the comments it hands back are answered in this same run.
  await attachNextPosts(ctx);
  const pending = await pendingCommentIds(ctx);
  if (pending.length) {
    const campaigns = await listCampaigns(ctx.db, true);
    for (const id of pending) {
      if (ctx.budget.left < 2 || ctx.budget.queriesLeft < QUERIES_PER_COMMENT + 8) break;
      await handleComment(ctx, id, campaigns);
    }
  }
  await pollComments(ctx);
  await refreshPostList(ctx);
  await refreshMediaStats(ctx);
  await refreshAccountStats(ctx);
  await refreshAccountDays(ctx);
  await deliverDue(ctx);
  if (ctx.now() - Number(ctx.settings.daily_at ?? 0) > DAY) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { daily_at: String(ctx.now()) });
    await checkToken(ctx);
    await cleanup(ctx);
  }
}

export async function cleanup(ctx: Ctx): Promise<void> {
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM activity WHERE at < ?").bind(now - KEEP_ACTIVITY),
    ctx.db.prepare("DELETE FROM comments WHERE received_at < ? AND status IN ('done', 'skipped', 'failed')").bind(now - KEEP_COMMENTS),
    ctx.db.prepare("DELETE FROM inbound WHERE received_at < ?").bind(now - KEEP_COMMENTS),
    ctx.db.prepare("DELETE FROM login_attempts WHERE at < ?").bind(now - DAY),
    ctx.db.prepare("DELETE FROM deliveries WHERE status <> 'pending' AND updated_at < ?").bind(now - KEEP_DELIVERIES),
    ctx.db
      .prepare("DELETE FROM media_stats WHERE media_id NOT IN (SELECT media_id FROM campaigns WHERE media_id IS NOT NULL) AND (posted_at IS NULL OR posted_at < ?)")
      .bind(now - POST_DAYS * DAY),
    ctx.db.prepare("DELETE FROM account_days WHERE day < ?").bind(oldestKeptDay(now)),
  ]);
}
