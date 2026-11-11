import { getCampaign, onAllPosts, type Campaign } from "./campaigns";
import type { Ctx } from "./context";
import { CommentText, KeywordSet, matchesKeyword, parseKeywords } from "./match";
import { handleComment } from "./pipeline/comments";
import { DAY, HOUR, PRIVATE_REPLY_WINDOW } from "./time";

/**
 * Comments a campaign could still answer by hand: skipped, but close to its
 * keyword, matching it now, or written before the campaign started. Only these
 * two skip reasons qualify: OwnChats never sent a private reply for them, so
 * answering one can't be a second reply from OwnChats.
 */
const ANSWERABLE = ["no matching campaign", "written before the campaign started"];
const NO_MATCH = ANSWERABLE[0]!;
/** The list and its count look at this many recent skipped comments at most. */
const SCAN_LIMIT = 500;
/** Too close to the end of Meta's window to be worth a click. */
const MIN_LEFT = 60_000;

export type MissedWhy = "close" | "matches" | "before";

export interface MissedComment {
  id: string;
  text: string;
  fromUsername: string | null;
  commentedAt: number;
  why: MissedWhy;
  /** For "close": the keyword it came close to, and the spelling to add, if one makes sense. */
  keyword: string | null;
  spelling: string | null;
  /** Also written before the campaign started. */
  beforeStart: boolean;
  /** Milliseconds left in Meta's 7-day window. */
  left: number;
}

interface Candidate {
  id: string;
  text: string;
  from_id: string;
  from_username: string | null;
  commented_at: number;
  reason: string;
  campaign_id: number | null;
  media_id: string;
}

/** What is left of Meta's 7-day window for one comment. */
export function timeLeft(ms: number): string {
  if (ms >= 2 * DAY) return `${Math.floor(ms / DAY)} days left to answer`;
  if (ms >= DAY) return "1 day left to answer";
  if (ms >= 2 * HOUR) return `${Math.floor(ms / HOUR)} hours left to answer`;
  return "less than 2 hours left to answer";
}

function onItsPosts(c: Candidate, campaign: Campaign): boolean {
  return c.media_id === campaign.mediaId || onAllPosts(campaign);
}

/**
 * Why a skipped comment is worth answering for this campaign, or null. The
 * comment's text is read once per request (`read`), and the campaign's keywords
 * prepared once (`keywords`), because this runs for every candidate and every
 * campaign on each dashboard load, inside the free plan's 10 ms of CPU.
 */
function judge(
  c: Candidate,
  read: (c: Candidate) => CommentText,
  campaign: Campaign,
  keywords: KeywordSet,
): Pick<MissedComment, "why" | "keyword" | "spelling"> | null {
  if (c.reason !== NO_MATCH) return c.campaign_id === campaign.id ? { why: "before", keyword: null, spelling: null } : null;
  if (!onItsPosts(c, campaign)) return null;
  // It matched no active campaign when it came in. It may match now: the campaign was off, or the spelling is new.
  if (campaign.anyComment || keywords.matches(read(c))) return { why: "matches", keyword: null, spelling: null };
  const near = keywords.closeTo(read(c));
  return near ? { why: "close", keyword: near.keyword, spelling: near.spelling } : null;
}

const ORDER: Record<MissedWhy, number> = { close: 0, matches: 1, before: 2 };

/**
 * The comments to check, per campaign: near misses first, then comments that
 * match now, then those written before the campaign started. Leaves out people
 * who already got the campaign's DM, and comments Meta no longer lets anyone answer.
 */
export async function missedComments(ctx: Ctx, campaigns: Campaign[]): Promise<Map<number, MissedComment[]>> {
  const out = new Map<number, MissedComment[]>();
  if (!campaigns.length) return out;
  const since = ctx.now() - PRIVATE_REPLY_WINDOW + MIN_LEFT;
  // Only comments these campaigns could answer: written before one of them started,
  // or matching no campaign on a post one of them watches.
  const ids = JSON.stringify(campaigns.map((c) => c.id));
  const allPosts = campaigns.some(onAllPosts) ? 1 : 0;
  const posts = JSON.stringify(campaigns.flatMap((c) => (c.mediaId ? [c.mediaId] : [])));
  const filter = `status = 'skipped' AND from_id IS NOT NULL AND commented_at > ?1 AND (
      (reason = 'written before the campaign started' AND campaign_id IN (SELECT value FROM json_each(?2)))
      OR (reason = 'no matching campaign' AND (?3 = 1 OR media_id IN (SELECT value FROM json_each(?4)))))`;
  const binds = [since, ids, allPosts, posts];
  const [candidates, people] = await ctx.db.batch<Record<string, unknown>>([
    ctx.db
      .prepare(
        `SELECT id, text, from_id, from_username, commented_at, reason, campaign_id, media_id FROM comments
         WHERE ${filter} ORDER BY commented_at DESC LIMIT ${SCAN_LIMIT}`,
      )
      .bind(...binds),
    ctx.db
      .prepare(
        `SELECT campaign_id, ig_user_id, commenter_id FROM conversations
         WHERE ig_user_id IN (SELECT from_id FROM comments WHERE ${filter}) OR commenter_id IN (SELECT from_id FROM comments WHERE ${filter})`,
      )
      .bind(...binds),
  ]);
  const answered = new Set<string>();
  for (const p of people!.results) {
    answered.add(`${p.campaign_id}:${p.ig_user_id}`);
    if (p.commenter_id) answered.add(`${p.campaign_id}:${p.commenter_id}`);
  }
  const rows = candidates!.results as unknown as Candidate[];
  const texts = new Map<string, CommentText>();
  const read = (c: Candidate) => {
    let t = texts.get(c.id);
    if (!t) texts.set(c.id, (t = new CommentText(c.text)));
    return t;
  };
  for (const campaign of campaigns) {
    const list: MissedComment[] = [];
    const keywords = new KeywordSet(campaign.keywords);
    for (const c of rows) {
      if (answered.has(`${campaign.id}:${c.from_id}`)) continue;
      const verdict = judge(c, read, campaign, keywords);
      if (!verdict) continue;
      list.push({
        id: c.id,
        text: c.text,
        fromUsername: c.from_username,
        commentedAt: c.commented_at,
        ...verdict,
        beforeStart: c.commented_at < campaign.createdAt,
        left: c.commented_at + PRIVATE_REPLY_WINDOW - ctx.now(),
      });
    }
    list.sort((a, b) => ORDER[a.why] - ORDER[b.why] || b.commentedAt - a.commentedAt);
    if (list.length) out.set(campaign.id, list);
  }
  return out;
}

export type AnswerProblem = "offline" | "off" | "gone" | "window" | "already" | "spelling";

/** Why "Answer" did nothing, in the dashboard's words. */
export const ANSWER_PROBLEM: Record<AnswerProblem, string> = {
  offline: "Instagram is not connected, so nothing can be sent. Reconnect on the setup page.",
  off: "Switch the campaign on first, then answer.",
  gone: "That comment can't be answered from here any more: it was answered, deleted, or isn't on this campaign's post.",
  window: "Meta no longer allows a DM for that comment: it is more than 7 days old.",
  already: "That person already got this campaign's DM.",
  spelling: "That spelling doesn't match the comment, so it wasn't added.",
};

/**
 * The owner's "Answer" (and "Add spelling and answer"): hands one skipped comment
 * to this campaign and runs it through the comment pipeline now. The pipeline
 * keeps every rule: one DM per person per campaign, Meta's 7-day window, and the
 * one private reply per comment, which Meta enforces too. The update only
 * succeeds once, so a second click sends nothing.
 */
export async function answerMissed(
  ctx: Ctx,
  campaignId: number,
  commentId: string,
  spelling: string,
): Promise<{ problem: AnswerProblem } | { status: string }> {
  if (!ctx.meta) return { problem: "offline" };
  const campaign = await getCampaign(ctx.db, campaignId);
  if (!campaign) return { problem: "gone" };
  if (!campaign.active) return { problem: "off" };
  const row = await ctx.db
    .prepare(
      `SELECT id, text, from_id, from_username, commented_at, reason, campaign_id, media_id FROM comments
       WHERE id = ? AND status = 'skipped' AND from_id IS NOT NULL AND reason IN (${ANSWERABLE.map(() => "?").join(", ")})`,
    )
    .bind(commentId, ...ANSWERABLE)
    .first<Candidate>();
  if (!row) return { problem: "gone" };
  if (row.reason === NO_MATCH ? !onItsPosts(row, campaign) : row.campaign_id !== campaign.id) return { problem: "gone" };
  if (ctx.now() - row.commented_at > PRIVATE_REPLY_WINDOW - MIN_LEFT) return { problem: "window" };
  const person = await ctx.db
    .prepare("SELECT 1 AS yes FROM conversations WHERE campaign_id = ?1 AND (ig_user_id = ?2 OR commenter_id = ?2) LIMIT 1")
    .bind(campaign.id, row.from_id)
    .first();
  if (person) return { problem: "already" };

  if (spelling) {
    const added = parseKeywords(spelling);
    if (campaign.anyComment || added.length !== 1 || added[0]!.length > 40 || !matchesKeyword(row.text, added)) return { problem: "spelling" };
    const keywords = parseKeywords([...campaign.keywords, added[0]!].join(", "));
    await ctx.db.prepare("UPDATE campaigns SET keywords = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(keywords), ctx.now(), campaign.id).run();
  }

  // Only a comment still skipped is handed over, so two clicks can't queue it twice.
  const handed = await ctx.db
    .prepare(
      `UPDATE comments SET status = 'new', reason = NULL, campaign_id = ?, attempts = 0, locked_at = NULL
       WHERE id = ? AND status = 'skipped' AND reason IN (${ANSWERABLE.map(() => "?").join(", ")})`,
    )
    .bind(campaign.id, row.id, ...ANSWERABLE)
    .run();
  if (handed.meta.changes !== 1) return { problem: "gone" };
  await handleComment(ctx, row.id);
  const after = await ctx.db.prepare("SELECT status FROM comments WHERE id = ?").bind(row.id).first<{ status: string }>();
  return { status: after?.status ?? "new" };
}

/** The outcome of an answer, read back from the comment, in the dashboard's words. */
export async function answerOutcome(ctx: Ctx, commentId: string): Promise<{ ok: boolean; text: string } | null> {
  const row = await ctx.db
    .prepare("SELECT status, reason, from_username FROM comments WHERE id = ?")
    .bind(commentId)
    .first<{ status: string; reason: string | null; from_username: string | null }>();
  if (!row) return null;
  const who = row.from_username ? `@${row.from_username}` : "them";
  switch (row.status) {
    case "done":
      return { ok: true, text: `Answered: the DM went to ${who}, and the public reply is posted.` };
    case "failed": {
      // A refusal OwnChats has no words for: show Meta's own, which the activity log kept.
      const known = row.reason && row.reason !== "Meta refused" && row.reason !== "error" ? row.reason : null;
      const said = known
        ? null
        : await ctx.db
            .prepare("SELECT detail FROM activity WHERE comment_id = ? AND kind = 'private_reply' AND outcome = 'failed' ORDER BY at DESC, id DESC LIMIT 1")
            .bind(commentId)
            .first<{ detail: string | null }>();
      const why = known ?? (said?.detail ? `Meta said "${said.detail}"` : "Meta gave no reason");
      return { ok: false, text: `The DM to ${who} did not go out: ${why}. Nothing was sent.` };
    }
    case "skipped":
      return { ok: false, text: `Not answered: ${row.reason ?? "no reason given"}.` };
    default:
      return { ok: true, text: `On its way: ${row.reason ?? "it goes out within a minute"}.` };
  }
}
