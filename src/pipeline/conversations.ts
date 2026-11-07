import type { ConversationState } from "../campaigns";

export interface Conversation {
  id: number;
  campaign_id: number;
  ig_user_id: string;
  commenter_id: string | null;
  username: string | null;
  /** Instagram name for {name}; null until asked, "" when Meta had none. */
  name: string | null;
  trigger: "comment" | "dm";
  comment_id: string | null;
  state: ConversationState;
  first_sent_at: number | null;
  last_inbound_at: number | null;
  /** Times asked to follow: 0, 1 or 2. */
  follow_asked: number;
  /** 1 or 0 at the last follow check; null while never checked, or when Meta didn't say. */
  follows: number | null;
  created_at: number;
  updated_at: number;
}

/** The person's conversation for a campaign, by messaging id or by the id on their comment. */
export function getConversation(db: D1Database, campaignId: number, personId: string): Promise<Conversation | null> {
  return db
    .prepare("SELECT * FROM conversations WHERE campaign_id = ?1 AND (ig_user_id = ?2 OR commenter_id = ?2) LIMIT 1")
    .bind(campaignId, personId)
    .first<Conversation>();
}

/**
 * The person's most recent conversation that still expects something from them.
 * One untouched for a week is treated as abandoned, so a later unrelated DM does
 * not restart it.
 */
export function openConversation(db: D1Database, igUserId: string, since: number): Promise<Conversation | null> {
  return db
    .prepare(
      `SELECT * FROM conversations WHERE ig_user_id = ? AND state != 'done' AND first_sent_at IS NOT NULL AND updated_at >= ?
       ORDER BY updated_at DESC, id DESC LIMIT 1`,
    )
    .bind(igUserId, since)
    .first<Conversation>();
}

/**
 * Claims the person for a campaign before the first DM goes out. Returns the new
 * conversation id, or null if they already have one for this campaign: one DM per
 * person per campaign.
 */
export async function claimConversation(
  db: D1Database,
  c: {
    campaignId: number;
    igUserId: string;
    commenterId: string | null;
    username: string | null;
    trigger: "comment" | "dm";
    commentId: string | null;
    state: ConversationState;
    lastInboundAt: number | null;
    now: number;
  },
): Promise<number | null> {
  const row = await db
    .prepare(
      // No conflict target: either unique key (messaging id or commenter id) blocks a second claim.
      `INSERT INTO conversations (campaign_id, ig_user_id, commenter_id, username, trigger, comment_id, state, last_inbound_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`,
    )
    .bind(c.campaignId, c.igUserId, c.commenterId, c.username, c.trigger, c.commentId, c.state, c.lastInboundAt, c.now, c.now)
    .first<{ id: number }>();
  return row?.id ?? null;
}

/** Undoes a claim whose first DM never went out, so a later comment can try again. */
export async function releaseClaim(db: D1Database, id: number): Promise<void> {
  await db.prepare("DELETE FROM conversations WHERE id = ? AND first_sent_at IS NULL").bind(id).run();
}
