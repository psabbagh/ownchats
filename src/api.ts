import { apiAuthorized } from "./auth";
import { getCampaign, listCampaigns, onAllPosts, saveCampaign, type Campaign } from "./campaigns";
import { log, type Ctx } from "./context";
import { listLeads } from "./export";
import { webhookConfig } from "./leadwebhook";
import { campaignFromRequest, checkCaption, waitingWithVideoId, type NewCampaignRequest } from "./newcampaign";
import { attachmentOf, campaignWarnings } from "./readiness";
import { listPosts, readMediaStats, type MediaStats } from "./insights";
import { campaignCounts, listActivity } from "./stats";
import { iso } from "./time";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Instagram's lifetime numbers for a campaign's post, as last read; null until read. */
function postJson(m: MediaStats | undefined) {
  if (!m?.updatedAt) return null;
  return {
    views: m.views ?? null,
    reach: m.reach ?? null,
    likes: m.likes ?? null,
    comments: m.comments ?? null,
    shares: m.shares ?? null,
    saves: m.saved ?? null,
    updated_at: iso(m.updatedAt),
  };
}

function campaignJson(c: Campaign, leadWebhookOn: boolean) {
  return {
    id: c.id,
    name: c.name,
    video_id: c.videoId || null,
    keywords: c.keywords,
    any_comment: c.anyComment,
    media_id: c.mediaId,
    media_label: c.mediaLabel,
    all_posts: onAllPosts(c),
    waits_for_next_post: c.nextPostAfter !== null,
    email_mode: c.emailMode,
    email_tag: c.emailTag || null,
    opening_button: c.openingButton || null,
    links: c.links,
    link_title: c.linkTitle || null,
    follow_check: c.followCheck,
    dm_keyword: c.dmKeyword,
    active: c.active,
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
    attachment: attachmentOf(c),
    waiting_since: c.nextPostAfter !== null ? iso(c.nextPostAfter) : null,
    asks_for_email: c.emailMode !== "none",
    has_link: c.links.length > 0,
    has_link_title: !!c.linkTitle,
    warnings: campaignWarnings(c, leadWebhookOn),
  };
}

function parseSince(v: string | null): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * Read-only JSON for integrations (a knowledge base, a newsletter sync, a script).
 * Every request needs `Authorization: Bearer <token>` from Settings.
 */
/** Requests bigger than this are refused before parsing: a campaign is a few kilobytes. */
const MAX_BODY = 32 * 1024;

async function readBody(request: Request): Promise<Record<string, unknown> | string> {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return "The request body is too large.";
  try {
    const body = JSON.parse(raw) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : "Send a JSON object.";
  } catch {
    return "Send a JSON object, with Content-Type: application/json.";
  }
}

/**
 * The write side: POST /api/campaigns creates a campaign that waits for the next
 * post, from that post's caption; POST /api/campaigns/check says whether a caption
 * would attach a campaign, and saves nothing. Creating needs the write token;
 * checking takes either token, since it shows nothing the read token can't.
 */
async function handleWrite(ctx: Ctx, request: Request, path: string): Promise<Response> {
  if (path !== "/api/campaigns" && path !== "/api/campaigns/check") {
    return json({ error: "Only POST /api/campaigns and POST /api/campaigns/check take a POST. GET /api lists the rest." }, 405);
  }
  const write = await apiAuthorized(ctx, request, "write");
  if (!write && !(path === "/api/campaigns/check" && (await apiAuthorized(ctx, request, "read")))) {
    return json({ error: "Send Authorization: Bearer <write token>. Create one in the dashboard under Settings, API write token." }, 401);
  }
  const body = await readBody(request);
  if (typeof body === "string") return json({ error: body }, 400);

  if (path === "/api/campaigns/check") {
    const caption = typeof body.caption === "string" ? body.caption : "";
    if (!caption.trim()) return json({ error: "Send the post's caption as `caption`." }, 400);
    const given = Array.isArray(body.keywords) ? body.keywords.filter((k): k is string => typeof k === "string") : null;
    if (body.campaign_id !== undefined) {
      const c = await getCampaign(ctx.db, Number(body.campaign_id));
      if (!c) return json({ error: "No campaign with that id." }, 404);
      return json({ campaign_id: c.id, keywords: c.keywords, ...(await checkCaption(ctx, caption, c.keywords, c.id)) });
    }
    const keywords = given ?? [];
    return json({ keywords, ...(await checkCaption(ctx, caption, keywords)) });
  }

  const { input, caption, errors } = campaignFromRequest(ctx, body as NewCampaignRequest);
  if (!input) return json({ error: errors.join(" "), errors }, 422);
  const check = await checkCaption(ctx, caption, input.keywords);
  const campaigns = await listCampaigns(ctx.db);
  const same = waitingWithVideoId(campaigns, input.videoId);
  if (same) {
    return json({ error: `Campaign ${same.id} (${same.name}) already waits for the next post with video id ${input.videoId}. Edit it in the dashboard instead.`, campaign_id: same.id }, 409);
  }
  if (check.waiting_campaigns_it_would_attach.length) {
    const names = check.waiting_campaigns_it_would_attach.map((c) => `${c.id} (${c.name})`).join(", ");
    return json(
      { error: `This caption would also attach campaign ${names}, which waits already, so the new one would answer nobody. Use another keyword, or edit that campaign.`, check },
      409,
    );
  }
  const leadWebhookOn = !!webhookConfig(ctx);
  const preview = { ...input, id: 0, replyCursor: -1, createdAt: ctx.now(), updatedAt: ctx.now() };
  if (body.dry_run === true) {
    return json({ dry_run: true, campaign: { ...campaignJson(preview, leadWebhookOn), id: null }, check });
  }
  const id = await saveCampaign(ctx.db, input, null, ctx.now());
  await log(ctx, { kind: "api", outcome: "saved", reason: `Campaign created through the API, waiting for the next post`, campaignId: id });
  const saved = (await getCampaign(ctx.db, id))!;
  return json({ campaign: campaignJson(saved, leadWebhookOn), check }, 201);
}

export async function handleApi(ctx: Ctx, request: Request, url: URL): Promise<Response> {
  if (request.method === "POST") return handleWrite(ctx, request, url.pathname.replace(/\/+$/, ""));
  if (request.method !== "GET") return json({ error: "Use GET, or POST to create a campaign." }, 405);
  if (!(await apiAuthorized(ctx, request))) {
    return json({ error: "Send Authorization: Bearer <token>. Create a token in the dashboard under Settings." }, 401);
  }
  const path = url.pathname.replace(/\/+$/, "");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);

  if (path === "/api") {
    return json({
      endpoints: {
        "GET /api/campaigns": "campaigns with their counts (clicks: people who clicked a link; failed split into failedDms, refusedPublicReplies, failedLeadWebhooks), their post's views, and what would stop them working (warnings)",
        "GET /api/leads?campaign_id=&since=ISO-8601&limit=": "emails collected, newest first",
        "GET /api/activity?campaign_id=&outcome=sent|skipped|failed&limit=": "what happened and why, newest first",
        "GET /api/posts?since=ISO-8601&limit=": "the account's posts from the last 90 days with Instagram's numbers, newest first",
        "GET /api/account": "follower, following and post counts",
        "GET /api/stats": "totals and connection health",
        "POST /api/campaigns": "write token: create a campaign that waits for the next post, from its caption (dry_run: true saves nothing)",
        "POST /api/campaigns/check": "either token: whether a caption would attach a campaign with these keywords (or campaign_id), and what else it would touch",
      },
    });
  }
  if (path === "/api/campaigns") {
    const counts = await campaignCounts(ctx);
    const campaigns = await listCampaigns(ctx.db);
    const stats = await readMediaStats(ctx, campaigns.flatMap((c) => (c.mediaId ? [c.mediaId] : [])));
    return json({
      campaigns: campaigns.map((c) => ({ ...campaignJson(c, !!webhookConfig(ctx)), counts: counts.get(c.id) ?? null, post: postJson(c.mediaId ? stats.get(c.mediaId) : undefined) })),
    });
  }
  if (path === "/api/leads") {
    const leads = await listLeads(ctx, {
      campaignId: Number(url.searchParams.get("campaign_id")) || undefined,
      since: parseSince(url.searchParams.get("since")),
      limit,
    });
    return json({
      leads: leads.map((l) => ({
        id: l.id,
        email: l.email,
        instagram_username: l.username,
        campaign_id: l.campaign_id,
        campaign: l.campaign_name,
        consented_at: iso(l.consented_at),
        consent_text: l.consent_text,
      })),
    });
  }
  if (path === "/api/activity") {
    const rows = await listActivity(ctx, {
      limit,
      campaignId: Number(url.searchParams.get("campaign_id")) || undefined,
      outcome: url.searchParams.get("outcome") ?? undefined,
    });
    return json({
      activity: rows.map((r) => ({
        at: iso(r.at),
        kind: r.kind,
        outcome: r.outcome,
        reason: r.reason,
        campaign_id: r.campaign_id,
        instagram_username: r.username,
        comment_id: r.comment_id,
      })),
    });
  }
  if (path === "/api/posts") {
    const posts = await listPosts(ctx, { since: parseSince(url.searchParams.get("since")), limit });
    const byPost = new Map<string, number[]>();
    for (const c of await listCampaigns(ctx.db)) if (c.mediaId) byPost.set(c.mediaId, [...(byPost.get(c.mediaId) ?? []), c.id]);
    return json({
      posts: posts.map((p) => ({
        id: p.mediaId,
        caption: p.caption,
        permalink: p.permalink,
        posted_at: iso(p.postedAt ?? 0) || null,
        media_type: p.mediaType,
        thumbnail_url: p.thumbnailUrl,
        views: p.views ?? null,
        reach: p.reach ?? null,
        likes: p.likes ?? null,
        comments: p.comments ?? null,
        shares: p.shares ?? null,
        saves: p.saved ?? null,
        numbers_updated_at: p.updatedAt ? iso(p.updatedAt) : null,
        numbers_problem: p.problem,
        campaign_ids: byPost.get(p.mediaId) ?? [],
      })),
    });
  }
  if (path === "/api/account") {
    const s = ctx.settings;
    const count = (v: string | undefined) => (v === undefined || v === "" ? null : Number(v));
    return json({
      instagram_username: s.ig_username ?? null,
      followers: count(s.followers_count),
      follows: count(s.follows_count),
      media_count: count(s.media_count),
      updated_at: Number(s.account_stats_at) ? iso(Number(s.account_stats_at)) : null,
      problem: s.account_problem || null,
    });
  }
  if (path === "/api/stats") {
    const counts = [...(await campaignCounts(ctx)).values()];
    const total = (k: "people" | "dmsSent" | "taps" | "emails" | "linksSent" | "clicks") => counts.reduce((n, c) => n + c[k], 0);
    const s = ctx.settings;
    return json({
      totals: {
        people: total("people"),
        dms_sent: total("dmsSent"),
        taps: total("taps"),
        emails: total("emails"),
        links_sent: total("linksSent"),
        clicks: total("clicks"),
      },
      health: {
        instagram_connected: !!(s.access_token && s.ig_user_id),
        instagram_username: s.ig_username ?? null,
        last_webhook_at: iso(Number(s.last_webhook_at)) || null,
        last_poll_at: iso(Number(s.last_poll_at)) || null,
        token_expires_at: Number(s.token_expires_at) ? iso(Number(s.token_expires_at)) : null,
        token_problem: s.token_problem || null,
        lead_webhook_configured: !!webhookConfig(ctx),
      },
    });
  }
  return json({ error: "Unknown endpoint. GET /api lists them." }, 404);
}
