import { logStatement, type Ctx } from "./context";
import { TRANSIENT_REASON } from "./meta/client";
import { GAVE_UP_REASON, handleComment } from "./pipeline/comments";
import { sendPendingNow } from "./pipeline/messages";
import { MESSAGING_WINDOW, PRIVATE_REPLY_WINDOW } from "./time";

/**
 * People still waiting on a send Meta refused for a passing reason (a rate limit, an
 * outage): a first DM after their comment, or the message after their tap or reply.
 * The Cron retries both; these are listed under To check meanwhile, and once the Cron
 * stops, with a Send button, while Meta's window for them lasts.
 */
export interface RefusedSend {
  /** "comment": the first DM (private reply) never went out. "message": the step after a tap or a reply. */
  type: "comment" | "message";
  /** The comment id, or the conversation id. */
  id: string;
  username: string | null;
  /** What did not go out, in the page's words. */
  what: string;
  /** The next automatic try; null once the Cron stopped. */
  nextAt: number | null;
  attempts: number;
  /** Milliseconds left in Meta's window: 7 days from the comment, or 24 hours from the tap; 0 or less once it closed. */
  left: number;
  /** Whether Send is offered: a refusal OwnChats keeps retrying, inside Meta's window. Otherwise only "Answered by hand". */
  canSend: boolean;
}

/**
 * Comment reasons that mean a refusal. Only refusals since automatic retries began
 * (first_refused_at is set) can be sent again: the owner answers the earlier ones by
 * hand (decision of 2026-11-21), so those are listed with "Answered by hand" only.
 */
const REFUSED_REASONS = [TRANSIENT_REASON, GAVE_UP_REASON];

/** What a pending message is, by the reason it will be logged with. */
function whatMessage(kind: string, reason: string): string {
  if (kind === "link") return `the link (${reason})`;
  return `the next message (${reason})`;
}

/** How long someone who got nothing after a refusal is listed, so the owner can answer by hand: as long as Meta keeps the comment answerable. */
const LISTED_FOR = PRIVATE_REPLY_WINDOW;

/** The refused sends of these campaigns, per campaign, the one running out first on top. */
export async function refusedSends(ctx: Ctx, campaignIds: number[]): Promise<Map<number, RefusedSend[]>> {
  const out = new Map<number, RefusedSend[]>();
  if (!campaignIds.length) return out;
  const now = ctx.now();
  const ids = JSON.stringify(campaignIds);
  const [comments, messages] = await ctx.db.batch<Record<string, unknown>>([
    // A comment whose person got this campaign's DM another way (a second comment) is left out.
    ctx.db
      .prepare(
        `SELECT c.id, c.campaign_id, c.from_username, c.commented_at, c.status, c.next_attempt_at, c.attempts, c.first_refused_at FROM comments c
         WHERE c.campaign_id IN (SELECT value FROM json_each(?1)) AND c.status IN ('queued', 'failed')
           AND c.reason IN (SELECT value FROM json_each(?2)) AND c.commented_at > ?3 AND c.from_id IS NOT NULL AND c.answered_by_hand_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.campaign_id = c.campaign_id AND (v.ig_user_id = c.from_id OR v.commenter_id = c.from_id))
         ORDER BY c.commented_at LIMIT 200`,
      )
      .bind(ids, JSON.stringify(REFUSED_REASONS), now - PRIVATE_REPLY_WINDOW),
    // A message waiting after a refusal, or, from before messages were kept, a refusal after
    // the person's last tap or message with nothing sent to them since.
    ctx.db
      .prepare(
        `SELECT v.id, v.campaign_id, v.username, v.pending_message, v.pending_kind, v.pending_reason, v.pending_at, v.pending_attempts, v.last_inbound_at
         FROM conversations v
         WHERE v.campaign_id IN (SELECT value FROM json_each(?1)) AND v.answered_by_hand_at IS NULL AND v.last_inbound_at > ?2
           AND (v.pending_message IS NOT NULL OR (v.state IN ('opened', 'awaiting_follow', 'follow_reasked', 'awaiting_email', 'reasked')
             AND EXISTS (SELECT 1 FROM activity a WHERE a.campaign_id = v.campaign_id AND a.ig_user_id = v.ig_user_id AND a.kind = 'message'
               AND a.outcome = 'failed' AND a.reason LIKE 'Meta rate limit or outage%' AND a.at >= v.last_inbound_at)
             AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.campaign_id = v.campaign_id AND a.ig_user_id = v.ig_user_id
               AND a.kind IN ('message', 'link') AND a.outcome = 'sent' AND a.at >= v.last_inbound_at)))
         ORDER BY v.last_inbound_at LIMIT 200`,
      )
      .bind(ids, now - LISTED_FOR),
  ]);
  const add = (campaignId: number, r: RefusedSend) => out.set(campaignId, [...(out.get(campaignId) ?? []), r]);
  for (const c of comments!.results) {
    add(Number(c.campaign_id), {
      type: "comment",
      id: String(c.id),
      username: (c.from_username as string | null) ?? null,
      what: "the first DM",
      nextAt: c.status === "queued" ? ((c.next_attempt_at as number | null) ?? now) : null,
      attempts: Number(c.attempts),
      left: Number(c.commented_at) + PRIVATE_REPLY_WINDOW - now,
      canSend: c.first_refused_at !== null,
    });
  }
  for (const m of messages!.results) {
    add(Number(m.campaign_id), {
      type: "message",
      id: String(m.id),
      username: (m.username as string | null) ?? null,
      what: m.pending_message !== null ? whatMessage(String(m.pending_kind), String(m.pending_reason)) : "the message after their tap",
      nextAt: (m.pending_at as number | null) ?? null,
      attempts: Number(m.pending_attempts),
      left: Number(m.last_inbound_at) + MESSAGING_WINDOW - now,
      canSend: m.pending_message !== null && Number(m.last_inbound_at) + MESSAGING_WINDOW > now,
    });
  }
  // Those that can still be sent first, the one running out first on top.
  for (const list of out.values()) list.sort((a, b) => Number(b.canSend) - Number(a.canSend) || a.left - b.left);
  return out;
}

/**
 * The owner's "Send": tries a refused send now. A first DM goes back through the comment
 * pipeline, which keeps every rule (one DM per person per campaign, Meta's 7-day
 * window, one private reply per comment); a message goes through the DM state
 * machine's own send, inside Meta's 24-hour window. Returns whether it went out, or
 * null when there was nothing waiting to send.
 */
export async function sendRefused(ctx: Ctx, campaignId: number, type: string, id: string): Promise<boolean | null> {
  if (!ctx.meta) return null;
  if (type === "message") {
    const conversationId = Number(id);
    return Number.isSafeInteger(conversationId) ? sendPendingNow(ctx, campaignId, conversationId) : null;
  }
  if (type !== "comment") return null;
  // Only a comment still refused is handed over, so two clicks can't send it twice.
  const handed = await ctx.db
    .prepare(
      `UPDATE comments SET status = 'new', next_attempt_at = NULL, locked_at = NULL
       WHERE id = ? AND campaign_id = ? AND status IN ('queued', 'failed') AND reason IN (SELECT value FROM json_each(?))
         AND first_refused_at IS NOT NULL AND answered_by_hand_at IS NULL`,
    )
    .bind(id, campaignId, JSON.stringify(REFUSED_REASONS))
    .run();
  if (handed.meta.changes !== 1) return null;
  await handleComment(ctx, id);
  const after = await ctx.db.prepare("SELECT status FROM comments WHERE id = ?").bind(id).first<{ status: string }>();
  return after?.status === "done";
}

/**
 * The owner's "Answered by hand": they wrote to the person themselves, in Instagram. Sends
 * nothing. The person leaves To check, OwnChats stops retrying, the activity log says so,
 * and the campaign counts them as answered by hand. A first DM that never went out gets a
 * conversation, so a later comment from them gets no second DM. Returns false when there
 * was nothing to mark (already marked, sent meanwhile, or not this campaign's).
 */
export async function markAnsweredByHand(ctx: Ctx, campaignId: number, type: string, id: string): Promise<boolean> {
  const now = ctx.now();
  if (type === "comment") {
    const row = await ctx.db
      .prepare(
        `UPDATE comments SET status = 'done', reason = 'answered by hand', answered_by_hand_at = ?1, next_attempt_at = NULL, locked_at = NULL
         WHERE id = ?2 AND campaign_id = ?3 AND status IN ('queued', 'failed') AND reason IN (SELECT value FROM json_each(?4))
           AND from_id IS NOT NULL AND answered_by_hand_at IS NULL
         RETURNING id, from_id, from_username`,
      )
      .bind(now, id, campaignId, JSON.stringify(REFUSED_REASONS))
      .first<{ id: string; from_id: string; from_username: string | null }>();
    if (!row) return false;
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO conversations (campaign_id, ig_user_id, commenter_id, username, trigger, comment_id, state, created_at, updated_at, answered_by_hand_at)
           VALUES (?1, ?2, ?2, ?3, 'comment', ?4, 'done', ?5, ?5, ?5) ON CONFLICT DO NOTHING`,
        )
        .bind(campaignId, row.from_id, row.from_username, row.id, now),
      logStatement(ctx, { kind: "by_hand", outcome: "saved", reason: "first DM answered by hand", campaignId, commentId: row.id, igUserId: row.from_id, username: row.from_username }),
    ]);
    return true;
  }
  if (type !== "message") return false;
  const conversationId = Number(id);
  if (!Number.isSafeInteger(conversationId)) return false;
  const row = await ctx.db
    .prepare(
      `UPDATE conversations SET state = 'done', answered_by_hand_at = ?1, updated_at = ?1, pending_message = NULL, pending_state = NULL,
         pending_reason = NULL, pending_kind = NULL, pending_attempts = 0, pending_at = NULL, pending_since = NULL
       WHERE id = ?2 AND campaign_id = ?3 AND answered_by_hand_at IS NULL
         AND (pending_message IS NOT NULL OR state IN ('opened', 'awaiting_follow', 'follow_reasked', 'awaiting_email', 'reasked'))
       RETURNING ig_user_id, username`,
    )
    .bind(now, conversationId, campaignId)
    .first<{ ig_user_id: string; username: string | null }>();
  if (!row) return false;
  await logStatement(ctx, { kind: "by_hand", outcome: "saved", reason: "message after the tap answered by hand", campaignId, igUserId: row.ig_user_id, username: row.username }).run();
  return true;
}
