import type { Ctx } from "./context";
import { DAY } from "./time";

export interface CampaignCounts {
  campaignId: number;
  people: number;
  dmsSent: number;
  taps: number;
  emails: number;
  linksSent: number;
  failed: number;
}

/** The funnel per campaign: people matched, first DMs sent, taps, emails, links. */
export async function campaignCounts(ctx: Ctx): Promise<Map<number, CampaignCounts>> {
  const [conv, taps, leads, failed] = await ctx.db.batch<Record<string, number>>([
    ctx.db.prepare(
      `SELECT campaign_id, COUNT(*) AS people, COUNT(first_sent_at) AS dms, SUM(state IN ('done', 'optional_email')) AS links
       FROM conversations GROUP BY campaign_id`,
    ),
    ctx.db.prepare("SELECT campaign_id, COUNT(*) AS n FROM activity WHERE kind = 'tap' AND outcome = 'received' GROUP BY campaign_id"),
    ctx.db.prepare("SELECT campaign_id, COUNT(*) AS n FROM leads GROUP BY campaign_id"),
    ctx.db.prepare("SELECT campaign_id, COUNT(*) AS n FROM activity WHERE outcome = 'failed' AND campaign_id IS NOT NULL GROUP BY campaign_id"),
  ]);
  const out = new Map<number, CampaignCounts>();
  const get = (id: number) => {
    let c = out.get(id);
    if (!c) {
      c = { campaignId: id, people: 0, dmsSent: 0, taps: 0, emails: 0, linksSent: 0, failed: 0 };
      out.set(id, c);
    }
    return c;
  };
  for (const r of conv!.results) Object.assign(get(r.campaign_id!), { people: r.people, dmsSent: r.dms, linksSent: r.links ?? 0 });
  for (const r of taps!.results) get(r.campaign_id!).taps = r.n!;
  for (const r of leads!.results) get(r.campaign_id!).emails = r.n!;
  for (const r of failed!.results) get(r.campaign_id!).failed = r.n!;
  return out;
}

/** What happened to the comments a campaign watches, over one period. */
export interface CommentTally {
  total: number;
  /** Answered by this campaign. */
  answered: number;
  /** Answered by another campaign (an all-posts one with another keyword). */
  answeredElsewhere: number;
  skipped: number;
  failed: number;
  /** Not handled yet: new, queued or mid-way. */
  waiting: number;
}

/** One branch of a campaign's funnel: people who came from a comment, or from a DM keyword. */
export interface Funnel {
  dmsSent: number;
  /** Tapped the opening button, or wrote back instead. */
  opened: number;
  emails: number;
  links: number;
}

export interface CampaignResults {
  /** Comments written in the last 24 hours. */
  day: CommentTally;
  /** Comments written in the last 30 days, about all OwnChats keeps. */
  month: CommentTally;
  /** Why comments were skipped, last 30 days, most frequent first. */
  skipReasons: Array<{ reason: string; n: number }>;
  fromComments: Funnel;
  fromDms: Funnel;
  /** The last 24 hours of the funnel, counted from the log. */
  lastDay: { dmsSent: number; taps: number; emails: number; links: number };
  /** Links sent again because the person sent the keyword by DM, from the log. */
  resent: number;
  /** Failures from the log, by kind and reason, latest first. */
  failures: Array<{ kind: string; reason: string; n: number; last: number }>;
}

/** Comments that belong on a campaign's page: those on its post, and those it answered elsewhere. */
const CAMPAIGN_COMMENTS = "(media_id = ?1 OR campaign_id = ?2) AND reason IS NOT 'own reply'";
export const COMMENT_DAYS = 30;
const LINK_SENT = `outcome = 'sent' AND ((kind = 'link' AND reason IS NOT 'link sent again on request') OR (kind = 'private_reply' AND reason LIKE 'link%'))`;

const num = (v: unknown) => Number(v ?? 0);

/**
 * A campaign's results. Comment counts come from the comments table, kept 30
 * days. The funnel counts conversations, kept until the person is deleted, so
 * it covers the whole life of the campaign. The log (90 days) gives the last
 * 24 hours, the resends and the failures.
 */
export async function campaignResults(ctx: Ctx, campaign: { id: number; mediaId: string | null }): Promise<CampaignResults> {
  const now = ctx.now();
  const day = now - DAY;
  const month = now - COMMENT_DAYS * DAY;
  const tally = (since: number) =>
    ctx.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(status = 'done' AND campaign_id = ?2) AS answered,
           SUM(status = 'done' AND campaign_id IS NOT ?2) AS elsewhere, SUM(status = 'skipped') AS skipped,
           SUM(status = 'failed') AS failed, SUM(status IN ('new', 'queued', 'processing')) AS waiting
         FROM comments WHERE ${CAMPAIGN_COMMENTS} AND commented_at > ?3`,
      )
      .bind(campaign.mediaId, campaign.id, since);
  const [dayRow, monthRow, reasons, funnel, recent, failures] = await ctx.db.batch<Record<string, unknown>>([
    tally(day),
    tally(month),
    ctx.db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM comments WHERE ${CAMPAIGN_COMMENTS} AND status = 'skipped' AND commented_at > ?3
         GROUP BY reason ORDER BY n DESC, reason`,
      )
      .bind(campaign.mediaId, campaign.id, month),
    ctx.db
      .prepare(
        `SELECT v.trigger, COUNT(v.first_sent_at) AS dms,
           SUM(v.first_sent_at IS NOT NULL AND v.state <> 'opened') AS opened,
           SUM(v.first_sent_at IS NOT NULL AND v.state IN ('done', 'optional_email')) AS links,
           COUNT(l.id) AS emails
         FROM conversations v LEFT JOIN leads l ON l.campaign_id = v.campaign_id AND l.ig_user_id = v.ig_user_id
         WHERE v.campaign_id = ? GROUP BY v.trigger`,
      )
      .bind(campaign.id),
    ctx.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM conversations WHERE campaign_id = ?1 AND first_sent_at > ?2) AS dms,
           (SELECT COUNT(*) FROM activity WHERE campaign_id = ?1 AND kind = 'tap' AND outcome = 'received' AND at > ?2) AS taps,
           (SELECT COUNT(*) FROM leads WHERE campaign_id = ?1 AND consented_at > ?2) AS emails,
           (SELECT COUNT(*) FROM activity WHERE campaign_id = ?1 AND at > ?2 AND ${LINK_SENT}) AS links,
           (SELECT COUNT(*) FROM activity WHERE campaign_id = ?1 AND kind = 'link' AND outcome = 'sent' AND reason = 'link sent again on request') AS resent`,
      )
      .bind(campaign.id, day),
    ctx.db
      .prepare(
        `SELECT kind, COALESCE(reason, 'no reason given') AS reason, COUNT(*) AS n, MAX(at) AS last FROM activity
         WHERE campaign_id = ? AND outcome = 'failed' GROUP BY kind, reason ORDER BY last DESC`,
      )
      .bind(campaign.id),
  ]);
  const toTally = (r: Record<string, unknown> | undefined): CommentTally => ({
    total: num(r?.total),
    answered: num(r?.answered),
    answeredElsewhere: num(r?.elsewhere),
    skipped: num(r?.skipped),
    failed: num(r?.failed),
    waiting: num(r?.waiting),
  });
  const toFunnel = (trigger: string): Funnel => {
    const r = funnel!.results.find((f) => f.trigger === trigger);
    return { dmsSent: num(r?.dms), opened: num(r?.opened), emails: num(r?.emails), links: num(r?.links) };
  };
  const last = recent!.results[0] ?? {};
  return {
    day: toTally(dayRow!.results[0]),
    month: toTally(monthRow!.results[0]),
    skipReasons: reasons!.results.map((r) => ({ reason: String(r.reason ?? "no reason given"), n: num(r.n) })),
    fromComments: toFunnel("comment"),
    fromDms: toFunnel("dm"),
    lastDay: { dmsSent: num(last.dms), taps: num(last.taps), emails: num(last.emails), links: num(last.links) },
    resent: num(last.resent),
    failures: failures!.results.map((r) => ({ kind: String(r.kind), reason: String(r.reason), n: num(r.n), last: num(r.last) })),
  };
}

/** One comment on a campaign's page, with how far its DM got. */
export interface CommentLine {
  id: string;
  text: string;
  from_username: string | null;
  commented_at: number;
  status: string;
  reason: string | null;
  campaign_id: number | null;
  parent_id: string | null;
  /** The conversation the comment started, when it was answered. */
  state: string | null;
  has_email: number;
}

export type CommentFilter = "all" | "answered" | "skipped" | "failed";
export const COMMENT_FILTERS: CommentFilter[] = ["all", "answered", "skipped", "failed"];

/** The comments on a campaign's page, newest first. */
export async function listCampaignComments(
  ctx: Ctx,
  campaign: { id: number; mediaId: string | null },
  opts: { show?: CommentFilter; before?: number; limit?: number } = {},
): Promise<CommentLine[]> {
  const where = ["(c.media_id = ?1 OR c.campaign_id = ?2) AND c.reason IS NOT 'own reply'"];
  const binds: unknown[] = [campaign.mediaId, campaign.id];
  const status = { answered: "done", skipped: "skipped", failed: "failed" } as Record<string, string>;
  if (opts.show && status[opts.show]) {
    where.push(`c.status = ?${binds.length + 1}`);
    binds.push(status[opts.show]);
  }
  if (opts.before) {
    where.push(`c.commented_at < ?${binds.length + 1}`);
    binds.push(opts.before);
  }
  binds.push(Math.min(opts.limit ?? 100, 500));
  const { results } = await ctx.db
    .prepare(
      `SELECT c.id, c.text, c.from_username, c.commented_at, c.status, c.reason, c.campaign_id, c.parent_id,
         v.state, l.id IS NOT NULL AS has_email
       FROM comments c
       LEFT JOIN conversations v ON v.comment_id = c.id AND v.campaign_id = c.campaign_id
       LEFT JOIN leads l ON l.campaign_id = v.campaign_id AND l.ig_user_id = v.ig_user_id
       WHERE ${where.join(" AND ")} ORDER BY c.commented_at DESC, c.id DESC LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<CommentLine>();
  return results;
}

export interface ActivityRow {
  id: number;
  at: number;
  kind: string;
  outcome: string;
  reason: string | null;
  campaign_id: number | null;
  comment_id: string | null;
  ig_user_id: string | null;
  username: string | null;
  detail: string | null;
}

export async function listActivity(
  ctx: Ctx,
  opts: { limit?: number; campaignId?: number; outcome?: string; matchedOnly?: boolean; before?: number } = {},
): Promise<ActivityRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.campaignId) {
    where.push("campaign_id = ?");
    binds.push(opts.campaignId);
  }
  if (opts.outcome) {
    where.push("outcome = ?");
    binds.push(opts.outcome);
  }
  if (opts.matchedOnly) where.push("NOT (kind = 'comment' AND outcome = 'skipped' AND campaign_id IS NULL)");
  if (opts.before) {
    where.push("id < ?");
    binds.push(opts.before);
  }
  const { results } = await ctx.db
    .prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .bind(...binds, Math.min(opts.limit ?? 100, 1000))
    .all<ActivityRow>();
  return results;
}

/**
 * Deletes everything stored about one person: their data-deletion request.
 *
 * Each of their comments keeps its id and nothing else. Without that marker, the
 * next poll (or a webhook Meta delivers again) would take the comment for a new
 * one, store the person again and try to answer them again. The Cron removes the
 * markers with the other old comments, long after the poll stops reading them.
 */
export async function deletePerson(ctx: Ctx, igUserId: string): Promise<void> {
  // A comment can carry a different id from the messaging one; their conversations know both.
  const { results } = await ctx.db
    .prepare("SELECT DISTINCT commenter_id AS id FROM conversations WHERE ig_user_id = ? AND commenter_id IS NOT NULL")
    .bind(igUserId)
    .all<{ id: string }>();
  const ids = [...new Set([igUserId, ...results.map((r) => r.id)])];
  const marks = ids.map(() => "?").join(", ");
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM leads WHERE ig_user_id = ?").bind(igUserId),
    ctx.db.prepare("DELETE FROM conversations WHERE ig_user_id = ?").bind(igUserId),
    ctx.db
      .prepare(
        `UPDATE comments SET from_id = NULL, from_username = NULL, text = '', status = 'skipped', reason = 'person deleted',
           campaign_id = NULL, locked_at = NULL WHERE from_id IN (${marks})`,
      )
      .bind(...ids),
    ctx.db.prepare(`DELETE FROM activity WHERE ig_user_id IN (${marks})`).bind(...ids),
  ]);
}

/** Finds a person's id by username, for deletion requests that name only the username. */
export async function findPersonByUsername(ctx: Ctx, username: string): Promise<string[]> {
  const name = username.replace(/^@/, "").trim().toLowerCase();
  const { results } = await ctx.db
    .prepare(
      `SELECT ig_user_id AS id FROM conversations WHERE LOWER(username) = ?1
       UNION SELECT from_id AS id FROM comments WHERE LOWER(from_username) = ?1 AND from_id IS NOT NULL
       UNION SELECT ig_user_id AS id FROM leads WHERE LOWER(username) = ?1`,
    )
    .bind(name)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}
