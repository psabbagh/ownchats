import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metaDay, refreshMediaStatsSoon, STATS_EVERY } from "../src/insights";
import { cleanup } from "../src/cron";
import { MetaError } from "../src/meta/client";
import { accountDayWindow, GraphMetaClient } from "../src/meta/graph";
import { BASE, FAN, OTHER_POST, OWNER, REEL, setupWorld } from "./helpers";
import { DAY, HOUR, MINUTE } from "../src/time";
import { env } from "cloudflare:workers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

// Invented numbers.
const NUMBERS = { views: 12345, reach: 9000, likes: 800, comments: 120, shares: 40, saved: 300 };
const reads = () => w.meta.calls.filter((c) => c === "mediaInsights").length;
const NO_PERMISSION = new MetaError("(#10) Application does not have permission for this action", 400, 10);

async function pageText(path: string): Promise<string> {
  const cookie = await w.signIn();
  return (await w.fetch(path, { headers: { cookie } })).text();
}

describe("post numbers", () => {
  it("are read by the Cron and shown on the campaign, its home card and the API", async () => {
    const id = await w.campaign();
    w.meta.insights.set(REEL, { ...NUMBERS, views: 200 });
    await w.sendComment(w.comment("agents", FAN));
    await w.cron();
    expect(reads()).toBe(1);

    const page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).toContain("<b>200</b>views");
    expect(page).toContain("<b>9,000</b>reached");
    expect(page).toContain("<b>300</b>saves");
    // One DM from 200 views.
    expect(page).toContain("0.5% of views led to a DM from this campaign");
    expect(page).toContain("From Instagram, updated");

    expect(await pageText("/dashboard")).toContain("<b>200</b>views");

    const cookie = await w.signIn();
    const tokenPage = await (
      await w.fetch("/dashboard/settings/api-token", {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ do: "new" }),
      })
    ).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    const api = (await (await w.fetch("/api/campaigns", { headers: { authorization: `Bearer ${token}` } })).json()) as {
      campaigns: Array<{ post: Record<string, unknown> | null }>;
    };
    expect(api.campaigns[0]!.post).toMatchObject({ views: 200, reach: 9000, likes: 800, comments: 120, shares: 40, saves: 300 });
  });

  it("formats large numbers and tiny shares", async () => {
    const id = await w.campaign();
    w.meta.insights.set(REEL, NUMBERS);
    await w.sendComment(w.comment("agents", FAN));
    await w.cron();
    const page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).toContain("<b>12,345</b>views");
    // One DM from 12,345 views.
    expect(page).toContain("0.0081% of views led to a DM");
  });

  it("reads up to two posts per Cron run, a campaign's post every 15 minutes, and none for campaigns that are off", async () => {
    await w.campaign();
    await w.campaign({ name: "Other", keywords: ["OTHER"], mediaId: OTHER_POST });
    await w.campaign({ name: "Off", keywords: ["OFF"], mediaId: "18000000000000099", active: false });
    await w.campaign({ name: "Everywhere", keywords: ["EVERY"], mediaId: null });
    await w.cron();
    expect(reads()).toBe(2);
    await w.cron();
    await w.cron();
    expect(reads()).toBe(2);
    w.clock.advance(STATS_EVERY);
    await w.cron();
    expect(reads()).toBe(4);
    const { results } = await env.DB.prepare("SELECT media_id FROM media_stats ORDER BY media_id").all<{ media_id: string }>();
    expect(results.map((r) => r.media_id).sort()).toEqual([OTHER_POST, REEL].sort());
  });

  it("explain a missing permission, keep the last numbers, and are read again after a reconnect", async () => {
    const id = await w.campaign();
    w.meta.insights.set(REEL, NUMBERS);
    await w.cron();
    w.clock.advance(STATS_EVERY);
    w.meta.failNext("mediaInsights", NO_PERMISSION);
    await w.cron();

    const page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).toContain("doesn't include <code>instagram_manage_insights</code>");
    expect(page).toContain("<b>12,345</b>views");
    expect(await pageText("/dashboard")).toContain("Add it in setup");

    // A reconnect makes every post due at once.
    await refreshMediaStatsSoon(await w.ctx());
    await w.cron();
    expect(reads()).toBe(3);
    expect(await pageText(`/dashboard/campaigns/${id}`)).not.toContain("instagram_manage_insights");
  });

  it("show other refusals as Meta wrote them, and say when the numbers will come", async () => {
    const id = await w.campaign();
    expect(await pageText(`/dashboard/campaigns/${id}`)).toContain("appear here within a few minutes");
    w.meta.failNext("mediaInsights", new MetaError("Media posted before business account conversion", 400, 100, 2108006));
    await w.cron();
    const page = await pageText(`/dashboard/campaigns/${id}`);
    expect(page).toContain("Could not read Instagram's numbers for this post: Media posted before business account conversion");
    expect(page).not.toContain("views led to");
  });

  it("are not shown for a campaign on all posts", async () => {
    const id = await w.campaign({ mediaId: null });
    await w.cron();
    expect(reads()).toBe(0);
    expect(await pageText(`/dashboard/campaigns/${id}`)).not.toContain("Instagram's numbers");
  });
});

describe("the campaigns page", () => {
  it("lists the newest campaign first, each with its post's cover image", async () => {
    // Invented posts: the Reel has a cover image, the other post none.
    w.meta.media.push(
      { id: REEL, caption: "Invented reel", permalink: "https://example.com/p/1", timestamp: w.clock.now() - 2 * DAY, mediaType: "REELS", thumbnailUrl: "https://cdn.example.com/reel-cover.jpg" },
      { id: OTHER_POST, caption: "Invented post", permalink: "https://example.com/p/2", timestamp: w.clock.now() - DAY, mediaType: "FEED" },
    );
    await w.campaign({ name: "Oldest campaign" });
    w.clock.advance(DAY);
    await w.campaign({ name: "All posts campaign", mediaId: null, keywords: ["GUIDE"] });
    w.clock.advance(DAY);
    await w.campaign({ name: "Newest campaign", mediaId: OTHER_POST, keywords: ["SETUP"] });
    await w.cron();

    const page = await pageText("/dashboard");
    const at = (name: string) => page.indexOf(`>${name}</a>`);
    expect(at("Newest campaign")).toBeGreaterThan(-1);
    expect(at("Newest campaign")).toBeLessThan(at("All posts campaign"));
    expect(at("All posts campaign")).toBeLessThan(at("Oldest campaign"));
    expect(page).toContain("Started 2026-11-04");
    // Only the Reel has an image; the other two rows keep an empty frame.
    expect(page.match(/<img /g)).toEqual(['<img ']);
    expect(page).toContain('<img src="https://cdn.example.com/reel-cover.jpg"');
    expect(page.match(/class="cover"/g)).toHaveLength(3);
  });
});

describe("every recent post and the account", () => {
  async function api(path: string): Promise<any> {
    const cookie = await w.signIn();
    const tokenPage = await (
      await w.fetch("/dashboard/settings/api-token", {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ do: "new" }),
      })
    ).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    return (await w.fetch(path, { headers: { authorization: `Bearer ${token}` } })).json();
  }

  /** Invented posts, posted `days` ago. */
  function post(id: string, days: number, mediaType = "REELS") {
    w.meta.media.push({ id, caption: `Invented post ${id}`, permalink: `https://example.com/p/${id}`, timestamp: w.clock.now() - days * DAY, mediaType });
  }

  it("lists the last 90 days of posts hourly and serves them with their numbers and campaigns", async () => {
    post("18000000000000201", 1);
    post("18000000000000202", 20);
    post("18000000000000203", 120);
    const id = await w.campaign({ mediaId: "18000000000000202" });
    w.meta.insights.set("18000000000000201", { views: 500, likes: 40 });
    await w.cron();
    await w.cron();
    expect(w.meta.calls.filter((c) => c === "listMediaSince").length).toBe(1);

    const all = (await api("/api/posts")) as { posts: Array<Record<string, unknown>> };
    expect(all.posts.map((p) => p.id)).toEqual(["18000000000000201", "18000000000000202"]);
    expect(all.posts[0]).toMatchObject({ caption: "Invented post 18000000000000201", media_type: "REELS", views: 500, likes: 40, reach: null, numbers_problem: null, campaign_ids: [] });
    expect(all.posts[0]!.numbers_updated_at).toBe(new Date(w.clock.now()).toISOString());
    expect(all.posts[1]).toMatchObject({ campaign_ids: [id] });

    const since = new Date(w.clock.now() - 5 * DAY).toISOString();
    const recent = (await api(`/api/posts?since=${encodeURIComponent(since)}`)) as { posts: Array<{ id: string }> };
    expect(recent.posts.map((p) => p.id)).toEqual(["18000000000000201"]);

    w.clock.advance(HOUR);
    await w.cron();
    expect(w.meta.calls.filter((c) => c === "listMediaSince").length).toBe(2);
  });

  it("reads posts without a campaign by age: often while new, daily once settled", async () => {
    post("18000000000000301", 1); // every 15 minutes
    post("18000000000000302", 5); // hourly
    post("18000000000000303", 20); // every 6 hours
    post("18000000000000304", 60); // daily
    const readLog: string[] = [];
    const original = w.meta.mediaInsights.bind(w.meta);
    w.meta.mediaInsights = async (id: string) => {
      readLog.push(id);
      return original(id);
    };
    for (let i = 0; i < 3; i++) await w.cron();
    expect(new Set(readLog)).toEqual(new Set(["18000000000000301", "18000000000000302", "18000000000000303", "18000000000000304"]));

    readLog.length = 0;
    w.clock.advance(15 * MINUTE);
    for (let i = 0; i < 3; i++) await w.cron();
    expect(readLog).toEqual(["18000000000000301"]);

    readLog.length = 0;
    w.clock.advance(HOUR);
    for (let i = 0; i < 3; i++) await w.cron();
    expect(readLog.sort()).toEqual(["18000000000000301", "18000000000000302"]);

    readLog.length = 0;
    w.clock.advance(6 * HOUR);
    for (let i = 0; i < 3; i++) await w.cron();
    expect(readLog.sort()).toEqual(["18000000000000301", "18000000000000302", "18000000000000303"]);

    readLog.length = 0;
    w.clock.advance(DAY);
    for (let i = 0; i < 3; i++) await w.cron();
    expect(readLog.sort()).toEqual(["18000000000000301", "18000000000000302", "18000000000000303", "18000000000000304"]);
  });

  describe("Reel watch time and skip rate", () => {
    const REFUSED = new MetaError("(#100) The Media Insights API does not support the reels_skip_rate metric for this media product type", 400, 100);
    const reelReads = () => w.meta.calls.filter((c) => c === "reelInsight").length;
    const byId = async () => new Map(((await api("/api/posts")) as { posts: Array<Record<string, unknown>> }).posts.map((p) => [p.id, p]));

    it("are read for Reels only, one request each, and served with the other numbers", async () => {
      post("18000000000000401", 1);
      post("18000000000000402", 1, "FEED");
      post("18000000000000403", 2, "VIDEO");
      const id = await w.campaign({ mediaId: "18000000000000401" });
      w.meta.insights.set("18000000000000401", NUMBERS);
      w.meta.insights.set("18000000000000402", { reach: 70, likes: 9 });
      w.meta.reelInsights.set("18000000000000401", { ig_reels_avg_watch_time: 15500, reels_skip_rate: 47.5 });
      w.meta.reelInsights.set("18000000000000403", { ig_reels_avg_watch_time: 8200, reels_skip_rate: 61.2 });
      await w.cron();
      await w.cron();
      expect(reads()).toBe(3);
      // Two Reel-like posts, two requests each; none for the photo.
      expect(reelReads()).toBe(4);

      const posts = await byId();
      expect(posts.get("18000000000000401")).toMatchObject({ views: 12345, shares: 40, saves: 300, avg_watch_time_ms: 15500, skip_rate_percent: 47.5 });
      expect(posts.get("18000000000000403")).toMatchObject({ avg_watch_time_ms: 8200, skip_rate_percent: 61.2 });
      expect(posts.get("18000000000000402")).toMatchObject({ reach: 70, likes: 9, avg_watch_time_ms: null, skip_rate_percent: null });

      const campaigns = (await api("/api/campaigns")) as { campaigns: Array<{ id: number; post: Record<string, unknown> | null }> };
      expect(campaigns.campaigns.find((c) => c.id === id)!.post).toMatchObject({ views: 12345, avg_watch_time_ms: 15500, skip_rate_percent: 47.5 });
    });

    it("cost none of the other numbers when Meta refuses them", async () => {
      post("18000000000000411", 1);
      w.meta.insights.set("18000000000000411", NUMBERS);
      w.meta.failNext("reelInsight", REFUSED);
      w.meta.failNext("reelInsight", REFUSED);
      await w.cron();
      expect(reelReads()).toBe(2);
      expect((await byId()).get("18000000000000411")).toMatchObject({
        views: 12345,
        reach: 9000,
        likes: 800,
        comments: 120,
        shares: 40,
        saves: 300,
        avg_watch_time_ms: null,
        skip_rate_percent: null,
        numbers_problem: null,
      });
    });

    it("are read apart from each other, and a refused one keeps its last number", async () => {
      post("18000000000000421", 1);
      w.meta.insights.set("18000000000000421", { views: 100 });
      w.meta.reelInsights.set("18000000000000421", { ig_reels_avg_watch_time: 15500, reels_skip_rate: 47.5 });
      await w.cron();

      w.clock.advance(15 * MINUTE);
      w.meta.insights.set("18000000000000421", { views: 180 });
      w.meta.reelInsights.set("18000000000000421", { ig_reels_avg_watch_time: 16000, reels_skip_rate: 50.1 });
      // The first request, the watch time, is refused; the skip rate still comes.
      w.meta.failNext("reelInsight", REFUSED);
      await w.cron();
      expect((await byId()).get("18000000000000421")).toMatchObject({ views: 180, avg_watch_time_ms: 15500, skip_rate_percent: 50.1 });
    });

    it("are not asked when the post's other numbers failed", async () => {
      post("18000000000000431", 1);
      w.meta.failNext("mediaInsights", NO_PERMISSION);
      await w.cron();
      expect(reads()).toBe(1);
      expect(reelReads()).toBe(0);
    });
  });

  it("serves the follower count, read hourly", async () => {
    await w.cron();
    await w.cron();
    expect(w.meta.calls.filter((c) => c === "getAccountStats").length).toBe(1);
    expect(await api("/api/account")).toMatchObject({ instagram_username: OWNER.username, followers: 1200, follows: 150, media_count: 40, problem: null });
    w.meta.accountStats = { followers: 1234, follows: 150, mediaCount: 41 };
    w.clock.advance(HOUR);
    await w.cron();
    expect(await api("/api/account")).toMatchObject({ followers: 1234, media_count: 41 });
  });

  it("serve reposts for every post type, with the post's other numbers", async () => {
    post("18000000000000501", 1);
    post("18000000000000502", 1, "FEED");
    const id = await w.campaign({ mediaId: "18000000000000501" });
    w.meta.insights.set("18000000000000501", { ...NUMBERS, reposts: 3 });
    w.meta.insights.set("18000000000000502", { views: 70, reposts: 0 });
    await w.cron();
    const posts = new Map(((await api("/api/posts")) as { posts: Array<Record<string, unknown>> }).posts.map((p) => [p.id, p]));
    expect(posts.get("18000000000000501")).toMatchObject({ views: 12345, saves: 300, reposts: 3 });
    expect(posts.get("18000000000000502")).toMatchObject({ views: 70, reposts: 0 });
    const campaigns = (await api("/api/campaigns")) as { campaigns: Array<{ id: number; post: Record<string, unknown> | null }> };
    expect(campaigns.campaigns.find((c) => c.id === id)!.post).toMatchObject({ views: 12345, reposts: 3 });
  });
});

describe("the account's days", () => {
  // The test clock starts at 2026-11-04 12:00 UTC, 4 am in Pacific time, so Meta's yesterday is 2026-11-03.
  // Invented numbers.
  const DAY_3 = { reach: 500, reachFollowers: 120, reachNonFollowers: 370, reachUnknown: 10, follows: 9, unfollows: 2 };
  const asked = () => w.meta.daysAsked;

  async function api(path: string): Promise<any> {
    const cookie = await w.signIn();
    const tokenPage = await (
      await w.fetch("/dashboard/settings/api-token", {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ do: "new" }),
      })
    ).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    const res = await w.fetch(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, ...((await res.json()) as object) };
  }

  it("are read newest first, one a minute, back 30 days, and served with nulls where Meta has no number yet", async () => {
    w.meta.accountDays.set("2026-11-03", DAY_3);
    w.meta.accountDays.set("2026-11-02", { ...DAY_3, reach: 450, follows: null, unfollows: null });
    await w.cron();
    expect(asked()).toEqual(["2026-11-03"]);
    await w.cron();
    expect(asked()).toEqual(["2026-11-03", "2026-11-02"]);
    for (let i = 0; i < 29; i++) await w.cron();
    expect(asked()).toHaveLength(30);
    expect(asked().at(-1)).toBe("2026-10-05");

    const all = await api("/api/account/days");
    expect(all.time_zone).toBe("America/Los_Angeles");
    expect(all.days).toHaveLength(30);
    expect(all.days[0]).toEqual({
      day: "2026-11-03",
      reach: 500,
      reach_followers: 120,
      reach_non_followers: 370,
      reach_unknown: 10,
      follows: 9,
      unfollows: 2,
      updated_at: new Date(w.clock.now()).toISOString(),
      problem: null,
    });
    expect(all.days[1]).toMatchObject({ day: "2026-11-02", reach: 450, follows: null, unfollows: null });
    expect(all.days[29]).toMatchObject({ day: "2026-10-05", reach: null });

    const recent = await api("/api/account/days?since=2026-11-02");
    expect(recent.days.map((d: { day: string }) => d.day)).toEqual(["2026-11-03", "2026-11-02"]);
    expect((await api("/api/account/days?since=yesterday")).status).toBe(400);
  });

  it("are read again every 6 hours until 3 days after they end, as Meta fills them in, then left alone", async () => {
    for (let i = 0; i < 31; i++) await w.cron();
    expect(asked()).toHaveLength(30);

    // 10 am Pacific on 2026-11-04: the three days that ended less than 3 days ago.
    asked().length = 0;
    w.clock.advance(6 * HOUR);
    for (let i = 0; i < 4; i++) await w.cron();
    expect(asked()).toEqual(["2026-11-03", "2026-11-02", "2026-11-01"]);

    // Three days on: the new days, then one last read of each day still unsettled.
    asked().length = 0;
    w.clock.advance(3 * DAY);
    for (let i = 0; i < 8; i++) await w.cron();
    expect(asked()).toEqual(["2026-11-06", "2026-11-05", "2026-11-04", "2026-11-03", "2026-11-02", "2026-11-01"]);
  });

  it("keep a day's numbers when a read fails, say why, and try again 6 hours later", async () => {
    w.meta.accountDays.set("2026-11-03", DAY_3);
    await w.cron();
    w.clock.advance(6 * HOUR);
    w.meta.failNext("accountDay", new MetaError("Please reduce the amount of data you're asking for", 500, 1));
    await w.cron();
    expect(asked()).toEqual(["2026-11-03", "2026-11-03"]);
    const days = await api("/api/account/days?since=2026-11-03");
    expect(days.days[0]).toMatchObject({ reach: 500, follows: 9, problem: "Meta rate limit or outage, will retry" });

    await w.cron();
    expect(asked().at(-1)).toBe("2026-11-02");
    w.clock.advance(6 * HOUR);
    await w.cron();
    expect(asked().at(-1)).toBe("2026-11-03");
    expect((await api("/api/account/days?since=2026-11-03")).days[0].problem).toBeNull();
  });

  it("are dropped by the daily cleanup after 90 days", async () => {
    const insert = (day: string) => env.DB.prepare("INSERT INTO account_days (day, reach, fetched_at, updated_at) VALUES (?, 1, 1, 1)").bind(day).run();
    await insert("2026-08-05");
    await insert("2026-08-06");
    await cleanup(await w.ctx());
    const { results } = await env.DB.prepare("SELECT day FROM account_days").all<{ day: string }>();
    expect(results.map((r) => r.day)).toEqual(["2026-08-06"]);
  });

  it("use Meta's day, in Pacific time, in summer and in winter", () => {
    expect(metaDay(Date.parse("2026-11-04T07:30:00Z"))).toBe("2026-11-03");
    expect(metaDay(Date.parse("2026-11-04T08:30:00Z"))).toBe("2026-11-04");
    expect(metaDay(Date.parse("2026-07-01T06:30:00Z"))).toBe("2026-06-30");
    expect(metaDay(Date.parse("2026-07-01T07:30:00Z"))).toBe("2026-07-01");
  });
});

describe("Graph client insights", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads both shapes Meta answers with, and asks again without the metrics a post type lacks", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const metric = url.searchParams.get("metric") ?? "";
      asked.push(metric);
      if (metric.includes("shares")) {
        return Response.json({ error: { message: "(#100) The Media Insights API does not support the shares metric for this media product type", code: 100 } }, { status: 400 });
      }
      return Response.json({
        data: [
          { name: "reach", period: "lifetime", values: [{ value: 90 }] },
          { name: "likes", total_value: { value: 8 } },
          { name: "comments", values: [{ value: 3 }] },
          { name: "saved", values: [{ value: 2 }] },
          { name: "something_new", values: [{ value: 1 }] },
        ],
      });
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    expect(await client.mediaInsights(REEL)).toEqual({ reach: 90, likes: 8, comments: 3, saved: 2 });
    expect(asked).toEqual(["views,reach,likes,comments,shares,saved,reposts", "views,reach,likes,comments,shares,saved", "reach,likes,comments,saved"]);
  });

  it("pages through the account's posts until they are older than asked, and reads its counts", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 10, n)).toISOString().replace(".000Z", "+0000");
    const pages: Record<string, unknown> = {
      "": { data: [{ id: "1", timestamp: day(6) }, { id: "2", timestamp: day(5) }], paging: { cursors: { after: "c1" }, next: "https://graph.example/next" } },
      c1: { data: [{ id: "3", timestamp: day(4) }, { id: "4", timestamp: day(1) }], paging: { cursors: { after: "c2" }, next: "https://graph.example/next" } },
    };
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.searchParams.get("fields") === "followers_count,follows_count,media_count") return Response.json({ followers_count: 321, media_count: 12 });
      const after = url.searchParams.get("after") ?? "";
      asked.push(after);
      return Response.json(pages[after]);
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    const media = await client.listMediaSince(Date.UTC(2026, 10, 3), 150);
    expect(media.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(asked).toEqual(["", "c1"]);
    expect(await client.getAccountStats()).toEqual({ followers: 321, follows: null, mediaCount: 12 });
  });

  it("asks for each Reel number alone and reads it, without retrying a refusal", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const metric = url.searchParams.get("metric") ?? "";
      asked.push(metric);
      if (metric === "reels_skip_rate") {
        return Response.json({ error: { message: "(#100) The Media Insights API does not support the reels_skip_rate metric for this media product type", code: 100 } }, { status: 400 });
      }
      return Response.json({ data: [{ name: metric, period: "lifetime", title: "Invented title", values: [{ value: 14250 }] }] });
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    expect(await client.reelInsight(REEL, "ig_reels_avg_watch_time")).toBe(14250);
    await expect(client.reelInsight(REEL, "reels_skip_rate")).rejects.toMatchObject({ code: 100 });
    expect(asked).toEqual(["ig_reels_avg_watch_time", "reels_skip_rate"]);
  });

  it("asks for reposts with the other numbers, and only drops reposts when Meta refuses it", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const metric = url.searchParams.get("metric") ?? "";
      asked.push(metric);
      if (metric.includes("reposts")) {
        return Response.json({ error: { message: "(#100) The Media Insights API does not support the reposts metric for this media product type", code: 100 } }, { status: 400 });
      }
      // Invented numbers.
      return Response.json({ data: [{ name: "views", values: [{ value: 2000 }] }, { name: "shares", values: [{ value: 12 }] }] });
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    expect(await client.mediaInsights(REEL)).toEqual({ views: 2000, shares: 12 });
    expect(asked).toEqual(["views,reach,likes,comments,shares,saved,reposts", "views,reach,likes,comments,shares,saved"]);
  });

  it("reads one of Meta's days for the account, split by follow type", async () => {
    const asked: URL[] = [];
    let refuseFollows = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      asked.push(url);
      const metric = url.searchParams.get("metric") ?? "";
      if (refuseFollows && metric.includes("follows_and_unfollows")) {
        return Response.json({ error: { message: "(#100) follows_and_unfollows is not available for this account", code: 100 } }, { status: 400 });
      }
      // Invented numbers, in the shape Meta answers: UNKNOWN left out, follows not counted yet.
      return Response.json({
        data: [
          {
            name: "reach",
            period: "day",
            total_value: { value: 480, breakdowns: [{ dimension_keys: ["follow_type"], results: [{ dimension_values: ["FOLLOWER"], value: 90 }, { dimension_values: ["NON_FOLLOWER"], value: 385 }] }] },
          },
          ...(metric.includes("follows_and_unfollows") ? [{ name: "follows_and_unfollows", period: "day", total_value: { breakdowns: [{ dimension_keys: ["follow_type"] }] } }] : []),
        ],
      });
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    expect(await client.accountDay("2026-11-10")).toEqual({ reach: 480, reachFollowers: 90, reachNonFollowers: 385, reachUnknown: 0, follows: null, unfollows: null });
    const q = asked[0]!;
    expect(q.pathname).toBe("/v26.0/17841400000000001/insights");
    expect(Object.fromEntries(q.searchParams)).toEqual({
      metric: "reach,follows_and_unfollows",
      period: "day",
      metric_type: "total_value",
      breakdown: "follow_type",
      // Noon Pacific on the day to noon the next: the window holds only the midnight that ends 2026-11-10.
      since: String(Date.UTC(2026, 10, 10, 20) / 1000),
      until: String(Date.UTC(2026, 10, 11, 20) / 1000),
    });

    asked.length = 0;
    refuseFollows = true;
    expect(await client.accountDay("2026-11-10")).toMatchObject({ reach: 480, follows: null });
    expect(asked.map((u) => u.searchParams.get("metric"))).toEqual(["reach,follows_and_unfollows", "reach"]);
  });

  it("holds exactly one of Meta's day ends in each account day's window, across the change of clocks", () => {
    // Midnight Pacific is 07:00 UTC in summer and 08:00 UTC in winter. 2026-11-01 is the day the clocks go back.
    for (const day of ["2026-07-15", "2026-10-31", "2026-11-01", "2026-11-02", "2026-03-08"]) {
      const { since, until } = accountDayWindow(day);
      const [y, m, d] = day.split("-").map(Number) as [number, number, number];
      const ends = [7, 8].flatMap((h) => [-1, 0, 1, 2].map((k) => Date.UTC(y, m - 1, d + k, h) / 1000));
      const inside = ends.filter((t) => t >= Number(since) && t <= Number(until) && metaDay(t * 1000 - 1) !== metaDay(t * 1000));
      expect(inside.map((t) => metaDay(t * 1000 - 1))).toEqual([day]);
    }
  });

  it("does not retry a permission refusal", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return Response.json({ error: { message: "(#10) Application does not have permission for this action", code: 10 } }, { status: 400 });
    });
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    await expect(client.mediaInsights(REEL)).rejects.toMatchObject({ code: 10 });
    expect(calls).toBe(1);
  });
});
