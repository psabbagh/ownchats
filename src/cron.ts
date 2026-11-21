import { checkAlerts, checkSubscription, heartbeat } from "./alerts";
import type { Ctx } from "./context";
import { oldestKeptDay, POST_DAYS, refreshAccountDays, refreshAccountStats, refreshMediaStats, refreshPostList } from "./insights";
import { handleComment, pendingCommentIds, QUERIES_PER_COMMENT } from "./pipeline/comments";
import { listCampaigns } from "./campaigns";
import { deliverDue, KEEP_DELIVERIES } from "./leadwebhook";
import { attachNextPosts } from "./nextpost";
import { retryPendingMessages } from "./pipeline/messages";
import { pollComments } from "./pipeline/poll";
import { saveSettings } from "./settings";
import { DAY } from "./time";
import { saveMetaLoad } from "./throttle";
import { checkToken } from "./token";

/** Messages after a tap that the Cron sends again in one run, at most. */
const MESSAGE_RETRIES_PER_RUN = 10;

/** Activity older than this is deleted. Leads are kept until you delete them. */
const KEEP_ACTIVITY = 90 * DAY;
/** Comment ids are kept past Meta's 7-day window, so polling never handles one twice. */
const KEEP_COMMENTS = 30 * DAY;

/**
 * Runs every minute: attach campaigns waiting for the next post, retry the private
 * replies and the messages after a tap that wait, poll for missed comments, read
 * Instagram's numbers that are due (posts and the account's days), send what the lead
 * webhook has waiting, and once a day, upkeep. It starts with the heartbeat and the
 * owner's alerts (alerts.ts). Sends go first; the reads are held
 * back while Meta's rate limit is near (throttle.ts).
 */
export async function runCron(ctx: Ctx): Promise<void> {
  // First, and even while Instagram is disconnected: the heartbeat says the Cron runs, and alerts say what needs the owner.
  await heartbeat(ctx);
  // Campaigns are read once and shared by the steps below, read again only when a post was
  // attached; the run itself changes nothing else on them (a public reply's variant is
  // kept in memory too). Each read costs a row per campaign, every minute.
  let all = await listCampaigns(ctx.db);
  const active = () => all.filter((c) => c.active);
  try {
    await checkAlerts(ctx, active());
  } catch (err) {
    // An alert must never cost a DM: the rest of the run goes on.
    console.error("alerts", err);
  }
  // Leads already saved still go to the webhook while Instagram is disconnected.
  if (!ctx.meta) return deliverDue(ctx);
  // First, so the comments it hands back are answered in this same run.
  if (await attachNextPosts(ctx, all)) all = await listCampaigns(ctx.db);
  const campaigns = active();
  // Sends before reads. Refused sends wait out a pause Meta imposed (throttle.ts), then go first.
  const pending = await pendingCommentIds(ctx);
  if (pending.length) {
    for (const id of pending) {
      if (ctx.budget.left < 2 || ctx.budget.queriesLeft < QUERIES_PER_COMMENT + 8) break;
      await handleComment(ctx, id, campaigns);
    }
  }
  await retryPendingMessages(ctx, MESSAGE_RETRIES_PER_RUN);
  await pollComments(ctx, campaigns);
  await refreshPostList(ctx);
  await refreshMediaStats(ctx, campaigns);
  await refreshAccountStats(ctx);
  await refreshAccountDays(ctx);
  await deliverDue(ctx);
  await saveMetaLoad(ctx.db, ctx.env.ADMIN_PASSWORD, ctx.load);
  if (ctx.now() - Number(ctx.settings.daily_at ?? 0) > DAY) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { daily_at: String(ctx.now()) });
    await checkToken(ctx);
    await checkSubscription(ctx);
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
