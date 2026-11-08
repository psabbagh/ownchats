import type { Campaign } from "./campaigns";
import type { Ctx } from "./context";
import { randomToken } from "./crypto";
import type { OutMessage } from "./meta/client";
import { html, page } from "./pages/html";

/**
 * Click counting. Each campaign link goes out as <OwnChats address>/go/<id>, with
 * one random id per conversation and link, and the Worker answers with a 302 to
 * the real link. The id is all the URL carries: no username, name or email.
 */

/**
 * Fetches that are not a person opening the link: link previews and crawlers.
 * Meta draws link previews in Instagram's DMs, and across its apps, with
 * facebookexternalhit; its other crawlers are Facebot, facebookcatalog and the
 * meta-* agents. Apple's iMessage previews also call themselves facebookexternalhit.
 * A browser opening the link, Instagram's in-app browser included
 * ("... Instagram 400.0.0.0.0 ..."), matches none of these. A request with no
 * user agent at all is not a person either.
 */
const PREVIEW_AGENTS =
  /facebookexternalhit|facebot|facebookcatalog|meta-(?:webindexer|external)|twitterbot|slackbot|slack-imgproxy|discordbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|pinterest|redditbot|embedly|iframely|vkshare|bitlybot|googlebot|google-inspectiontool|storebot-google|bingbot|bingpreview|applebot|duckduckbot|yandex|baiduspider|petalbot|bytespider|mastodon|cardyb|snap url preview|preview|crawler|spider|headless|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|node-fetch|axios/i;

export function isPreviewFetch(userAgent: string | null): boolean {
  return !userAgent?.trim() || PREVIEW_AGENTS.test(userAgent);
}

/** The address /go/ links start with, or null when counting is off or the address isn't known yet. */
export function trackingBase(ctx: Ctx): string | null {
  if (ctx.settings.click_tracking === "off" || !ctx.settings.base_url) return null;
  return ctx.settings.base_url;
}

function carries(m: OutMessage, url: string): boolean {
  if (m.kind === "buttons") return m.buttons.some((b) => b.type === "web_url" && b.url === url);
  return m.text.split("\n").some((line) => line === url);
}

function swap(m: OutMessage, go: Map<string, string>): OutMessage {
  if (m.kind === "buttons") {
    return { ...m, buttons: m.buttons.map((b) => (b.type === "web_url" && go.has(b.url) ? { ...b, url: go.get(b.url)! } : b)) };
  }
  return { kind: "text", text: m.text.split("\n").map((line) => go.get(line) ?? line).join("\n") };
}

/**
 * The /go/ ids for some of a campaign's links, by link index. For a conversation,
 * the same id every time; without one (a test lead), a fresh id that leads to the
 * link and counts nowhere.
 */
async function goIds(ctx: Ctx, conversationId: number | null, campaignId: number, links: Array<{ url: string; index: number }>): Promise<Array<string | undefined>> {
  const rows = await ctx.db.batch<{ id: string }>(
    links.map((l) =>
      ctx.db
        .prepare(
          `INSERT INTO tracked_links (id, conversation_id, campaign_id, link_index, url, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (conversation_id, link_index) DO UPDATE SET url = excluded.url RETURNING id`,
        )
        .bind(randomToken(12), conversationId, campaignId, l.index, l.url, ctx.now()),
    ),
  );
  return links.map((_, i) => rows[i]?.results[0]?.id);
}

/**
 * Puts the campaign's links in a message behind /go/ links, the same id for the
 * same conversation and link every time it is sent. Links are buttons or lines of
 * their own in the text (see linkMessage), so only those are replaced.
 */
export async function trackLinks(ctx: Ctx, conversationId: number, campaign: Pick<Campaign, "id" | "links">, message: OutMessage): Promise<OutMessage> {
  const base = trackingBase(ctx);
  if (!base) return message;
  const used = campaign.links.map((l, index) => ({ url: l.url, index })).filter((l) => carries(message, l.url));
  if (!used.length) return message;
  const ids = await goIds(ctx, conversationId, campaign.id, used);
  const go = new Map<string, string>();
  used.forEach((l, i) => {
    const id = ids[i];
    if (id && !go.has(l.url)) go.set(l.url, `${base}/go/${id}`);
  });
  return swap(message, go);
}

/**
 * The campaign's first link as the DM sends it to this person: their own /go/
 * link when clicks are counted, so a click from elsewhere (the email the lead
 * webhook leads to) counts like one from the DM; otherwise the link itself. It is
 * the same /go/ link the DM carries, or will carry once sent. Null without a link.
 */
export async function personalLink(ctx: Ctx, conversationId: number | null, campaign: Pick<Campaign, "id" | "links">): Promise<string | null> {
  const first = campaign.links[0];
  if (!first) return null;
  const base = trackingBase(ctx);
  if (!base || !campaign.id) return first.url;
  const [id] = await goIds(ctx, conversationId, campaign.id, [{ url: first.url, index: 0 }]);
  return id ? `${base}/go/${id}` : first.url;
}

/**
 * /go/<id>: a 302 to the real link. A person's first click on it is recorded;
 * HEAD requests and link previews are sent on without counting.
 */
export async function followLink(ctx: Ctx, request: Request, id: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  // With counting off, links already sent still lead where they did, and count nothing.
  const counts = request.method === "GET" && ctx.settings.click_tracking !== "off" && !isPreviewFetch(request.headers.get("user-agent"));
  const now = ctx.now();
  let row: { url: string } | null;
  if (counts) {
    const clicked = await ctx.db
      .prepare("UPDATE tracked_links SET first_clicked_at = COALESCE(first_clicked_at, ?) WHERE id = ? RETURNING url, conversation_id, link_index, first_clicked_at")
      .bind(now, id)
      .first<{ url: string; conversation_id: number | null; link_index: number; first_clicked_at: number }>();
    if (clicked && clicked.first_clicked_at === now && clicked.conversation_id !== null) {
      // The first click on this link goes in the activity log, under the person it was sent to.
      await ctx.db
        .prepare(
          `INSERT INTO activity (at, kind, outcome, reason, campaign_id, ig_user_id, username)
           SELECT ?, 'click', 'received', ?, campaign_id, ig_user_id, username FROM conversations WHERE id = ?`,
        )
        .bind(now, `first click on link ${clicked.link_index + 1}`, clicked.conversation_id)
        .run();
    }
    row = clicked;
  } else {
    row = await ctx.db.prepare("SELECT url FROM tracked_links WHERE id = ?").bind(id).first<{ url: string }>();
  }
  if (!row) return linkGone();
  return new Response(null, {
    status: 302,
    headers: { location: row.url, "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" },
  });
}

function linkGone(): Response {
  const res = page(
    "Link not found",
    html`<h1>This link doesn't work anymore</h1><p>Ask the account that sent it to send it again.</p>`,
  );
  return new Response(res.body, { status: 404, headers: res.headers });
}
