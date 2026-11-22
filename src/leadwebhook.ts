import { alertFormat, alertRequest, type AlertPayload } from "./alertmessage";
import { consentFor, DEFAULTS, fill, getCampaign, type Campaign } from "./campaigns";
import { personalLink } from "./clicks";
import { logStatement, type Ctx } from "./context";
import { hmacSha256Hex } from "./crypto";
import { extractEmail } from "./match";
import { DAY, HOUR, iso, MINUTE, SECOND } from "./time";

/**
 * The lead webhook: each new email, and each deletion, POSTed to a URL the owner
 * sets, signed with a secret the owner sets. Any email tool, Zapier or Make can
 * start from it, so OwnChats knows nothing about any of them. The format is in
 * docs/lead-webhook.md.
 */
export type LeadEvent = "lead.created" | "lead.deleted";
/** Deliveries also carry the owner's alerts (alerts.ts), sent to the alert URL with the same queue and retries. */
export type DeliveryEvent = LeadEvent | "alert";

/** The waits between attempts. The eighth and last attempt comes about 22 hours after the first. */
export const RETRY_DELAYS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
export const MAX_ATTEMPTS = RETRY_DELAYS.length + 1;
/** An alert is tried for about 20 minutes (1, 5 and 15 minutes after the first): one that arrives hours late says something no longer true. */
export const ALERT_ATTEMPTS = 4;
export const TIMEOUT = 10 * SECOND;
/** An attempt in progress holds its delivery this long, so a request and the Cron never send it at the same time. */
const CLAIM = 2 * MINUTE;
/** Deliveries the Cron attempts per run, at most. */
const PER_RUN = 5;
/** Delivered and abandoned deliveries are listed in Settings for this long. */
export const KEEP_DELIVERIES = 30 * DAY;
export const MIN_SECRET_LENGTH = 16;

export interface WebhookConfig {
  url: string;
  secret: string;
  /** Where the secret comes from: the LEAD_WEBHOOK_SECRET Worker secret, or Settings. */
  secretFrom: "worker" | "settings";
}

/** The webhook's URL and secret, or null while either is missing. */
export function webhookConfig(ctx: Ctx): WebhookConfig | null {
  const url = ctx.settings.lead_webhook_url;
  const worker = ctx.env.LEAD_WEBHOOK_SECRET;
  const secret = worker || ctx.settings.lead_webhook_secret;
  if (!url || !secret) return null;
  return { url, secret, secretFrom: worker ? "worker" : "settings" };
}

export interface DeliveryRow {
  id: string;
  event: DeliveryEvent;
  payload: string;
  test: number;
  campaign_id: number | null;
  ig_user_id: string | null;
  username: string | null;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_attempt_at: number | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

/** What a new lead sends, apart from the fields each attempt adds. */
export interface NewLead {
  id: number;
  email: string;
  /** The Instagram name when Meta shared one. Never the username or "there". */
  name: string | null;
  createdAt: number;
  campaign: Pick<Campaign, "id" | "name" | "emailTag" | "linkTitle">;
  /** The link the DM sends this person: their own /go/ link when clicks are counted (see personalLink). */
  link: string | null;
  consentText: string;
  /** When they agreed to consentText, if not when the lead was created: an email given on an earlier campaign. */
  consentedAt?: number;
}

/** The campaign fields a new lead needs, the links included for personalLink. */
export type LeadCampaign = Pick<Campaign, "id" | "name" | "emailTag" | "linkTitle" | "links">;

export function leadCreatedPayload(l: NewLead): Record<string, unknown> {
  return {
    lead: { id: l.id, email: l.email, name: l.name || null, created_at: iso(l.createdAt) },
    campaign: { id: l.campaign.id, name: l.campaign.name, email_tag: l.campaign.emailTag || null, link: l.link, link_title: l.campaign.linkTitle || null },
    consent: { wording: l.consentText, given_at: iso(l.consentedAt ?? l.createdAt), channel: "instagram_dm" },
  };
}

/** A delivery to insert, and its id: new for each event, the same on every retry. */
export function queueStatement(
  ctx: Ctx,
  d: { event: DeliveryEvent; payload: Record<string, unknown>; test?: boolean; campaignId?: number | null; igUserId?: string | null; username?: string | null },
): { id: string; statement: D1PreparedStatement } {
  const id = crypto.randomUUID();
  const now = ctx.now();
  const statement = ctx.db
    .prepare(
      `INSERT INTO deliveries (id, event, payload, test, campaign_id, ig_user_id, username, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .bind(id, d.event, JSON.stringify(d.payload), d.test ? 1 : 0, d.campaignId ?? null, d.igUserId ?? null, d.username ?? null, now, now, now);
  return { id, statement };
}

/** Queues a new lead for the webhook. Returns the delivery id, or null when no webhook is set up. */
export async function queueLeadCreated(
  ctx: Ctx,
  lead: Omit<NewLead, "link" | "campaign"> & { campaign: LeadCampaign },
  who: { conversationId: number; igUserId: string; username: string | null },
): Promise<string | null> {
  if (!webhookConfig(ctx)) return null;
  const link = await personalLink(ctx, who.conversationId, lead.campaign);
  const { id, statement } = queueStatement(ctx, {
    event: "lead.created",
    payload: leadCreatedPayload({ ...lead, link }),
    campaignId: lead.campaign.id,
    igUserId: who.igUserId,
    username: who.username,
  });
  await statement.run();
  return id;
}

/**
 * For deleting a person: cancels their deliveries still waiting, and queues a
 * lead.deleted for each of their emails, so copies in other tools go too. The
 * lead.deleted rows name nobody, so they outlive the deletion until sent.
 */
export function deletionStatements(
  ctx: Ctx,
  igUserIds: string[],
  leads: Array<{ id: number; email: string; campaign_id: number }>,
): { statements: D1PreparedStatement[]; deliveries: string[] } {
  const marks = igUserIds.map(() => "?").join(", ");
  const statements = [ctx.db.prepare(`DELETE FROM deliveries WHERE ig_user_id IN (${marks})`).bind(...igUserIds)];
  const deliveries: string[] = [];
  if (!webhookConfig(ctx)) return { statements, deliveries };
  for (const l of leads) {
    const { id, statement } = queueStatement(ctx, { event: "lead.deleted", payload: { lead: { id: l.id, email: l.email } }, campaignId: l.campaign_id });
    statements.push(statement);
    deliveries.push(id);
  }
  return { statements, deliveries };
}

/** The JSON body of one attempt. sent_at is the attempt's time; delivery_id stays the same on every retry. */
export function eventBody(row: Pick<DeliveryRow, "id" | "event" | "payload" | "test">, now: number): string {
  return JSON.stringify({ event: row.event, delivery_id: row.id, sent_at: iso(now), test: row.test === 1, ...(JSON.parse(row.payload) as object) });
}

/** X-OwnChats-Signature: HMAC-SHA256 of "<timestamp>.<raw body>", keyed with the secret, in hex. */
export async function signature(secret: string, timestamp: string, body: string): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, `${timestamp}.${body}`)}`;
}

function inWords(ms: number): string {
  if (ms >= HOUR) return ms === HOUR ? "1 hour" : `${ms / HOUR} hours`;
  return ms === MINUTE ? "1 minute" : `${ms / MINUTE} minutes`;
}

/** Where and what one attempt sends. */
interface Target {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A lead event: signed JSON to the lead webhook, or null once it was turned off. */
async function leadTarget(ctx: Ctx, row: DeliveryRow, now: number): Promise<Target | null> {
  const config = webhookConfig(ctx);
  if (!config) return null;
  const body = eventBody(row, now);
  const timestamp = String(Math.floor(now / 1000));
  return {
    url: config.url,
    body,
    headers: {
      "content-type": "application/json",
      "user-agent": "OwnChats-Webhook/1",
      "x-ownchats-event": row.event,
      "x-ownchats-delivery": row.id,
      "x-ownchats-timestamp": timestamp,
      "x-ownchats-signature": await signature(config.secret, timestamp, body),
    },
  };
}

/** An alert: shaped for the alert URL's receiver (alertmessage.ts), or null once the URL was turned off. */
function alertTarget(ctx: Ctx, row: DeliveryRow, now: number): Target | null {
  const url = ctx.settings.alert_url;
  if (!url) return null;
  const { body, headers } = alertRequest(url, alertFormat(ctx.settings.alert_format), JSON.parse(row.payload) as AlertPayload, { id: row.id, now, test: row.test === 1 });
  return { url, body, headers: { ...headers, "user-agent": "OwnChats-Alerts/1", "x-ownchats-event": "alert", "x-ownchats-delivery": row.id } };
}

/** Takes due deliveries for this invocation; `id` limits it to one. */
async function claim(ctx: Ctx, limit: number, id?: string): Promise<DeliveryRow[]> {
  const now = ctx.now();
  const { results } = await ctx.db
    .prepare(
      `UPDATE deliveries SET next_attempt_at = ?1 WHERE id IN (
         SELECT id FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ?2 ${id ? "AND id = ?4" : ""}
         ORDER BY next_attempt_at LIMIT ?3) RETURNING *`,
    )
    .bind(now + CLAIM, now, limit, ...(id ? [id] : []))
    .all<DeliveryRow>();
  return results;
}

/**
 * One attempt. A 2xx reply means delivered. A 429, a 5xx, a timeout or no
 * connection means retry later, up to MAX_ATTEMPTS; any other reply is final.
 * Every attempt goes in the activity log.
 */
/** What one attempt got back: the HTTP status (0 with no reply), the result in words, and the start of the receiver's reply. */
export interface Attempt {
  status: number;
  result: string;
  reply: string;
}

async function attempt(ctx: Ctx, row: DeliveryRow): Promise<Attempt | null> {
  const now = ctx.now();
  const n = row.attempts + 1;
  const isAlert = row.event === "alert";
  const kind = isAlert ? "alert" : "lead_webhook";
  const max = isAlert ? ALERT_ATTEMPTS : MAX_ATTEMPTS;
  const alert = isAlert ? (JSON.parse(row.payload) as Partial<AlertPayload>) : null;
  const label = isAlert ? `${row.test ? "Test alert" : "Alert"}${alert?.title ? ` "${alert.title}"` : ""}` : `${row.test ? "Test " : ""}${row.event}`;
  const who = { campaignId: row.campaign_id, igUserId: row.ig_user_id, username: row.username };
  const target = isAlert ? alertTarget(ctx, row, now) : await leadTarget(ctx, row, now);
  if (!target) {
    const off = isAlert ? "the alert URL was turned off" : "the lead webhook was turned off";
    await ctx.db.batch([
      settleStatement(ctx, row.id, "failed", row.attempts, null, off),
      logStatement(ctx, { kind, outcome: "failed", reason: `${label}: ${off}`, ...who, detail: row.id }),
    ]);
    return null;
  }
  if (!ctx.budget.take()) {
    // No outgoing request left in this invocation: the next Cron run takes it.
    await ctx.db.prepare("UPDATE deliveries SET next_attempt_at = ? WHERE id = ?").bind(now, row.id).run();
    return null;
  }

  let status = 0;
  let result: string;
  let reply = "";
  try {
    const res = await ctx.fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: target.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    status = res.status;
    result = `HTTP ${status}`;
    reply = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    result =
      name === "TimeoutError" || name === "AbortError"
        ? `timed out after ${TIMEOUT / SECOND} seconds`
        : `could not connect (${err instanceof Error ? err.message : String(err)})`.slice(0, 200);
  }

  const got = { status, result, reply };
  const detail = `${row.id}, attempt ${n} of ${max}${status >= 300 && status < 400 ? ": the URL redirects, use the address it redirects to" : reply ? `: ${reply}` : ""}`;
  if (status >= 200 && status < 300) {
    await ctx.db.batch([
      settleStatement(ctx, row.id, "delivered", n, null, result),
      logStatement(ctx, { kind, outcome: "sent", reason: `${label} delivered (${result})`, ...who, detail }),
    ]);
    return got;
  }
  const retryable = status === 0 || status === 429 || status >= 500;
  if (retryable && n < max) {
    const wait = RETRY_DELAYS[n - 1]!;
    await ctx.db.batch([
      settleStatement(ctx, row.id, "pending", n, now + wait, result),
      logStatement(ctx, { kind, outcome: "queued", reason: `${label}: ${result}, retrying in ${inWords(wait)}`, ...who, detail }),
    ]);
    return got;
  }
  const why = retryable ? `${result}, gave up after ${n} attempts` : `${result}, not retried`;
  await ctx.db.batch([
    settleStatement(ctx, row.id, "failed", n, null, result),
    logStatement(ctx, { kind, outcome: "failed", reason: `${label}: ${why}`, ...who, detail }),
  ]);
  return got;
}

/** Records an attempt. Once a delivery is settled its payload is emptied: the lead stays in Leads, and a deleted person's email goes. */
function settleStatement(ctx: Ctx, id: string, status: DeliveryRow["status"], attempts: number, next: number | null, result: string): D1PreparedStatement {
  return ctx.db
    .prepare(
      `UPDATE deliveries SET status = ?1, attempts = ?2, next_attempt_at = ?3, last_result = ?4,
         payload = CASE WHEN ?1 = 'pending' THEN payload ELSE '{}' END, updated_at = ?5 WHERE id = ?6`,
    )
    .bind(status, attempts, next, result, ctx.now(), id);
}

/**
 * Sends one delivery now, if it is due and the invocation has room; otherwise the
 * Cron sends it within a minute. Returns what the attempt got, or null when none was made.
 */
export async function deliverNow(ctx: Ctx, id: string | null): Promise<Attempt | null> {
  if (!id || ctx.budget.left < 1 || ctx.budget.queriesLeft < 3) return null;
  const [row] = await claim(ctx, 1, id);
  return row ? attempt(ctx, row) : null;
}

/** The Cron's part: the deliveries that are due, a few per run. */
export async function deliverDue(ctx: Ctx): Promise<void> {
  // One query to claim, then one per attempt.
  const room = Math.min(PER_RUN, ctx.budget.left, ctx.budget.queriesLeft - 2);
  if (room < 1) return;
  for (const row of await claim(ctx, room)) await attempt(ctx, row);
}

/** A test lead ready to send, or why it can't be: the same checks for the dashboard's form and POST /api/test-lead. */
export type TestLeadCheck =
  | { error: string; problem: "no_webhook" | "bad_email" | "no_campaign" }
  | { email: string; name: string | null; campaign: LeadCampaign; consentText: string };

/**
 * Checks what the owner typed for a test lead: the webhook must be set up, the
 * email one well-formed address, and a campaign id, when given, an existing
 * campaign. With no campaign id, a stand-in, so the webhook can be checked
 * before the first campaign exists.
 */
export async function checkTestLead(ctx: Ctx, input: { email: string; name?: string | null; campaignId?: number | null }): Promise<TestLeadCheck> {
  if (!webhookConfig(ctx)) return { problem: "no_webhook", error: "Set the webhook's URL and secret first." };
  const typed = input.email.trim();
  const email = extractEmail(typed);
  if (!email || email !== typed.toLowerCase()) return { problem: "bad_email", error: "Enter one email address to send the test lead to." };
  const name = (input.name ?? "").trim().slice(0, 100) || null;
  if (!input.campaignId) return { email, name, campaign: { id: 0, name: "Test", emailTag: "", linkTitle: "", links: [] }, consentText: DEFAULTS.optionalPrompt };
  const chosen = await getCampaign(ctx.db, input.campaignId);
  if (!chosen) return { problem: "no_campaign", error: "No campaign with that id." };
  return { email, name, campaign: chosen, consentText: fill(consentFor(chosen), { name }) };
}

/**
 * Sends a lead marked as a test, built exactly as a real one, and returns its
 * delivery id and what the first attempt got (null when the Cron sends it
 * instead). Its /go/ link leads where the campaign's does and counts nowhere.
 */
export async function sendTestLead(
  ctx: Ctx,
  t: { email: string; name: string | null; campaign: LeadCampaign; consentText: string },
): Promise<{ id: string; attempt: Attempt | null }> {
  const link = await personalLink(ctx, null, t.campaign);
  const { id, statement } = queueStatement(ctx, {
    event: "lead.created",
    test: true,
    payload: leadCreatedPayload({ id: 0, email: t.email, name: t.name, createdAt: ctx.now(), campaign: t.campaign, link, consentText: t.consentText }),
  });
  await statement.run();
  return { id, attempt: await deliverNow(ctx, id) };
}

export async function recentDeliveries(ctx: Ctx, limit = 10): Promise<DeliveryRow[]> {
  const { results } = await ctx.db.prepare("SELECT * FROM deliveries WHERE event <> 'alert' ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(limit).all<DeliveryRow>();
  return results;
}

export async function getDelivery(ctx: Ctx, id: string): Promise<DeliveryRow | null> {
  return ctx.db.prepare("SELECT * FROM deliveries WHERE id = ?").bind(id).first<DeliveryRow>();
}
