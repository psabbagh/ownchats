import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshMediaStatsSoon, STATS_EVERY } from "../src/insights";
import { MetaError } from "../src/meta/client";
import { GraphMetaClient } from "../src/meta/graph";
import { BASE, FAN, OTHER_POST, REEL, setupWorld } from "./helpers";
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

  it("reads one post per Cron run, each at most every 15 minutes, and only for campaigns that are on", async () => {
    await w.campaign();
    await w.campaign({ name: "Other", keywords: ["OTHER"], mediaId: OTHER_POST });
    await w.campaign({ name: "Off", keywords: ["OFF"], mediaId: "18000000000000099", active: false });
    await w.campaign({ name: "Everywhere", keywords: ["EVERY"], mediaId: null });
    await w.cron();
    await w.cron();
    await w.cron();
    expect(reads()).toBe(2);
    w.clock.advance(STATS_EVERY);
    await w.cron();
    expect(reads()).toBe(3);
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
    expect(asked).toEqual(["views,reach,likes,comments,shares,saved", "reach,likes,comments,saved"]);
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
