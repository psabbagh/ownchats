import type { Ctx } from "./context";

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

/** Deletes everything stored about one person: their data-deletion request. */
export async function deletePerson(ctx: Ctx, igUserId: string): Promise<void> {
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM leads WHERE ig_user_id = ?").bind(igUserId),
    ctx.db.prepare("DELETE FROM conversations WHERE ig_user_id = ?").bind(igUserId),
    ctx.db.prepare("DELETE FROM comments WHERE from_id = ?").bind(igUserId),
    ctx.db.prepare("DELETE FROM activity WHERE ig_user_id = ?").bind(igUserId),
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
