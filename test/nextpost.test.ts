import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { listCampaigns } from "../src/campaigns";
import { captionAsksFor } from "../src/match";
import { MetaError, type Media } from "../src/meta/client";
import { missedComments } from "../src/missed";
import { DAY, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, OTHER_POST, OWNER, REEL, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

// Invented posts.
const NEW_POST = "18000000000000010";
const NEWER_POST = "18000000000000011";
const OLD_POST = "18000000000000009";
const media = (id: string, timestamp: number, caption = "An invented reel. Comment AGENTS and I'll send the list"): Media => ({
  id,
  caption,
  permalink: `https://www.instagram.com/reel/${id}/`,
  timestamp,
  mediaType: "VIDEO",
  thumbnailUrl: `https://example.com/thumbs/${id}.jpg`,
});

const post = (cookie: string, path: string, data: Record<string, string>) =>
  w.fetch(path, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });
const campaignRow = (id: number) =>
  env.DB.prepare("SELECT media_id, media_label, next_post_after FROM campaigns WHERE id = ?").bind(id).first<{
    media_id: string | null;
    media_label: string | null;
    next_post_after: number | null;
  }>();
const status = (id: string) => env.DB.prepare("SELECT status, reason FROM comments WHERE id = ?").bind(id).first();
const privateReplies = () => w.meta.sent.filter((s) => s.kind === "private_reply");
const metaCalls = (method: string) => w.meta.calls.filter((c) => c === method).length;

/** A campaign that started waiting for the next post `ago` ms before now. */
const waiting = (ago = 10 * MINUTE, overrides = {}) => w.campaign({ mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() - ago, ...overrides });

const fields = {
  name: "Agents library",
  keywords: "AGENTS",
  link_text: "Here you go:",
  link_url_0: "https://example.com/library",
  link_label_0: "Open",
  active: "on",
};

describe("a caption that asks for the keyword", () => {
  it("is \"comment\" then the keyword, with only punctuation, spaces or emoji between", () => {
    for (const caption of ["Comment AGENTS", "comment 'agents' 👇", "Comment: AGENTS and I'll DM you", "COMMENT “AGENTS”!", "Want it? Comment agents.", "Commente AGENTS", "Comment 👇👇 AGENTS", "Comment the word AGENTS", 'comment word "agents"']) {
      expect(captionAsksFor(caption, ["AGENTS"]), caption).toBe(true);
    }
    expect(captionAsksFor("Comment SET-UP for the checklist", ["SETUP", "SET UP"])).toBe(true);
    for (const caption of ["My agents bring traffic. Comment TRAFFIC", "comment below if you use agents", "Comment AGENTSMITH", "agents", "", "Comment your favourite AGENTS", "Comment the wordAGENTS"]) {
      expect(captionAsksFor(caption, ["AGENTS"]), caption).toBe(false);
    }
  });
});

describe("a campaign on the next post", () => {
  it("is chosen in the form, and keeps the time it started waiting when saved again", async () => {
    const cookie = await w.signIn();
    const form = await (await w.fetch("/dashboard/campaigns/new", { headers: { cookie } })).text();
    expect(form).toContain('value="next"');
    expect(form).toContain("The next post you publish");

    expect((await post(cookie, "/dashboard/campaigns/new", { ...fields, media_id: "next", any_comment: "on" })).status).toBe(303);
    const [c] = await listCampaigns(env.DB);
    expect(c).toMatchObject({ mediaId: null, nextPostAfter: w.clock.now(), anyComment: true });
    const since = w.clock.now();

    w.clock.advance(5 * MINUTE);
    const edit = await (await w.fetch(`/dashboard/campaigns/${c!.id}/edit`, { headers: { cookie } })).text();
    expect(edit).toMatch(/value="next" checked/);
    expect(edit).toContain("waiting since");
    expect((await post(cookie, `/dashboard/campaigns/${c!.id}`, { ...fields, media_id: "next", name: "Renamed" })).status).toBe(303);
    expect(await campaignRow(c!.id)).toEqual({ media_id: null, media_label: null, next_post_after: since });

    // Picking a post instead stops the wait.
    expect((await post(cookie, `/dashboard/campaigns/${c!.id}`, { ...fields, media_id: REEL, media_label: "Test reel" })).status).toBe(303);
    expect(await campaignRow(c!.id)).toEqual({ media_id: REEL, media_label: "Test reel", next_post_after: null });
  });

  it("answers no comment while it waits, on any post", async () => {
    const id = await waiting();
    await w.sendComment(w.comment("AGENTS please", FAN, { media: OTHER_POST }));
    expect(privateReplies()).toHaveLength(0);
    const [c] = await listCampaigns(env.DB);
    expect(c!.id).toBe(id);
    // Not a missed comment either: the campaign has no post yet.
    expect((await missedComments(await w.ctx(), [c!])).get(id)).toBeUndefined();
    // And the poll doesn't watch every post for it.
    await w.cron();
    expect(metaCalls("listComments")).toBe(0);
  });

  it("attaches to the first post published after it started waiting", async () => {
    const id = await waiting(10 * MINUTE);
    const now = w.clock.now();
    w.meta.media = [media(NEWER_POST, now - MINUTE), media(NEW_POST, now - 5 * MINUTE, "Five agents\nthat run my week. Comment AGENTS"), media(OLD_POST, now - 2 * DAY)];
    await w.cron();
    expect(await campaignRow(id)).toEqual({ media_id: NEW_POST, media_label: "Five agents that run my week. Comment AGENTS", next_post_after: null });
    // The post is listed at once, so the API and the numbers don't wait for the hourly listing.
    const listed = await env.DB.prepare("SELECT posted_at, caption FROM media_stats WHERE media_id = ?").bind(NEW_POST).first();
    expect(listed).toEqual({ posted_at: now - 5 * MINUTE, caption: "Five agents\nthat run my week. Comment AGENTS" });

    const cookie = await w.signIn();
    const home = await (await w.fetch("/dashboard", { headers: { cookie } })).text();
    expect(home).toContain("on Five agents that run my week");
  });

  it("takes the post whose caption asks for its keyword, so two can wait at once", async () => {
    const agents = await waiting();
    const memory = await waiting(10 * MINUTE, { name: "Memory guide", keywords: ["MEMORY"] });
    const now = w.clock.now();
    // A Reel that mentions agents in passing, posted first, belongs to neither.
    w.meta.media = [media("18000000000000020", now - 3 * MINUTE, "My agents bring the traffic. Comment TRAFFIC for the playbook")];
    await w.cron();
    expect((await campaignRow(agents))!.next_post_after).not.toBeNull();
    expect((await campaignRow(memory))!.next_post_after).not.toBeNull();

    w.clock.advance(MINUTE);
    w.meta.media = [media("18000000000000021", w.clock.now(), "How my agents remember. Comment MEMORY 👇"), ...w.meta.media];
    await w.cron();
    expect(await campaignRow(memory)).toMatchObject({ media_id: "18000000000000021", next_post_after: null });
    expect((await campaignRow(agents))!.media_id).toBeNull();

    w.clock.advance(DAY);
    w.meta.media = [media("18000000000000022", w.clock.now(), "Five agents that run my week.\n\nComment “AGENTS” and I'll send them"), ...w.meta.media];
    await w.cron();
    expect(await campaignRow(agents)).toMatchObject({ media_id: "18000000000000022", next_post_after: null });
  });

  it("reuses a keyword from an old Reel without touching the old campaign", async () => {
    const old = await w.campaign({ mediaId: OLD_POST, links: [{ label: "Open", url: "https://example.com/old-list" }] });
    w.clock.advance(30 * DAY);
    const fresh = await waiting(10 * MINUTE, { links: [{ label: "Open", url: "https://example.com/new-list" }] });
    w.meta.media = [media(OLD_POST, w.clock.now() - 30 * DAY)];
    await w.cron();
    expect((await campaignRow(fresh))!.media_id).toBeNull();

    w.meta.media = [media(NEW_POST, w.clock.now()), ...w.meta.media];
    await w.cron();
    expect((await campaignRow(fresh))!.media_id).toBe(NEW_POST);
    expect((await campaignRow(old))!.media_id).toBe(OLD_POST);

    // Each Reel's comments go to its own campaign, and someone who got the old list gets the new one too.
    const onOld = w.comment("AGENTS", FAN, { media: OLD_POST });
    await w.sendComment(onOld);
    const onNew = w.comment("agents please", FAN, { media: NEW_POST });
    await w.sendComment(onNew);
    const campaignOf = async (commentId: string) =>
      (await env.DB.prepare("SELECT campaign_id FROM comments WHERE id = ?").bind(commentId).first<{ campaign_id: number }>())!.campaign_id;
    expect(await campaignOf(onOld.id)).toBe(old);
    expect(await campaignOf(onNew.id)).toBe(fresh);
    expect(privateReplies().map((s) => s.to)).toEqual([onOld.id, onNew.id]);
  });

  it("with any comment, takes the first new post whatever its caption", async () => {
    const id = await waiting(10 * MINUTE, { anyComment: true, keywords: [] });
    w.meta.media = [media(NEW_POST, w.clock.now(), "No call to action here")];
    await w.cron();
    expect((await campaignRow(id))!.media_id).toBe(NEW_POST);
  });

  it("keeps waiting while there is no new post, and only reads the post list while a campaign waits", async () => {
    await w.campaign();
    await w.cron();
    expect(metaCalls("listMedia")).toBe(0);

    const id = await waiting();
    w.meta.media = [media(OLD_POST, w.clock.now() - DAY)];
    await w.cron();
    expect(metaCalls("listMedia")).toBe(1);
    expect((await campaignRow(id))!.next_post_after).not.toBeNull();
    w.clock.advance(MINUTE);
    await w.cron();
    expect(metaCalls("listMedia")).toBe(2);
  });

  it("answers the comments that reached the post before it attached", async () => {
    const id = await waiting();
    w.meta.media = [media(NEW_POST, w.clock.now())];
    w.clock.advance(20_000);
    const early = w.comment("AGENTS please!", FAN, { media: NEW_POST });
    const chatter = w.comment("love this", FAN2, { media: NEW_POST });
    const own = w.comment("AGENTS link in bio", OWNER, { media: NEW_POST });
    for (const c of [early, chatter, own]) await w.sendComment(c);
    expect(await status(early.id)).toEqual({ status: "skipped", reason: "no matching campaign" });
    expect(privateReplies()).toHaveLength(0);

    w.clock.advance(30_000);
    await w.cron();
    expect((await campaignRow(id))!.media_id).toBe(NEW_POST);
    expect(privateReplies().map((s) => s.to)).toEqual([early.id]);
    expect(await status(early.id)).toMatchObject({ status: "done" });
    expect(await status(chatter.id)).toEqual({ status: "skipped", reason: "no matching campaign" });
    expect(await status(own.id)).toMatchObject({ status: "skipped" });

    // Later comments are answered on arrival, as on any one-post campaign.
    const later = w.comment("agents", FAN2, { media: NEW_POST });
    await w.sendComment(later);
    expect(privateReplies().map((s) => s.to)).toEqual([early.id, later.id]);
  });

  it("when off, attaches but answers nobody, and lists the early comments to check", async () => {
    const id = await waiting(10 * MINUTE, { active: false });
    w.meta.media = [media(NEW_POST, w.clock.now())];
    w.clock.advance(20_000);
    const early = w.comment("AGENTS please", FAN, { media: NEW_POST });
    await w.sendComment(early);
    await w.cron();
    expect((await campaignRow(id))!.media_id).toBe(NEW_POST);
    expect(privateReplies()).toHaveLength(0);
    const [c] = await listCampaigns(env.DB);
    expect((await missedComments(await w.ctx(), [c!])).get(id)?.map((m) => [m.id, m.why])).toEqual([[early.id, "matches"]]);
  });

  it("says on its page that it waits, and when a check fails", async () => {
    const id = await waiting();
    const cookie = await w.signIn();
    const pageText = async (path: string) => (await w.fetch(path, { headers: { cookie } })).text();
    expect(await pageText("/dashboard")).toContain("on your next post (waiting for it)");

    w.meta.failNext("listMedia", new MetaError("Service temporarily unavailable", 503, 2));
    await w.cron();
    let page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).toContain("Waiting for your next post.");
    expect(page).toContain("The last check failed");
    expect((await campaignRow(id))!.next_post_after).not.toBeNull();

    w.clock.advance(MINUTE);
    w.meta.media = [media(OLD_POST, w.clock.now() - DAY)];
    await w.cron();
    page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).not.toContain("The last check failed");
    expect(page).toContain("Last check:");

    const tokenPage = await (await post(cookie, "/dashboard/settings/api-token", { do: "new" })).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    const api = (await (await w.fetch("/api/campaigns", { headers: { authorization: `Bearer ${token}` } })).json()) as {
      campaigns: Array<Record<string, unknown>>;
    };
    expect(api.campaigns[0]).toMatchObject({ media_id: null, all_posts: false, waits_for_next_post: true });
  });
});
