import type { Ctx } from "./context";
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
  /** Milliseconds left in Meta's window: 7 days from the comment, or 24 hours from the tap. */
  left: number;
}

/**
 * Comment reasons that mean a refusal worth sending again. Only refusals since this
 * change count (first_refused_at is set): the owner answers the earlier ones by hand
 * (decision of 2026-11-21), so they are neither listed nor sent again.
 */
const REFUSED_REASONS = [TRANSIENT_REASON, GAVE_UP_REASON];

/** What a pending message is, by the reason it will be logged with. */
function whatMessage(kind: string, reason: string): string {
  if (kind === "link") return `the link (${reason})`;
  return `the next message (${reason})`;
}

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
        `SELECT c.id, c.campaign_id, c.from_username, c.commented_at, c.status, c.next_attempt_at, c.attempts FROM comments c
         WHERE c.campaign_id IN (SELECT value FROM json_each(?1)) AND c.status IN ('queued', 'failed')
           AND c.reason IN (SELECT value FROM json_each(?2)) AND c.commented_at > ?3 AND c.from_id IS NOT NULL AND c.first_refused_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.campaign_id = c.campaign_id AND (v.ig_user_id = c.from_id OR v.commenter_id = c.from_id))
         ORDER BY c.commented_at LIMIT 200`,
      )
      .bind(ids, JSON.stringify(REFUSED_REASONS), now - PRIVATE_REPLY_WINDOW),
    ctx.db
      .prepare(
        `SELECT id, campaign_id, username, pending_kind, pending_reason, pending_at, pending_attempts, last_inbound_at FROM conversations
         WHERE campaign_id IN (SELECT value FROM json_each(?1)) AND pending_message IS NOT NULL AND last_inbound_at > ?2
         ORDER BY last_inbound_at LIMIT 200`,
      )
      .bind(ids, now - MESSAGING_WINDOW),
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
    });
  }
  for (const m of messages!.results) {
    add(Number(m.campaign_id), {
      type: "message",
      id: String(m.id),
      username: (m.username as string | null) ?? null,
      what: whatMessage(String(m.pending_kind), String(m.pending_reason)),
      nextAt: (m.pending_at as number | null) ?? null,
      attempts: Number(m.pending_attempts),
      left: Number(m.last_inbound_at) + MESSAGING_WINDOW - now,
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.left - b.left);
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
       WHERE id = ? AND campaign_id = ? AND status IN ('queued', 'failed') AND reason IN (SELECT value FROM json_each(?)) AND first_refused_at IS NOT NULL`,
    )
    .bind(id, campaignId, JSON.stringify(REFUSED_REASONS))
    .run();
  if (handed.meta.changes !== 1) return null;
  await handleComment(ctx, id);
  const after = await ctx.db.prepare("SELECT status FROM comments WHERE id = ?").bind(id).first<{ status: string }>();
  return after?.status === "done";
}
