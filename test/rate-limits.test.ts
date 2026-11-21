import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError, parseUsage, TRANSIENT_REASON } from "../src/meta/client";
import { GraphMetaClient } from "../src/meta/graph";
import { MESSAGE_GAVE_UP_REASON } from "../src/pipeline/messages";
import { GAVE_UP_REASON, RETRY_AFTER } from "../src/pipeline/comments";
import { pollEvery } from "../src/pipeline/poll";
import { PAUSE } from "../src/throttle";
import { DAY, HOUR, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

// Invented ids.
const YOUNG_POST = "18000000000000501";
const OLD_POST = "18000000000000502";
const LIMIT = () => new MetaError("Application request limit reached", 403, 4);
const count = (method: string) => w.meta.calls.filter((c) => c === method).length;
const backgroundCalls = () => w.meta.calls.filter((c) => ["listComments", "mediaInsights", "reelInsight", "accountDay", "listMediaSince", "getAccountStats"].includes(c)).length;
const links = (to: string) => w.meta.sentTo(to).filter((s) => s.kind === "message");

/** Two watched posts: one a day old, one 10 days old, both Reels. */
async function twoPosts() {
  w.meta.media.push(
    { id: YOUNG_POST, caption: "Invented young reel", permalink: "https://example.com/p/young", timestamp: w.clock.now() - DAY, mediaType: "REELS" },
    { id: OLD_POST, caption: "Invented old reel", permalink: "https://example.com/p/old", timestamp: w.clock.now() - 10 * DAY, mediaType: "REELS" },
  );
  await w.campaign({ mediaId: YOUNG_POST });
  await w.campaign({ name: "Old one", keywords: ["OLD"], mediaId: OLD_POST });
  // The first run lists the posts, so their ages are known.
  await w.cron();
}

describe("Meta's usage headers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are read from X-App-Usage and X-Business-Use-Case-Usage, the highest share winning", () => {
    expect(parseUsage('{"call_count":28,"total_time":25,"total_cputime":12}', null)).toEqual({ percent: 28, regainMs: null, detail: "app 28%" });
    expect(
      parseUsage('{"call_count":40,"total_time":10,"total_cputime":10}', '{"17841400000000001":[{"type":"instagram","call_count":95,"total_cputime":3,"total_time":4,"estimated_time_to_regain_access":12}]}'),
    ).toEqual({ percent: 95, regainMs: 12 * MINUTE, detail: "app 40%, instagram 95%" });
    expect(parseUsage(null, null)).toBeNull();
    expect(parseUsage("not json", "{}")).toBeNull();
  });

  it("are kept from every answer, a refusal included", async () => {
    const answers = [
      new Response(JSON.stringify({ id: "17841400000000001", username: "test_creator" }), { headers: { "x-app-usage": '{"call_count":31,"total_time":5,"total_cputime":5}' } }),
      new Response(JSON.stringify({ error: { message: "Application request limit reached", code: 4 } }), { status: 403, headers: { "x-app-usage": '{"call_count":100,"total_time":5,"total_cputime":5}' } }),
    ];
    vi.stubGlobal("fetch", async () => answers.shift()!);
    const client = new GraphMetaClient("https://graph.example", "test-token", "17841400000000001", "1000000000000001", "test-secret");
    await client.getAccount();
    expect(client.lastUsage).toMatchObject({ percent: 31 });
    const err = await client.getAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaError);
    expect((err as MetaError).rateLimited).toBe(true);
    expect(client.lastUsage).toMatchObject({ percent: 100 });
  });
});

describe("sends first", () => {
  it("near the limit, skips insights, account days and older posts, and still polls a new post and sends", async () => {
    await twoPosts();
    w.meta.usagePercent = 75;
    w.clock.advance(MINUTE);
    await w.cron(); // the first call reports 75%
    const before = w.meta.calls.length;
    // An hour at 75%: the day-old post's comments every minute, and nothing else.
    for (let i = 0; i < 60; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    const hour = w.meta.calls.slice(before);
    expect(hour.filter((c) => c === "listComments")).toHaveLength(60);
    expect(hour).not.toContain("mediaInsights");
    expect(hour).not.toContain("accountDay");
    expect(hour).not.toContain("listMediaSince");
    expect(hour).not.toContain("getAccountStats");

    await w.sendComment(w.comment("AGENTS", FAN, { media: YOUNG_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);

    // Above 90%, no background read at all.
    w.meta.usagePercent = 92;
    await w.sendComment(w.comment("AGENTS", FAN2, { media: YOUNG_POST }));
    const reads = backgroundCalls();
    w.clock.advance(MINUTE);
    await w.cron();
    expect(backgroundCalls()).toBe(reads);

    // Once it falls, reads come back.
    w.meta.usagePercent = 20;
    w.clock.advance(10 * MINUTE);
    await w.cron(); // stale reading: one read to see where it stands
    w.clock.advance(MINUTE);
    await w.cron();
    expect(backgroundCalls()).toBeGreaterThan(reads);
  });

  it("pauses every background read for some minutes when Meta refuses with code 4, and keeps sending", async () => {
    await twoPosts();
    w.meta.failNext("sendPrivateReply", LIMIT());
    await w.sendComment(w.comment("AGENTS", FAN, { media: YOUNG_POST }));
    const paused = await env.DB.prepare("SELECT value FROM settings WHERE key = 'meta_paused_until'").first<{ value: string }>();
    expect(Number(paused!.value)).toBe(w.clock.now() + PAUSE);

    const reads = backgroundCalls();
    for (let i = 0; i < 9; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(backgroundCalls()).toBe(reads);
    // The refused DM was still retried, and went out.
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
    // A DM by webhook during the pause goes out at once.
    await w.sendComment(w.comment("AGENTS", FAN2, { media: YOUNG_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(2);

    w.clock.advance(2 * MINUTE);
    await w.cron();
    expect(backgroundCalls()).toBeGreaterThan(reads);
  });

  it("retries only a few sends per run while paused", async () => {
    await w.campaign();
    for (let i = 0; i < 4; i++) {
      w.meta.failNext("sendPrivateReply", LIMIT());
      await w.sendComment(w.comment("AGENTS", { id: `90000000000010${i}`, username: `invented_fan_${i}` }));
    }
    expect(w.meta.sent).toHaveLength(0);
    w.clock.advance(MINUTE);
    await w.cron();
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(2);
  });
});

describe("polling by age", () => {
  it("polls a post in its first 2 days every run, and older ones less and less", async () => {
    expect(pollEvery(Date.parse("2026-11-03T12:00:00Z"), Date.parse("2026-11-04T12:00:00Z"))).toBe(0);
    expect(pollEvery(null, 0)).toBe(0);
    expect(pollEvery(0, 5 * DAY)).toBe(15 * MINUTE);
    expect(pollEvery(0, 10 * DAY)).toBe(HOUR);
    expect(pollEvery(0, 40 * DAY)).toBe(3 * HOUR);

    await twoPosts();
    const polls = () => count("listComments");
    const start = polls();
    for (let i = 0; i < 60; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    // The young post every minute, the 10-day-old one hourly.
    expect(polls() - start).toBe(61);
  });

  it("still finds a comment the webhook missed on an older post", async () => {
    await twoPosts();
    const missed = w.comment("OLD", FAN, { media: OLD_POST });
    for (let i = 0; i < 60; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(w.meta.sent.filter((s) => s.kind === "private_reply").map((s) => s.to)).toEqual([missed.id]);
  });
});

describe("the step after a tap", () => {
  it("is retried by the Cron when Meta refuses it for a rate limit, and the log says so truthfully", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    w.meta.failNext("sendMessage", LIMIT());
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(links(FAN.id)).toHaveLength(0);
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "message", outcome: "failed", reason: TRANSIENT_REASON });

    w.clock.advance(MINUTE);
    await w.cron();
    expect(links(FAN.id)).toHaveLength(1);
    expect(await w.unwrap(links(FAN.id)[0]!.message)).toMatchObject({ buttons: [{ type: "web_url", url: "https://example.com/library" }] });
    const conversation = await env.DB.prepare("SELECT state, pending_message FROM conversations").first();
    expect(conversation).toEqual({ state: "done", pending_message: null });
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "link", outcome: "sent", reason: "after the tap" });

    // Nothing is sent twice.
    w.clock.advance(HOUR);
    await w.cron();
    expect(links(FAN.id)).toHaveLength(1);
  });

  it("is spaced out, stops before Meta's 24 hours run out, and waits under To check with a Send button", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    for (let i = 0; i < 20; i++) w.meta.failNext("sendMessage", LIMIT());
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    for (let i = 0; i < 18 * 60; i += 10) {
      w.clock.advance(10 * MINUTE);
      await w.cron();
    }
    // 1 + 8 retries, the last at 15 h 54 min, then no more.
    expect(count("sendMessage")).toBe(9);
    expect((await w.activity()).filter((a) => a.kind === "message").at(-1)).toMatchObject({ outcome: "failed", reason: MESSAGE_GAVE_UP_REASON });

    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("Waiting on a refused send (1)");
    expect(page).toContain(`@${FAN.username}`);
    expect(page).toContain("OwnChats stopped retrying after 9 tries so far.");
    expect(await (await w.fetch("/dashboard", { headers: { cookie } })).text()).toContain("1 person waiting on a refused send");

    w.meta.clearFailures();
    const conversationId = (await env.DB.prepare("SELECT id FROM conversations").first<{ id: number }>())!.id;
    const res = await w.fetch(`/dashboard/campaigns/${id}/send`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ type: "message", id: String(conversationId) }),
    });
    expect(res.headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=1#to-check`);
    expect(links(FAN.id)).toHaveLength(1);
    const after = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(after).not.toContain("Waiting on a refused send");
  });
});

describe("private replies refused for a passing reason", () => {
  it("are tried again further and further apart, then wait under To check", async () => {
    const id = await w.campaign();
    for (let i = 0; i < 20; i++) w.meta.failNext("sendPrivateReply", LIMIT());
    const c = w.comment("agents", FAN);
    await w.sendComment(c);
    const tries = () => count("sendPrivateReply");
    expect(tries()).toBe(1);
    // Due a minute later, then 5 minutes after that, not every minute.
    w.clock.advance(MINUTE);
    await w.cron();
    expect(tries()).toBe(2);
    for (let i = 0; i < 4; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(tries()).toBe(2);
    w.clock.advance(MINUTE);
    await w.cron();
    expect(tries()).toBe(3);

    // The rest over about 4 days, inside Meta's 7.
    const total = RETRY_AFTER.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(5 * DAY);
    for (let t = 0; t < 5 * DAY; t += 30 * MINUTE) {
      w.clock.advance(30 * MINUTE);
      await w.cron();
    }
    expect(tries()).toBe(RETRY_AFTER.length + 1);
    expect(await env.DB.prepare("SELECT status, reason FROM comments WHERE id = ?").bind(c.id).first()).toEqual({ status: "failed", reason: GAVE_UP_REASON });

    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("Didn't get the first DM.");
    w.meta.clearFailures();
    const res = await w.fetch(`/dashboard/campaigns/${id}/send`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ type: "comment", id: c.id }),
    });
    expect(res.headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=1#to-check`);
    expect(w.meta.sent.map((s) => s.kind)).toEqual(["private_reply", "public_reply"]);
    // A second click sends nothing.
    const again = await w.fetch(`/dashboard/campaigns/${id}/send`, {
      method: "POST",
      headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ type: "comment", id: c.id }),
    });
    expect(again.headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=none#to-check`);
    expect(w.meta.sent).toHaveLength(2);
  });
});

describe("GET /api/activity", () => {
  it("serves Meta's error in detail", async () => {
    await w.campaign();
    w.meta.failNext("sendPrivateReply", LIMIT());
    await w.sendComment(w.comment("agents", FAN));
    const cookie = await w.signIn();
    const tokenPage = await (
      await w.fetch("/dashboard/settings/api-token", {
        method: "POST",
        headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ do: "new" }),
      })
    ).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    const api = (await (await w.fetch("/api/activity?outcome=failed", { headers: { authorization: `Bearer ${token}` } })).json()) as { activity: Array<Record<string, unknown>> };
    expect(api.activity[0]).toMatchObject({ kind: "private_reply", reason: TRANSIENT_REASON, detail: "Application request limit reached (HTTP 403, code 4)" });
  });
});
