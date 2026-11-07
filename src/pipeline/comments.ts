import { fill, firstMessage, listCampaigns, matchComment, pickPublicReply, plainFirstMessage, type Campaign, type ConversationState } from "../campaigns";
import { trackLinks } from "../clicks";
import { logStatement, type ActivityEntry, type Ctx } from "../context";
import { explainError, isTemplateRejection, MetaError, type IgComment } from "../meta/client";
import { HOUR, MINUTE, PRIVATE_REPLIES_PER_HOUR, PRIVATE_REPLY_WINDOW } from "../time";
import { claimConversation, getConversation, releaseClaim } from "./conversations";

interface CommentRow {
  id: string;
  media_id: string;
  parent_id: string | null;
  from_id: string | null;
  from_username: string | null;
  text: string;
  commented_at: number;
  received_at: number;
  source: string;
  status: string;
  reason: string | null;
  campaign_id: number | null;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

const FIRST_DM_REASON: Record<ConversationState, string> = {
  opened: "opening button",
  awaiting_follow: "follow ask",
  follow_reasked: "follow ask",
  awaiting_email: "email question",
  reasked: "email question",
  optional_email: "link with the optional email line",
  done: "link",
};
const STALE_LOCK = 2 * MINUTE;
/** D1 queries one comment can take, worst case; handling stops when fewer are left. */
export const QUERIES_PER_COMMENT = 8;

function insertStatement(ctx: Ctx, c: IgComment, source: "webhook" | "poll"): D1PreparedStatement {
  return ctx.db
    .prepare(
      `INSERT INTO comments (id, media_id, parent_id, from_id, from_username, text, commented_at, received_at, source, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new') ON CONFLICT (id) DO NOTHING`,
    )
    .bind(c.id, c.mediaId, c.parentId ?? null, c.fromId ?? null, c.fromUsername ?? null, c.text, c.timestamp, ctx.now(), source);
}

/**
 * Records comments in one batch and returns the ones not seen before. The comment
 * id is the dedupe: a comment that arrives by webhook and again by poll is
 * handled once.
 */
export async function ingestComments(ctx: Ctx, comments: IgComment[], source: "webhook" | "poll"): Promise<IgComment[]> {
  if (!comments.length) return [];
  const results = await ctx.db.batch(comments.map((c) => insertStatement(ctx, c, source)));
  return comments.filter((_, i) => results[i]?.meta.changes === 1);
}

/**
 * Ingests comments and handles the new ones while the invocation's budget lasts.
 * Comments that are skipped on sight (no keyword, own comment, too old) are settled
 * together in one batch, so a busy post costs a few queries, not a few per comment.
 */
export async function receiveComments(ctx: Ctx, comments: IgComment[], source: "webhook" | "poll", campaigns?: Campaign[]) {
  const fresh = await ingestComments(ctx, comments, source);
  if (!fresh.length) return;
  campaigns ??= await listCampaigns(ctx.db, true);
  const settled: D1PreparedStatement[] = [];
  const toHandle: string[] = [];
  for (const c of fresh) {
    const d = decide(ctx, c, campaigns);
    if (!("skip" in d)) {
      toHandle.push(c.id);
      continue;
    }
    settled.push(
      ctx.db
        .prepare("UPDATE comments SET status = 'skipped', reason = ?, campaign_id = ? WHERE id = ? AND status = 'new'")
        .bind(d.skip, d.campaignId, c.id),
    );
    if (!d.silent) settled.push(skipLog(ctx, c, d.skip, d.campaignId));
  }
  if (settled.length) await ctx.db.batch(settled);
  for (const id of toHandle) {
    // Whatever does not fit stays 'new' and the next Cron run picks it up.
    if (ctx.budget.queriesLeft < QUERIES_PER_COMMENT) break;
    await handleComment(ctx, id, campaigns);
  }
}

interface CommentFacts {
  id: string;
  mediaId: string;
  text: string;
  timestamp: number;
  fromId?: string | null;
  fromUsername?: string | null;
  parentId?: string | null;
  /**
   * The campaign a waiting comment already belongs to: the one it matched before
   * it was queued, or the one the owner chose with "Answer" on the dashboard.
   */
  campaignId?: number | null;
}

type Decision = { campaign: Campaign } | { skip: string; campaignId: number | null; silent?: boolean };

/** The rules that need nothing but the comment and the campaigns. */
function decide(ctx: Ctx, c: CommentFacts, campaigns: Campaign[]): Decision {
  if (isOwnComment(ctx, c)) {
    // OwnChats' own public replies come back as comments too; those are not worth a log line.
    if (c.parentId) return { skip: "own reply", campaignId: null, silent: true };
    return { skip: "your own comment (test from a second account)", campaignId: null };
  }
  // A campaign chosen earlier is kept while it is on, whatever the text says now.
  const chosen = c.campaignId ? campaigns.find((x) => x.id === c.campaignId && x.active) : undefined;
  const campaign = chosen ?? matchComment(campaigns, c.mediaId, c.text);
  if (!campaign) return { skip: "no matching campaign", campaignId: null };
  if (!chosen && c.timestamp < campaign.createdAt) return { skip: "written before the campaign started", campaignId: campaign.id };
  if (ctx.now() - c.timestamp > PRIVATE_REPLY_WINDOW) return { skip: "older than 7 days, Meta no longer allows a DM", campaignId: campaign.id };
  if (!c.fromId) return { skip: "Meta did not say who wrote it", campaignId: campaign.id };
  if (!ctx.meta) return { skip: "Instagram is not connected", campaignId: campaign.id };
  return { campaign };
}

function skipLog(ctx: Ctx, c: CommentFacts, reason: string, campaignId: number | null): D1PreparedStatement {
  return logStatement(ctx, {
    kind: "comment",
    outcome: "skipped",
    reason,
    campaignId,
    commentId: c.id,
    igUserId: c.fromId ?? null,
    username: c.fromUsername ?? null,
    detail: c.text.slice(0, 200),
  });
}

/** Comments waiting for a retry: queued, never handled, or stuck mid-way. */
export async function pendingCommentIds(ctx: Ctx, limit = 20): Promise<string[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT id FROM comments WHERE status IN ('new', 'queued') OR (status = 'processing' AND locked_at < ?)
       ORDER BY received_at LIMIT ?`,
    )
    .bind(ctx.now() - STALE_LOCK, limit)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function sentLastHour(ctx: Ctx): Promise<number> {
  if (ctx.sentLastHour === undefined) {
    const row = await ctx.db
      .prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'private_reply' AND outcome = 'sent' AND at > ?")
      .bind(ctx.now() - HOUR)
      .first<{ n: number }>();
    ctx.sentLastHour = row?.n ?? 0;
  }
  return ctx.sentLastHour;
}

function isOwnComment(ctx: Ctx, c: CommentFacts): boolean {
  const { ig_user_id, ig_username } = ctx.settings;
  if (ig_user_id && c.fromId === ig_user_id) return true;
  return !!ig_username && !!c.fromUsername && c.fromUsername.toLowerCase() === ig_username.toLowerCase();
}

/**
 * The comment pipeline: claim the row, decide, send the one private reply, then
 * the public reply, and record every decision with its reason.
 */
export async function handleComment(ctx: Ctx, id: string, campaigns?: Campaign[]): Promise<void> {
  const now = ctx.now();
  const row = await ctx.db
    .prepare(
      `UPDATE comments SET status = 'processing', locked_at = ?
       WHERE id = ? AND (status IN ('new', 'queued') OR (status = 'processing' AND locked_at < ?)) RETURNING *`,
    )
    .bind(now, id, now - STALE_LOCK)
    .first<CommentRow>();
  if (!row) return; // someone else has it, or it is finished

  const facts: CommentFacts = {
    id: row.id,
    mediaId: row.media_id,
    text: row.text,
    timestamp: row.commented_at,
    fromId: row.from_id,
    fromUsername: row.from_username,
    parentId: row.parent_id,
    campaignId: row.campaign_id,
  };
  const who = { commentId: row.id, igUserId: row.from_id, username: row.from_username };
  const settle = (status: string, reason: string | null, campaignId: number | null, extra: D1PreparedStatement[] = [], attempts = row.attempts) =>
    ctx.db.batch([
      ctx.db
        .prepare("UPDATE comments SET status = ?, reason = ?, campaign_id = ?, attempts = ?, locked_at = NULL WHERE id = ?")
        .bind(status, reason, campaignId, attempts, row.id),
      ...extra,
    ]);
  const skip = (reason: string, campaignId: number | null = null, silent = false) =>
    settle("skipped", reason, campaignId, silent ? [] : [skipLog(ctx, facts, reason, campaignId)]);

  campaigns ??= await listCampaigns(ctx.db, true);
  const d = decide(ctx, facts, campaigns);
  if ("skip" in d) return void (await skip(d.skip, d.campaignId, d.silent));
  const campaign = d.campaign;
  const cid = campaign.id;
  if (!ctx.meta || !row.from_id) return; // decide() ruled these out

  if ((await sentLastHour(ctx)) >= PRIVATE_REPLIES_PER_HOUR) {
    const reason = "hourly DM limit reached, waiting";
    // Logged once, not on every retry.
    const entry = row.reason === reason ? [] : [logStatement(ctx, { kind: "comment", outcome: "queued", reason, campaignId: cid, ...who })];
    return void (await settle("queued", reason, cid, entry));
  }
  if (!ctx.budget.take(campaign.publicReplies.length ? 2 : 1)) return void (await settle("queued", "waiting for the next run", cid));

  const person = { username: row.from_username };
  const first = firstMessage(campaign, "comment", person);
  let conversationId = await claimConversation(ctx.db, {
    campaignId: cid,
    igUserId: row.from_id,
    commenterId: row.from_id,
    username: row.from_username,
    trigger: "comment",
    commentId: row.id,
    state: first.state,
    lastInboundAt: null,
    now,
  });
  if (conversationId === null) {
    // A claim left by this same comment whose DM never went out (a crash mid-way) is retried.
    const existing = await getConversation(ctx.db, cid, row.from_id);
    if (!existing || existing.comment_id !== row.id || existing.first_sent_at !== null) {
      return void (await skip("this person already got this campaign's DM", cid));
    }
    conversationId = existing.id;
  }

  let sent = first;
  let recipientId: string | undefined;
  try {
    try {
      // When the first DM carries the link, it goes out as a /go/ link, so a click can be counted.
      recipientId = (await ctx.meta.sendPrivateReply(row.id, await trackLinks(ctx, conversationId, campaign, first.message))).recipientId;
    } catch (err) {
      // Meta documents only text private replies. If it refuses the button, send the next step as text.
      if (first.message.kind !== "buttons" || !isTemplateRejection(err)) throw err;
      sent = plainFirstMessage(campaign, person);
      recipientId = (await ctx.meta.sendPrivateReply(row.id, await trackLinks(ctx, conversationId, campaign, sent.message))).recipientId;
    }
  } catch (err) {
    await releaseClaim(ctx.db, conversationId);
    const { reason, detail } = explainError(err);
    const attempts = row.attempts + 1;
    const retry = err instanceof MetaError && err.transient && attempts < MAX_ATTEMPTS;
    return void (await settle(retry ? "queued" : "failed", reason, cid, [
      logStatement(ctx, { kind: "private_reply", outcome: "failed", reason, campaignId: cid, ...who, detail }),
    ], attempts));
  }
  ctx.sentLastHour = (ctx.sentLastHour ?? 0) + 1;

  // Public reply variants are picked at random, never the same one twice in a row.
  const reply = pickPublicReply(campaign, ctx.random);
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE conversations SET first_sent_at = ?, updated_at = ?, state = ? WHERE id = ?")
      .bind(ctx.now(), ctx.now(), sent.state, conversationId),
    // Taps and DMs come from the messaging id Meta returned, which may differ from the id on the comment.
    ctx.db
      .prepare("UPDATE OR IGNORE conversations SET ig_user_id = COALESCE(?, ig_user_id) WHERE id = ?")
      .bind(recipientId ?? null, conversationId),
    logStatement(ctx, {
      kind: "private_reply",
      outcome: "sent",
      reason: FIRST_DM_REASON[sent.state] + (sent === first ? "" : " (as text: Meta refused the button)"),
      campaignId: cid,
      ...who,
    }),
    ...(reply ? [ctx.db.prepare("UPDATE campaigns SET reply_cursor = ? WHERE id = ?").bind(reply.index, cid)] : []),
  ]);
  if (reply) campaign.replyCursor = reply.index;

  // The public reply goes out only once the DM did, so "Sent!" is true.
  const extra: D1PreparedStatement[] = [];
  if (reply) {
    const variant = fill(reply.text, person);
    let entry: ActivityEntry;
    try {
      await ctx.meta.replyToComment(row.id, variant);
      entry = { kind: "public_reply", outcome: "sent", campaignId: cid, ...who, detail: variant };
    } catch (err) {
      const { reason, detail } = explainError(err);
      entry = { kind: "public_reply", outcome: "failed", reason, campaignId: cid, ...who, detail };
    }
    extra.push(logStatement(ctx, entry));
  }
  await settle("done", null, cid, extra);
}
