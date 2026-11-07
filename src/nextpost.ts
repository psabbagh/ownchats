import { listCampaigns, matchComment, postLabel, type Campaign } from "./campaigns";
import type { Ctx } from "./context";
import { listedStatement } from "./insights";
import { captionAsksFor } from "./match";
import { explainError, type Media } from "./meta/client";
import { recentMedia } from "./pipeline/poll";
import { saveSettings } from "./settings";
import { PRIVATE_REPLY_WINDOW } from "./time";

/**
 * The post a waiting campaign belongs to: the first one published after it started
 * waiting whose caption asks for its keyword ("Comment AGENTS"). The caption is what
 * tells two waiting campaigns apart, and what keeps a keyword used on an old Reel
 * from mattering: only posts published since the campaign was armed count. An
 * any-comment campaign has no keyword to look for, so it takes the first new post.
 */
export function postFor(campaign: Campaign, oldestFirst: Media[]): Media | undefined {
  return oldestFirst.find(
    (m) => m.timestamp > campaign.nextPostAfter! && (campaign.anyComment || captionAsksFor(m.caption ?? "", campaign.keywords)),
  );
}

/**
 * Called by the Cron every minute, before waiting comments are handled: attaches
 * each campaign that waits for the next post to its post (postFor). Comments on
 * that post that came in before, and that the campaign would have answered, go
 * back through the pipeline in the same run, so the minute between posting and
 * attaching misses nobody. Costs one Meta call a run, and only while a campaign waits.
 */
export async function attachNextPosts(ctx: Ctx): Promise<void> {
  if (!ctx.meta) return;
  const waiting = (await listCampaigns(ctx.db)).filter((c) => c.nextPostAfter !== null);
  if (!waiting.length) return;
  let media: Media[];
  try {
    media = await recentMedia(ctx, true);
  } catch (err) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { next_post_problem: `${ctx.now()}|${explainError(err).detail}` });
    return;
  }
  if (ctx.settings.next_post_problem) await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { next_post_problem: "" });

  const oldestFirst = [...media].filter((m) => m.timestamp).sort((a, b) => a.timestamp - b.timestamp);
  for (const campaign of waiting) {
    const post = postFor(campaign, oldestFirst);
    if (post) await attach(ctx, campaign, post);
  }
}

async function attach(ctx: Ctx, campaign: Campaign, post: Media): Promise<void> {
  const now = ctx.now();
  // Only if it still waits since the same time: an edit in between wins.
  const done = await ctx.db
    .prepare("UPDATE campaigns SET media_id = ?, media_label = ?, next_post_after = NULL, updated_at = ? WHERE id = ? AND next_post_after = ?")
    .bind(post.id, postLabel(post), now, campaign.id, campaign.nextPostAfter)
    .run();
  if (done.meta.changes !== 1) return;
  const attached: Campaign = { ...campaign, mediaId: post.id, mediaLabel: postLabel(post), nextPostAfter: null };

  // Comments that reached the post first were skipped as matching no campaign. Those
  // this campaign answers go back as new; the pipeline then checks every rule again.
  const { results } = await ctx.db
    .prepare(
      `SELECT id, text FROM comments
       WHERE media_id = ? AND status = 'skipped' AND reason = 'no matching campaign' AND from_id IS NOT NULL AND commented_at > ?`,
    )
    .bind(post.id, now - PRIVATE_REPLY_WINDOW)
    .all<{ id: string; text: string }>();
  const early = results.filter((r) => matchComment([attached], post.id, r.text)).map((r) => r.id);
  await ctx.db.batch([
    listedStatement(ctx, post, now),
    ctx.db
      .prepare(
        `UPDATE comments SET status = 'new', reason = NULL, campaign_id = NULL, attempts = 0, locked_at = NULL
         WHERE id IN (SELECT value FROM json_each(?)) AND status = 'skipped' AND reason = 'no matching campaign'`,
      )
      .bind(JSON.stringify(early)),
  ]);
}
