import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MetaError } from "../src/meta/client";
import { captionKeywords } from "../src/newcampaign";
import { saveSettings } from "../src/settings";
import { BASE, FAN, FAN2, setupWorld, WEBHOOK_SECRET } from "./helpers";

// Everything here is invented: ids, names, links.
type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;
let cookie: string;
let auth: { headers: { authorization: string } };

beforeEach(async () => {
  w = await setupWorld();
  cookie = await w.signIn();
  const page = await (await w.fetch("/dashboard/settings/api-token", form({ do: "new" }))).text();
  auth = { headers: { authorization: `Bearer ${page.match(/oc_[A-Za-z0-9_-]+/)![0]}` } };
});

function form(data: Record<string, string>): RequestInit {
  return { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) };
}

async function apiCampaigns(): Promise<Array<Record<string, any>>> {
  return ((await (await w.fetch("/api/campaigns", auth)).json()) as { campaigns: Array<Record<string, any>> }).campaigns;
}

const NEW = { name: "SEO guide", keywords: "SEO", media_id: "all", link_text: "Here:", link_url_0: "https://example.com/seo", email_mode: "none", active: "on" };

describe("video id", () => {
  it("is set on the campaign form, shown on the edit page and served by the API", async () => {
    const res = await w.fetch("/dashboard/campaigns/new", form({ ...NEW, video_id: "SF-14" }));
    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT video_id FROM campaigns").first()).toEqual({ video_id: "SF-14" });
    const edit = await (await w.fetch(`${res.headers.get("location")}/edit`, { headers: { cookie } })).text();
    expect(edit).toContain('name="video_id" type="text" value="SF-14"');
    expect((await apiCampaigns())[0]).toMatchObject({ name: "SEO guide", video_id: "SF-14" });
  });

  it("is null in the API when empty, as on campaigns made before it existed", async () => {
    await w.campaign();
    expect((await apiCampaigns())[0]!.video_id).toBeNull();
  });

  it("refuses an id with spaces or other characters", async () => {
    const res = await w.fetch("/dashboard/campaigns/new", form({ ...NEW, video_id: "SF 14!" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The video id can use letters, digits");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first()).toEqual({ n: 0 });
  });
});

describe("what the hub checks before a video goes up", () => {
  it("says where each campaign listens, and since when a waiting one waits", async () => {
    await w.campaign({ name: "One post" });
    await w.campaign({ name: "All posts", mediaId: null, mediaLabel: null });
    await w.campaign({ name: "Next post", mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() });
    const [one, all, next] = await apiCampaigns();
    expect(one).toMatchObject({ attachment: "post", waiting_since: null, waits_for_next_post: false });
    expect(all).toMatchObject({ attachment: "all_posts", waiting_since: null, all_posts: true });
    expect(next).toMatchObject({ attachment: "next_post", waiting_since: "2026-11-04T12:00:00.000Z", waits_for_next_post: true });
  });

  it("says whether a link, its title and an email ask are set, and keeps every earlier field", async () => {
    await w.campaign({ linkTitle: "The library", emailMode: "optional", emailTag: "guideRequested" });
    const c = (await apiCampaigns())[0]!;
    expect(c).toMatchObject({ has_link: true, has_link_title: true, asks_for_email: true, email_tag: "guideRequested", link_title: "The library" });
    for (const k of ["id", "name", "keywords", "any_comment", "media_id", "media_label", "all_posts", "waits_for_next_post", "email_mode", "links", "follow_check", "dm_keyword", "active", "counts", "post"]) {
      expect(c, k).toHaveProperty(k);
    }
  });

  it("warns about the set-ups that fail silently: no email ask, no tag, no title, no lead webhook", async () => {
    await w.campaign({ name: "Tag, no ask", emailTag: "guideRequested" });
    await w.campaign({ name: "Ask, nothing else", emailMode: "optional" });
    await w.campaign({ name: "Off", active: false });
    await w.campaign({ name: "Ready", emailMode: "optional", emailTag: "guideRequested", linkTitle: "The library" });
    const codes = async () => (await apiCampaigns()).map((c) => c.warnings.map((x: { code: string }) => x.code));
    expect(await codes()).toEqual([
      ["email_tag_without_email_ask"],
      ["email_ask_without_tag", "email_ask_without_link_title", "email_ask_without_lead_webhook"],
      ["off"],
      ["email_ask_without_lead_webhook"],
    ]);
    await saveSettings(env.DB, env.ADMIN_PASSWORD, { lead_webhook_url: "https://hooks.example.com/ownchats", lead_webhook_secret: WEBHOOK_SECRET });
    expect((await codes())[3]).toEqual([]);
    const stats = (await (await w.fetch("/api/stats", auth)).json()) as { health: { lead_webhook_configured: boolean } };
    expect(stats.health.lead_webhook_configured).toBe(true);
  });

  it("splits failures into DMs that didn't go out and public replies refused after the DM", async () => {
    const id = await w.campaign();
    w.meta.failNext("replyToComment", new MetaError("Unsupported post request", 400, 100, 33));
    await w.sendComment(w.comment("agents", FAN));
    w.meta.failNext("sendPrivateReply", new MetaError("Unsupported post request", 400, 100, 33));
    await w.sendComment(w.comment("agents", FAN2));
    const c = (await apiCampaigns()).find((x) => x.id === id)!;
    expect(c.counts).toMatchObject({ failed: 2, failedDms: 1, refusedPublicReplies: 1, failedLeadWebhooks: 0, dmsSent: 1 });
  });
});

describe("captionKeywords", () => {
  it("reads the keyword a caption asks for, as written", () => {
    expect(captionKeywords("Check your SEO with Claude.\n\nComment SEO and I'll send the guide")).toEqual(["SEO"]);
    expect(captionKeywords("Comment SET UP below 👇")).toEqual(["SET UP"]);
    expect(captionKeywords("Comment SET-UP")).toEqual(["SET-UP"]);
    expect(captionKeywords("comment 'set up' for the list")).toEqual(["set up"]);
    expect(captionKeywords("Comment the word “AGENTS” 🙌")).toEqual(["AGENTS"]);
    expect(captionKeywords("comment agents for the list")).toEqual(["agents"]);
    expect(captionKeywords("Comment: TRAFFIC. Or comment SEO")).toEqual(["TRAFFIC", "SEO"]);
  });

  it("finds nothing in a caption that only mentions a word, or puts an emoji before a plain word", () => {
    expect(captionKeywords("My agents bring the traffic")).toEqual([]);
    expect(captionKeywords("Comment 🙌 and I'll send it")).toEqual([]);
    expect(captionKeywords("Thanks for every comment!")).toEqual([]);
  });
});

describe("POST /api/campaigns", () => {
  let write: { authorization: string; "content-type": string };
  const CAPTION = "Check your website's SEO with Claude.\n\nComment SEO and I'll send you the guide.";
  const BODY = { caption: CAPTION, spellings: ["SEOO", "S E O", "🙌"], link: "https://example.com/guides/seo", link_title: "Check your website's SEO with Claude", email_tag: "guideRequested", video_id: "SF-15" };

  beforeEach(async () => {
    const page = await (await w.fetch("/dashboard/settings/api-write-token", form({ do: "new" }))).text();
    write = { authorization: `Bearer ${page.match(/ocw_[A-Za-z0-9_-]+/)![0]}`, "content-type": "application/json" };
  });
  const create = (body: unknown, headers: Record<string, string> = write) => w.fetch("/api/campaigns", { method: "POST", headers, body: JSON.stringify(body) });
  const check = (body: unknown, headers: Record<string, string> = write) => w.fetch("/api/campaigns/check", { method: "POST", headers, body: JSON.stringify(body) });

  it("creates a campaign waiting for the next post, with the keyword read from the caption", async () => {
    const res = await create(BODY);
    expect(res.status).toBe(201);
    const { campaign, check: c } = (await res.json()) as { campaign: Record<string, any>; check: Record<string, any> };
    expect(campaign).toMatchObject({
      name: "Check your website's SEO with Claude (SF-15)",
      video_id: "SF-15",
      keywords: ["SEO", "SEOO", "S E O", "🙌"],
      attachment: "next_post",
      waiting_since: "2026-11-04T12:00:00.000Z",
      email_mode: "optional",
      email_tag: "guideRequested",
      opening_button: "Send me the link",
      links: [{ url: "https://example.com/guides/seo", label: "Open" }],
      link_title: "Check your website's SEO with Claude",
      active: true,
      dm_keyword: false,
      follow_check: false,
      warnings: [{ code: "email_ask_without_lead_webhook", message: expect.any(String) }],
    });
    expect(c).toMatchObject({ caption_keywords: ["SEO"], attaches: true, matched_keyword: "SEO", waiting_campaigns_it_would_attach: [], posts_already_up: [] });
    expect((await apiCampaigns())[0]).toMatchObject({ id: campaign.id, attachment: "next_post" });
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "api", outcome: "saved" });
  });

  it("attaches to the post with that caption once it goes up", async () => {
    const { campaign } = (await (await create(BODY)).json()) as { campaign: { id: number } };
    w.clock.advance(60_000);
    w.meta.media = [{ id: "18000000000000030", caption: CAPTION, permalink: "https://www.instagram.com/reel/18000000000000030/", timestamp: w.clock.now(), mediaType: "VIDEO" }];
    await w.cron();
    expect(await env.DB.prepare("SELECT media_id, next_post_after FROM campaigns WHERE id = ?").bind(campaign.id).first()).toEqual({ media_id: "18000000000000030", next_post_after: null });
  });

  it("refuses a keyword the caption doesn't ask for, so the two can't differ", async () => {
    const res = await create({ ...BODY, keyword: "SEOGUIDE" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain('doesn\'t ask people to comment "SEOGUIDE"; it asks for "SEO"');
    const none = await create({ ...BODY, caption: "Check your SEO with Claude" });
    expect(((await none.json()) as { error: string }).error).toContain('Add a line such as "Comment SEO"');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first()).toEqual({ n: 0 });
  });

  it("asks which keyword when the caption asks for several", async () => {
    const res = await create({ ...BODY, caption: "Comment SEO or comment AUDIT" });
    expect(res.status).toBe(422);
    expect((await create({ ...BODY, caption: "Comment SEO or comment AUDIT", keyword: "AUDIT" })).status).toBe(201);
  });

  it("saves nothing on a dry run", async () => {
    const res = await create({ ...BODY, dry_run: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dry_run: true, campaign: { id: null, keywords: ["SEO", "SEOO", "S E O", "🙌"] }, check: { attaches: true } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM campaigns").first()).toEqual({ n: 0 });
  });

  it("leaves the email ask out when no email tag is given", async () => {
    const { campaign } = (await (await create({ caption: CAPTION, link: "https://example.com/g" })).json()) as { campaign: Record<string, any> };
    expect(campaign).toMatchObject({ name: "SEO", email_mode: "none", email_tag: null, asks_for_email: false, video_id: null });
  });

  it("refuses a second waiting campaign for the same video, or one the same caption would also attach", async () => {
    expect((await create(BODY)).status).toBe(201);
    const again = await create(BODY);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ campaign_id: expect.any(Number) });
    const clash = await create({ ...BODY, video_id: "SF-16" });
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: string }).error).toContain("would also attach campaign");
  });

  it("needs the write token: the read token can't create, and the write token can't read", async () => {
    expect((await create(BODY, { ...auth.headers, "content-type": "application/json" })).status).toBe(401);
    expect((await create(BODY, { "content-type": "application/json" })).status).toBe(401);
    expect((await w.fetch("/api/campaigns", { headers: { authorization: write.authorization } })).status).toBe(401);
    expect((await w.fetch("/api/leads", { method: "POST", headers: write, body: "{}" })).status).toBe(405);
    await w.fetch("/dashboard/settings/api-write-token", form({ do: "revoke" }));
    expect((await create(BODY)).status).toBe(401);
  });

  it("refuses a body that isn't a JSON object, or a bad field, in plain words", async () => {
    expect((await w.fetch("/api/campaigns", { method: "POST", headers: write, body: "not json" })).status).toBe(400);
    const res = await create({ ...BODY, spellings: "SEOO", link: "example.com" });
    expect(res.status).toBe(422);
    const { errors } = (await res.json()) as { errors: string[] };
    expect(errors).toContain("`spellings` must be a list of strings.");
  });

  describe("check", () => {
    it("says whether a caption attaches a campaign with these keywords, with either token", async () => {
      expect(await (await check({ caption: CAPTION, keywords: ["SEO", "SEOO"] })).json()).toMatchObject({ attaches: true, matched_keyword: "SEO", caption_keywords: ["SEO"] });
      const read = await check({ caption: "Comment SE0 for the guide", keywords: ["SEO"] }, { ...auth.headers, "content-type": "application/json" });
      expect(await read.json()).toMatchObject({ attaches: false, matched_keyword: null, caption_keywords: ["SE0"] });
    });

    it("checks a caption against an existing campaign, and names a post that is already up", async () => {
      const id = await w.campaign({ name: "Waiting", keywords: ["SEO"], mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() });
      const other = await check({ caption: CAPTION, keywords: ["AUDIT"] });
      expect(await other.json()).toMatchObject({ attaches: false, waiting_campaigns_it_would_attach: [{ id, name: "Waiting", video_id: null }] });
      expect(await (await check({ caption: CAPTION, campaign_id: id })).json()).toMatchObject({ campaign_id: id, attaches: true, waiting_campaigns_it_would_attach: [] });

      await saveSettings(env.DB, env.ADMIN_PASSWORD, {
        media_cache: JSON.stringify([{ id: "18000000000000031", caption: CAPTION, permalink: "https://www.instagram.com/reel/18000000000000031/", timestamp: w.clock.now() - 60_000, mediaType: "VIDEO" }]),
      });
      expect(await (await check({ caption: CAPTION, keywords: ["SEO"] })).json()).toMatchObject({ posts_already_up: [{ id: "18000000000000031" }] });
    });
  });
});
