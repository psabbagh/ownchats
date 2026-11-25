import { checkAlertsWhenDue, checkSubscription, heartbeat, heartbeatFailed } from "./alerts";
import type { Ctx } from "./context";
import { oldestKeptDay, POST_DAYS, postTimes, type PostTimes, refreshAccountDays, refreshAccountStats, refreshMediaStats, refreshPostList } from "./insights";
import { handleComment, pendingCommentIds, QUERIES_PER_COMMENT } from "./pipeline/comments";
import { listCampaigns, type Campaign } from "./campaigns";
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
 * webhook has waiting, and once a day, upkeep. It starts with the owner's alerts
 * (alerts.ts), checked every 5 minutes. Sends go first; the reads are held back while
 * Meta's rate limit is near (throttle.ts).
 *
 * The heartbeat goes out once the comments are answered and the poll has run, so it
 * says the work got done, not that the Cron started: on 2026-11-24, with D1 refusing
 * most reads, the Cron pinged every minute while no comment was answered. A run that
 * throws before that pings the heartbeat's /fail instead (throttled), and still throws.
 */
export async function runCron(ctx: Ctx): Promise<void> {
  let rest: (() => Promise<void>) | null;
  try {
    rest = await answerComments(ctx);
  } catch (err) {
    await heartbeatFailed(ctx, err);
    throw err;
  }
  await heartbeat(ctx);
  if (rest) await rest();
}

/**
 * The part of a run the heartbeat vouches for: alerts, campaigns waiting for a post, the
 * comments and messages waiting, and the poll for missed comments. Returns the rest of
 * the run (Instagram's numbers, the lead webhook, upkeep), whose failure doesn't mean
 * comments go unanswered.
 */
async function answerComments(ctx: Ctx): Promise<(() => Promise<void>) | null> {
  // Campaigns are read once and shared by the steps below, read again only when a post was
  // attached; the run itself changes nothing else on them (a public reply's variant is
  // kept in memory too). Each read costs a row per campaign, every minute.
  let all = await listCampaigns(ctx.db);
  const active = () => all.filter((c) => c.active);
  try {
    await checkAlertsWhenDue(ctx, active());
  } catch (err) {
    // An alert must never cost a DM: the rest of the run goes on.
    console.error("alerts", err);
  }
  // Leads already saved still go to the webhook while Instagram is disconnected. The heartbeat
  // still goes out then: the token alert, not a missing heartbeat, tells the owner.
  if (!ctx.meta) return () => deliverDue(ctx);
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
  // Posts' times are read once for the poll and the numbers below, and again only when the
  // hourly post list may have changed them.
  const times = await postTimes(ctx);
  await pollComments(ctx, campaigns, times);
  return () => readAndUpkeep(ctx, campaigns, times);
}

async function readAndUpkeep(ctx: Ctx, campaigns: Campaign[], postTimesNow: PostTimes[]): Promise<void> {
  let times = postTimesNow;
  if (await refreshPostList(ctx)) times = await postTimes(ctx);
  await refreshMediaStats(ctx, campaigns, times);
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
