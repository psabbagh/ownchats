import type { Ctx } from "./context";
import { safeEqual } from "./crypto";
import { iso } from "./time";

export interface LeadRow {
  id: number;
  campaign_id: number;
  campaign_name: string | null;
  ig_user_id: string;
  username: string | null;
  email: string;
  consent_text: string;
  consented_at: number;
}

export async function listLeads(
  ctx: Ctx,
  opts: { campaignId?: number; since?: number; limit?: number } = {},
): Promise<LeadRow[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.campaignId) {
    where.push("l.campaign_id = ?");
    binds.push(opts.campaignId);
  }
  if (opts.since) {
    where.push("l.consented_at >= ?");
    binds.push(opts.since);
  }
  const sql = `SELECT l.*, c.name AS campaign_name FROM leads l LEFT JOIN campaigns c ON c.id = l.campaign_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY l.consented_at DESC LIMIT ?`;
  const { results } = await ctx.db
    .prepare(sql)
    .bind(...binds, opts.limit ?? 100000)
    .all<LeadRow>();
  return results;
}

/** A CSV cell, quoted, with spreadsheet formulas neutralised. */
function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function leadsCsv(leads: LeadRow[]): string {
  const header = ["email", "instagram_username", "campaign", "consented_at", "consent_text"];
  const lines = [header.join(",")];
  for (const l of leads) {
    lines.push([l.email, l.username ?? "", l.campaign_name ?? "", iso(l.consented_at), l.consent_text].map(cell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * /export/leads.csv?key=...: the secret link for Google Sheets' IMPORTDATA. It
 * stops working as soon as the key is revoked or regenerated in Settings.
 */
export async function exportLeads(ctx: Ctx, url: URL): Promise<Response> {
  const expected = ctx.settings.export_key;
  const key = url.searchParams.get("key") ?? "";
  if (!expected || !safeEqual(key, expected)) return new Response("Not found", { status: 404 });
  return new Response(leadsCsv(await listLeads(ctx)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="ownchats-leads.csv"',
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
    },
  });
}
