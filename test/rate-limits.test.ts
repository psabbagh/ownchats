import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { MetaError, parseUsage, TRANSIENT_REASON } from "../src/meta/client";
import { GraphMetaClient } from "../src/meta/graph";
import { GAVE_UP_REASON } from "../src/pipeline/comments";
import { saveSettings } from "../src/settings";
import { pollEvery } from "../src/pipeline/poll";
import { PAUSE } from "../src/throttle";
import { DAY, HOUR, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, setupWorld } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
const saveTimeZone = (tz: string) => saveSettings(env.DB, env.ADMIN_PASSWORD, { time_zone: tz });
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
    expect(parseUsage('{"call_count":28,"total_time":25,"total_cputime":12}', null)).toEqual({ percent: 28, regainMs: null, detail: "app 28%", limits: { app: 28 } });
    expect(
      parseUsage('{"call_count":40,"total_time":10,"total_cputime":10}', '{"17841400000000001":[{"type":"instagram","call_count":95,"total_cputime":3,"total_time":4,"estimated_time_to_regain_access":12}]}'),
    ).toEqual({ percent: 95, regainMs: 12 * MINUTE, detail: "app 40%, instagram 95%", limits: { app: 40, instagram: 95 } });
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

  it("keeps a high reading of the app's limit when a later answer carries only the account's", async () => {
    await twoPosts();
    w.meta.usagePercent = 86;
    w.clock.advance(MINUTE);
    await w.cron();
    // From here on, answers carry only the per-account header, at 1%.
    w.meta.usagePercent = null;
    w.meta.instagramPercent = 1;
    const before = w.meta.calls.length;
    for (let i = 0; i < 4; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    const run = w.meta.calls.slice(before);
    expect(run).not.toContain("mediaInsights");
    expect(run).not.toContain("accountDay");
    const saved = JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE key = 'meta_usage'").first<{ value: string }>())!.value) as {
      readings: Record<string, { percent: number }>;
    };
    expect(saved.readings.app!.percent).toBe(86);
    expect(saved.readings.instagram!.percent).toBe(1);

    // The app's reading counts for 5 minutes; with no newer one, reads resume.
    for (let i = 0; i < 20; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(w.meta.calls.slice(before)).toContain("mediaInsights");
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
    // The refused DM waits out the pause too.
    expect(count("sendPrivateReply")).toBe(1);
    // A DM by webhook during the pause goes out at once.
    await w.sendComment(w.comment("AGENTS", FAN2, { media: YOUNG_POST }));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);

    // After the pause, the refused DM goes first, then the reads come back.
    for (let i = 0; i < 4; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(2);
    expect(backgroundCalls()).toBeGreaterThan(reads);
  });

  it("spreads the retries of a burst of refusals over more than one minute", async () => {
    await w.campaign();
    const OUTAGE = new MetaError("Service temporarily unavailable", 503, 2);
    for (let i = 0; i < 5; i++) {
      w.meta.failNext("sendPrivateReply", OUTAGE);
      await w.sendComment(w.comment("AGENTS", { id: `90000000000010${i}`, username: `invented_fan_${i}` }));
    }
    const { results } = await env.DB.prepare("SELECT next_attempt_at FROM comments").all<{ next_attempt_at: number }>();
    const at = results.map((r) => r.next_attempt_at);
    expect(Math.min(...at)).toBeGreaterThanOrEqual(w.clock.now() + MINUTE);
    expect(Math.max(...at)).toBeLessThanOrEqual(w.clock.now() + 2 * MINUTE);
    expect(new Set(at).size).toBeGreaterThan(1);
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

const OUTAGE = () => new MetaError("Service temporarily unavailable", 503, 2);

describe("the step after a tap", () => {
  it("is retried by the Cron once Meta's pause ends, and the log says when", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    w.meta.failNext("sendMessage", LIMIT());
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    expect(links(FAN.id)).toHaveLength(0);
    // Due a minute later, but Meta paused the app for 10: the retry goes after the pause. Times are UTC until a zone is chosen.
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "message", outcome: "failed", reason: expect.stringMatching(/^Meta rate limit or outage, will retry, next at 12:1[0-2] pm$/) });

    for (let i = 0; i < 9; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(links(FAN.id)).toHaveLength(0);
    for (let i = 0; i < 3; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(links(FAN.id)).toHaveLength(1);
    expect(await w.unwrap(links(FAN.id)[0]!.message)).toMatchObject({ buttons: [{ type: "web_url", url: "https://example.com/library" }] });
    const conversation = await env.DB.prepare("SELECT state, pending_message FROM conversations").first();
    expect(conversation).toEqual({ state: "done", pending_message: null });
    expect((await w.activity()).filter((a) => a.kind === "link").at(-1)).toMatchObject({ outcome: "sent", reason: "after the tap" });

    // Nothing is sent twice.
    w.clock.advance(HOUR);
    await w.cron();
    expect(links(FAN.id)).toHaveLength(1);
  });

  it("follows the schedule up to about 21.5 hours after the tap, then waits under To check with a Send button", async () => {
    await saveTimeZone("America/Toronto");
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    for (let i = 0; i < 20; i++) w.meta.failNext("sendMessage", OUTAGE());
    const tap = w.clock.now();
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    const tries: number[] = [];
    // Up to 23 hours after the tap: the To check entry stays while Meta's 24 hours last.
    for (let i = 0; i < 23 * 60; i++) {
      w.clock.advance(MINUTE);
      const before = count("sendMessage");
      await w.cron();
      if (count("sendMessage") > before) tries.push(Math.round((w.clock.now() - tap) / MINUTE));
    }
    // 1, 5 and 30 minutes, 1, 3, 6 and 12 hours, and 21.5 hours, each a little later, never past the 24 hours.
    const planned = [1, 5, 30, 60, 180, 360, 720, 1290];
    expect(tries).toHaveLength(planned.length);
    tries.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(planned[i]!);
      expect(t).toBeLessThanOrEqual(planned[i]! + 21);
    });
    expect(tries.at(-1)!).toBeLessThan(23 * 60);
    const log = (await w.activity()).filter((a) => a.kind === "message").map((a) => a.reason);
    // Each try says which it was and when the next one is, in the owner's time zone.
    expect(log[3]).toMatch(/^Meta rate limit or outage, try 3 of 8, next at \d{1,2}:\d\d (am|pm)$/);
    expect(log.at(-1)).toBe("Meta rate limit or outage, try 8 of 8, stopped retrying: send it from To check");

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
  }, 60_000);
});

describe("private replies refused for a passing reason", () => {
  it("are tried on the schedule up to about 6.5 days after the comment, then wait under To check", async () => {
    const id = await w.campaign();
    for (let i = 0; i < 20; i++) w.meta.failNext("sendPrivateReply", OUTAGE());
    const c = w.comment("agents", FAN);
    const start = w.clock.now();
    await w.sendComment(c);
    const tries: number[] = [];
    const step = async (ms: number) => {
      w.clock.advance(ms);
      const before = count("sendPrivateReply");
      await w.cron();
      if (count("sendPrivateReply") > before) tries.push((w.clock.now() - start) / MINUTE);
    };
    for (let i = 0; i < 2 * 60; i++) await step(MINUTE);
    // Up to 6.75 days: the To check entry stays while Meta's 7 days last.
    for (let t = 2 * HOUR; t < 6.75 * DAY; t += 10 * MINUTE) await step(10 * MINUTE);
    // 1, 5 and 30 minutes, 1, 3, 6, 12, 24 and 48 hours, then 6.5 days after the comment.
    const planned = [1, 5, 30, 60, 180, 360, 720, 1440, 2880, 9360];
    expect(tries).toHaveLength(planned.length);
    tries.forEach((t, i) => {
      expect(t).toBeGreaterThanOrEqual(planned[i]!);
      expect(t).toBeLessThanOrEqual(planned[i]! + 30);
    });
    expect(await env.DB.prepare("SELECT status, reason FROM comments WHERE id = ?").bind(c.id).first()).toEqual({ status: "failed", reason: GAVE_UP_REASON });
    expect((await w.activity()).filter((a) => a.kind === "private_reply").at(-1)!.reason).toBe("Meta rate limit or outage, try 10 of 10, stopped retrying: send it from To check");

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
  }, 60_000);
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
    expect(api.activity[0]).toMatchObject({
      kind: "private_reply",
      reason: expect.stringMatching(/^Meta rate limit or outage, will retry, next at /),
      detail: "Application request limit reached (HTTP 403, code 4)",
    });
  });
});

describe("sends refused before automatic retries, and answered by hand", () => {
  const form = (cookie: string, path: string, data: Record<string, string>) =>
    w.fetch(path, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data) });

  it("lists an old refused first DM with only Answered by hand, which sends nothing and counts the person", async () => {
    const id = await w.campaign();
    const c = w.comment("agents", FAN);
    // As the earlier code left a private reply that gave up on a rate limit.
    await env.DB.prepare(
      `INSERT INTO comments (id, media_id, from_id, from_username, text, commented_at, received_at, source, status, reason, campaign_id, attempts)
       VALUES (?, ?, ?, ?, 'agents', ?, ?, 'webhook', 'failed', ?, ?, 5)`,
    )
      .bind(c.id, c.mediaId, FAN.id, FAN.username, c.timestamp, c.timestamp, TRANSIENT_REASON, id)
      .run();
    for (let i = 0; i < 30; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(count("sendPrivateReply")).toBe(0);
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("Waiting on a refused send (1)");
    expect(page).toContain("Refused before OwnChats retried on its own: answer by hand.");
    expect(page).toContain("Answered by hand</button>");
    expect(page).not.toContain(">Send</button>");
    // Send is refused for it all the same.
    expect((await form(cookie, `/dashboard/campaigns/${id}/send`, { type: "comment", id: c.id })).headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=none#to-check`);

    const res = await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "comment", id: c.id });
    expect(res.headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=byhand#to-check`);
    expect(w.meta.sent).toHaveLength(0);
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).not.toContain("Waiting on a refused send");
    expect((await w.activity()).at(-1)).toMatchObject({ kind: "by_hand", outcome: "saved", reason: "first DM answered by hand", comment_id: c.id });
    // A second click marks nothing.
    expect((await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "comment", id: c.id })).headers.get("location")).toBe(`/dashboard/campaigns/${id}?sent=none#to-check`);
    // They count once, as a person answered by hand, and a later comment from them gets no second DM.
    expect(await (await w.fetch("/dashboard", { headers: { cookie } })).text()).toContain("<b>1</b>answered by hand");
    await w.sendComment(w.comment("agents please", FAN));
    expect(w.meta.sent).toHaveLength(0);
  });

  it("lists someone whose link after a tap was refused before messages were kept, and marks them", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    const tapAt = w.clock.now();
    await env.DB.prepare("UPDATE conversations SET last_inbound_at = ? WHERE ig_user_id = ?").bind(tapAt, FAN.id).run();
    await env.DB.prepare("INSERT INTO activity (at, kind, outcome, reason, campaign_id, ig_user_id, username) VALUES (?, 'message', 'failed', ?, ?, ?, ?)")
      .bind(tapAt + 1000, TRANSIENT_REASON, id, FAN.id, FAN.username)
      .run();
    // Two days later, past Meta's 24 hours: listed for a hand answer, not for Send.
    w.clock.advance(2 * DAY);
    const cookie = await w.signIn();
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain("t get the message after their tap.");
    expect(page).toContain("window for OwnChats to send this has closed: answer by hand.");
    expect(page).not.toContain(">Send</button>");
    const conversationId = (await env.DB.prepare("SELECT id FROM conversations").first<{ id: number }>())!.id;
    await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "message", id: String(conversationId) });
    expect(await env.DB.prepare("SELECT state, answered_by_hand_at FROM conversations").first()).toEqual({ state: "done", answered_by_hand_at: w.clock.now() });
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).not.toContain("Waiting on a refused send");
    expect(w.meta.sentTo(FAN.id).filter((s) => s.kind === "message")).toHaveLength(0);
  });

  it("stops the retries of a message the owner answered by hand, and serves the count in the API", async () => {
    const id = await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    for (let i = 0; i < 20; i++) w.meta.failNext("sendMessage", OUTAGE());
    await w.tap(FAN.id, `${OPEN_PAYLOAD_PREFIX}${id}`);
    const cookie = await w.signIn();
    expect(await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text()).toContain(">Send</button>");
    const conversationId = (await env.DB.prepare("SELECT id FROM conversations").first<{ id: number }>())!.id;
    await form(cookie, `/dashboard/campaigns/${id}/by-hand`, { type: "message", id: String(conversationId) });
    const tries = count("sendMessage");
    for (let i = 0; i < 60; i++) {
      w.clock.advance(MINUTE);
      await w.cron();
    }
    expect(count("sendMessage")).toBe(tries);

    const tokenPage = await (await form(cookie, "/dashboard/settings/api-token", { do: "new" })).text();
    const token = tokenPage.match(/oc_[A-Za-z0-9_-]+/)![0];
    const api = (await (await w.fetch("/api/campaigns", { headers: { authorization: `Bearer ${token}` } })).json()) as { campaigns: Array<{ counts: Record<string, number> }> };
    expect(api.campaigns[0]!.counts).toMatchObject({ answeredByHand: 1, linksSent: 0 });
  });
});
