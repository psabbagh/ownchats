import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MetaError } from "../src/meta/client";
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
