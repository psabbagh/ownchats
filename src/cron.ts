import type { Ctx } from "./context";
import { refreshMediaStats } from "./insights";
import { handleComment, pendingCommentIds, QUERIES_PER_COMMENT } from "./pipeline/comments";
import { listCampaigns } from "./campaigns";
import { pollComments } from "./pipeline/poll";
import { saveSettings } from "./settings";
import { DAY } from "./time";
import { checkToken } from "./token";

/** Activity older than this is deleted. Leads are kept until you delete them. */
const KEEP_ACTIVITY = 90 * DAY;
/** Comment ids are kept past Meta's 7-day window, so polling never handles one twice. */
const KEEP_COMMENTS = 30 * DAY;

/** Runs every minute: retry what waited, poll for missed comments, read one post's numbers, and once a day, upkeep. */
export async function runCron(ctx: Ctx): Promise<void> {
  if (!ctx.meta) return;
  const pending = await pendingCommentIds(ctx);
  if (pending.length) {
    const campaigns = await listCampaigns(ctx.db, true);
    for (const id of pending) {
      if (ctx.budget.left < 2 || ctx.budget.queriesLeft < QUERIES_PER_COMMENT + 8) break;
      await handleComment(ctx, id, campaigns);
    }
  }
  await pollComments(ctx);
  await refreshMediaStats(ctx);
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
    ctx.db.prepare("DELETE FROM media_stats WHERE media_id NOT IN (SELECT media_id FROM campaigns WHERE media_id IS NOT NULL)"),
  ]);
}
