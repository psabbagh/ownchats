import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { alertRequest, receiverOf, type AlertPayload } from "../src/alertmessage";
import { ALERTS_EVERY, DAILY_CAP } from "../src/alerts";
import { MetaError } from "../src/meta/client";
import { dismissUntakenPost } from "../src/nextpost";
import { GAVE_UP_REASON } from "../src/pipeline/comments";
import { saveSettings } from "../src/settings";
import { DAY, HOUR, MINUTE } from "../src/time";
import { BASE, FAN, OWNER, REEL, setupWorld, type Received } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

// Invented: an ntfy topic, a heartbeat check, a Slack and a Discord webhook.
const NTFY = "https://ntfy.sh/ownchats-test-topic-not-real";
const HEARTBEAT = "https://hc-ping.example.com/00000000-0000-4000-8000-000000000000";
const LIMIT = () => new MetaError("Application request limit reached", 403, 4);
const PERMANENT = () => new MetaError("The user is not available", 400, 10, 2534022);

beforeEach(async () => {
  w = await setupWorld();
  // Subscribed to every webhook field, as setup leaves it; the daily check reads this.
  w.meta.subscribed = ["comments", "messages", "messaging_postbacks"];
});

const save = (values: Record<string, string>) => saveSettings(env.DB, env.ADMIN_PASSWORD, values);
/** The alert URL, as the owner saves it; JSON so tests can read each message's fields. */
const alertsOn = (format = "json") => save({ alert_url: NTFY, alert_format: format });

const alertRequests = (): Received[] => w.receiver.received.filter((r) => r.headers["x-ownchats-event"] === "alert");
const alerts = () => alertRequests().map((r) => JSON.parse(r.body) as Record<string, any>);
const statuses = () => alerts().map((a) => `${a.problem}:${a.status}`);

/** Cron runs `n` times, `step` apart. */
async function runs(n: number, step: number, each?: () => Promise<void>) {
  for (let i = 0; i < n; i++) {
    w.clock.advance(step);
    await each?.();
    await w.cron();
  }
}

const people = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `90000000000${String(from + i).padStart(4, "0")}`, username: `invented_person_${from + i}` }));

/** DM failures Meta gave for reasons no retry fixes, logged now. */
async function failDms(n: number, from = 0) {
  const now = w.clock.now();
  await env.DB.batch(
    people(n, from).map((p) =>
      env.DB.prepare("INSERT INTO activity (at, kind, outcome, reason, ig_user_id, username) VALUES (?, 'private_reply', 'failed', 'Meta refused', ?, ?)").bind(now, p.id, p.username),
    ),
  );
}

const postedAt = (mediaId: string, at: number) =>
  env.DB.prepare("INSERT INTO media_stats (media_id, posted_at, fetched_at) VALUES (?, ?, 0) ON CONFLICT (media_id) DO UPDATE SET posted_at = excluded.posted_at").bind(mediaId, at).run();

/** A webhook from Meta that OwnChats accepts (an empty delivery), so last_webhook_at moves. */
const goodWebhook = () => w.webhook({ object: "instagram", entry: [] });

interface Trigger {
  /** Brings the problem about. */
  make(): Promise<void>;
  /** Runs the Cron until the problem should have just opened. */
  untilOpen(): Promise<void>;
  /** Keeps the problem present while time passes, for problems measured over a window. */
  keep?(): Promise<void>;
  /** Fixes it. */
  fix(): Promise<void>;
}

const TRIGGERS: Record<string, Trigger> = {
  webhook: {
    async make() {
      await w.webhook({ object: "instagram", entry: [] }, "not-the-app-secret");
    },
    async untilOpen() {
      await w.cron();
      await runs(1, 16 * MINUTE);
    },
    fix: async () => void (await goodWebhook()),
  },
  token: {
    async make() {
      w.meta.token = { valid: false, expiresAt: null, dataAccessExpiresAt: null, scopes: [] };
    },
    async untilOpen() {
      // The first run makes the daily token check; the next one sees what it found.
      await w.cron();
      await runs(1, ALERTS_EVERY);
    },
    async fix() {
      w.meta.token = { valid: true, expiresAt: null, dataAccessExpiresAt: null, scopes: [] };
      await save({ daily_at: "0" });
    },
  },
  waiting: {
    async make() {
      await w.campaign();
      for (let i = 0; i < 40; i++) w.meta.failNext("sendPrivateReply", LIMIT());
      await w.sendComment(w.comment("agents", FAN));
    },
    async untilOpen() {
      await runs(1, 31 * MINUTE);
    },
    async fix() {
      w.meta.clearFailures();
      // Meta lets it through on the next try.
      await env.DB.prepare("UPDATE comments SET next_attempt_at = ? WHERE status = 'queued'").bind(w.clock.now()).run();
    },
  },
  gave_up: {
    async make() {
      const campaign = await w.campaign();
      const now = w.clock.now();
      await env.DB.prepare(
        `INSERT INTO comments (id, media_id, from_id, from_username, text, commented_at, received_at, source, status, reason, campaign_id, attempts, first_refused_at)
         VALUES ('17900000000000901', ?, ?, ?, 'agents', ?, ?, 'webhook', 'failed', ?, ?, 10, ?)`,
      )
        .bind(REEL, FAN.id, FAN.username, now - HOUR, now - HOUR, GAVE_UP_REASON, campaign, now - HOUR)
        .run();
    },
    untilOpen: () => w.cron(),
    fix: async () => void (await env.DB.prepare("UPDATE comments SET status = 'done' WHERE id = '17900000000000901'").run()),
  },
  untaken: {
    async make() {
      await w.campaign({ mediaId: null, mediaLabel: null, nextPostAfter: w.clock.now() - HOUR });
      w.meta.media.push({ id: "18000000000000777", caption: "An invented post that asks for nothing", permalink: "https://example.com/p/x", timestamp: w.clock.now() - 5 * MINUTE, mediaType: "REELS" });
    },
    async untilOpen() {
      await w.cron(); // lists the post
      await runs(1, ALERTS_EVERY); // first seen
      await runs(1, 15 * MINUTE);
    },
    fix: async () => dismissUntakenPost(await w.ctx(), "18000000000000777"),
  },
  failures: {
    make: () => failDms(5),
    untilOpen: () => w.cron(),
    // Five more people fail every hour while it lasts.
    keep: async () => failDms(5, Math.floor(w.clock.now() / MINUTE) % 10000),
    async fix() {},
  },
  comments: {
    async make() {
      // Comments only the check for missed comments finds: Meta's webhooks never bring them.
      // Its post's age isn't listed yet: such a post is polled every run, and the hourly runs here don't read as a stalled check.
      await w.campaign({ keywords: ["NEVERUSED"] });
      for (const p of people(3, 100)) w.comment("hello", p);
    },
    async untilOpen() {
      // The Cron checks alerts before it polls, so the next check after the poll sees them.
      await w.cron();
      await runs(1, ALERTS_EVERY);
    },
    // More keep coming the same way.
    keep: async () => {
      for (const p of people(2, 200 + (Math.floor(w.clock.now() / MINUTE) % 1000) * 2)) w.comment("hello", p);
    },
    // Webhooks bring comments again, more of them than the check finds.
    fix: async () => {
      for (const p of people(12, 5000)) await w.sendComment(w.comment("hello again", p));
    },
  },
  taps: {
    async make() {
      // Ten first DMs with the button go out, and Meta sends back no tap.
      await w.campaign();
      for (const p of people(10, 300)) await w.sendComment(w.comment("agents", p));
    },
    async untilOpen() {
      // A first DM counts once it is 15 minutes old.
      await runs(1, 16 * MINUTE);
    },
    // Ten more every hour, still with no tap.
    keep: async () => {
      for (const p of people(10, 400 + (Math.floor(w.clock.now() / MINUTE) % 1000) * 10)) await w.sendComment(w.comment("agents", p));
    },
    // A tap arrives.
    fix: async () => void (await w.tap(people(1, 300)[0]!.id, "anything")),
  },
  subscription: {
    async make() {
      // Meta stops sending taps: the account lost messaging_postbacks.
      w.meta.subscribed = ["comments", "messages"];
    },
    async untilOpen() {
      // The first run makes the daily check; the next check of the alerts sees what it found.
      await w.cron();
      await runs(1, ALERTS_EVERY);
    },
    async fix() {
      // The owner subscribes again from setup; the next daily check reads it.
      w.meta.subscribed = ["comments", "messages", "messaging_postbacks"];
      await save({ daily_at: "0" });
    },
  },
  poll: {
    async make() {
      // A campaign on a Reel posted yesterday, and Meta refuses to list its comments.
      await w.campaign();
      await postedAt(REEL, w.clock.now() - DAY);
      for (let i = 0; i < 300; i++) w.meta.failNext("listComments", PERMANENT());
    },
    async untilOpen() {
      await w.cron(); // the check fails
      await runs(1, ALERTS_EVERY); // first seen failing
      await runs(1, HOUR);
    },
    fix: async () => w.meta.clearFailures(),
  },
};

describe("alerts", () => {
  for (const [name, t] of Object.entries(TRIGGERS)) {
    it(`${name}: opens once, doesn't repeat, reminds after 12 hours, and says when it's fixed`, async () => {
      await alertsOn();
      await t.make();
      await t.untilOpen();
      expect(statuses()).toEqual([`${name}:open`]);
      const opened = alerts()[0]!;
      expect(opened.title).toBeTruthy();
      expect(opened.url).toMatch(new RegExp(`^${BASE}/`));

      // No repeat while it stays open.
      await runs(6, 10 * MINUTE, t.keep);
      expect(statuses()).toEqual([`${name}:open`]);

      // One reminder 12 hours after it opened, and only one.
      await runs(12, HOUR, t.keep);
      expect(statuses()).toEqual([`${name}:open`, `${name}:reminder`]);
      expect(alerts()[1]!.title).toMatch(/^Still open: /);

      // Fixed: one message once it has stayed gone for half an hour.
      await t.fix();
      await runs(3, 5 * MINUTE);
      expect(statuses()).toEqual([`${name}:open`, `${name}:reminder`]);
      await runs(24, 5 * MINUTE);
      expect(statuses()).toEqual([`${name}:open`, `${name}:reminder`, `${name}:fixed`]);
      expect(alerts()[2]!.title).toMatch(/^Fixed: /);
      await runs(3, 10 * MINUTE);
      expect(alerts()).toHaveLength(3);
    });
  }

  it("are checked every 5 minutes, not every run", async () => {
    await alertsOn();
    await w.cron();
    await failDms(5);
    // The runs between two checks don't look.
    await runs(3, MINUTE);
    expect(alerts()).toEqual([]);
    await runs(1, ALERTS_EVERY - 3 * MINUTE);
    expect(statuses()).toEqual(["failures:open"]);
  });

  it("say how many people wait, and that Meta's rate limit is why", async () => {
    await alertsOn();
    await save({ time_zone: "America/Toronto" });
    await TRIGGERS.waiting!.make();
    await TRIGGERS.waiting!.untilOpen();
    const [a] = alerts();
    expect(a).toMatchObject({ problem: "waiting", status: "open", people: 1, title: "1 person waiting for a DM", url: `${BASE}/dashboard#needs-you` });
    expect(a!.message).toContain("Instagram's rate limit has held back");
    // In the owner's time zone: the refusal came at 12:00 UTC.
    expect(a!.message).toContain("(the first since 7:00 am)");
    // Alerts never name anyone.
    expect(JSON.stringify(alerts())).not.toContain(FAN.username);
  });

  it("stay quiet on a young Reel that simply gets no comments", async () => {
    await alertsOn();
    await w.campaign();
    await postedAt(REEL, w.clock.now() - DAY);
    await save({ last_webhook_at: String(w.clock.now()) });
    // Eight quiet hours, the Cron running every 5 minutes.
    await runs(96, 5 * MINUTE);
    expect(alerts()).toEqual([]);
  });

  it("say when the check for missed comments is held back by Instagram's rate limit", async () => {
    await alertsOn();
    await w.campaign();
    await postedAt(REEL, w.clock.now() - DAY);
    await w.cron();
    await save({ meta_paused_until: String(w.clock.now() + 3 * HOUR) });
    await runs(9, 10 * MINUTE);
    expect(alerts()).toMatchObject([{ problem: "poll", status: "open", title: "The check for missed comments isn't running", url: `${BASE}/dashboard` }]);
    expect(alerts()[0]!.message).toContain("held back by Instagram's rate limit");
  });

  it("don't count first DMs without a button, or say anything while people tap", async () => {
    await alertsOn();
    await w.campaign({ name: "Plain", keywords: ["PLAIN"], openingButton: "" });
    for (const p of people(12, 600)) await w.sendComment(w.comment("plain", p));
    await runs(2, 20 * MINUTE);
    expect(alerts()).toEqual([]);
    await w.campaign({ name: "Button", keywords: ["BUTTON"] });
    const some = people(12, 700);
    for (const p of some) await w.sendComment(w.comment("button", p));
    await w.tap(some[0]!.id, "anything");
    await runs(2, 20 * MINUTE);
    expect(alerts()).toEqual([]);
  });

  it("name the missing field and leave a failed subscription check alone", async () => {
    await alertsOn();
    w.meta.subscribed = [];
    await w.cron();
    await runs(1, ALERTS_EVERY);
    expect(alerts()).toMatchObject([{ problem: "subscription", status: "open", url: `${BASE}/setup#step-5` }]);
    expect(alerts()[0]!.message).toContain("comments, messages, messaging_postbacks");
    // A check Meta refuses keeps the last answer: nothing is fixed or opened by it.
    w.meta.failNext("getSubscribedFields", PERMANENT());
    await save({ daily_at: "0" });
    await runs(6, 10 * MINUTE);
    expect(statuses()).toEqual(["subscription:open"]);
  });

  it("don't open for a problem that goes away within its grace period", async () => {
    await alertsOn();
    await w.webhook({ object: "instagram", entry: [] }, "not-the-app-secret");
    await w.cron();
    await runs(1, 5 * MINUTE);
    await goodWebhook();
    await runs(6, 5 * MINUTE);
    expect(alerts()).toEqual([]);
  });

  it("don't send fixed for a problem that comes back within half an hour", async () => {
    await alertsOn();
    await TRIGGERS.gave_up!.make();
    await w.cron();
    await TRIGGERS.gave_up!.fix();
    await runs(2, 10 * MINUTE);
    await env.DB.prepare("UPDATE comments SET status = 'failed' WHERE id = '17900000000000901'").run();
    await runs(6, 10 * MINUTE);
    expect(statuses()).toEqual(["gave_up:open"]);
  });

  it("count comments the check for missed comments found that no webhook brought", async () => {
    await alertsOn();
    await w.campaign({ keywords: ["NEVERUSED"] });
    await postedAt(REEL, w.clock.now() - HOUR);
    // Two found by the poll are not enough: a webhook can be a few seconds late.
    w.comment("one", people(1, 1)[0]!);
    w.comment("two", people(1, 2)[0]!);
    await w.cron();
    expect(alerts()).toEqual([]);
    // A third is.
    w.comment("three", people(1, 3)[0]!);
    // The Cron checks alerts before it polls, so the check after the poll sees it.
    await runs(2, ALERTS_EVERY);
    expect(alerts()).toMatchObject([{ problem: "comments", status: "open", people: 3, title: "Comments are not arriving from Meta", url: `${BASE}/setup` }]);
  });

  it("don't count comments the webhooks brought, or the owner's own", async () => {
    await alertsOn();
    await w.campaign({ keywords: ["NEVERUSED"] });
    await postedAt(REEL, w.clock.now() - HOUR);
    for (const p of people(4, 10)) await w.sendComment(w.comment("hello", p));
    w.comment("my own reply", OWNER);
    w.comment("one the poll finds", people(1, 20)[0]!);
    await runs(3, MINUTE);
    expect(alerts()).toEqual([]);
  });

  it("open for a burst of DM failures Meta won't take, not for one", async () => {
    await alertsOn();
    await w.campaign();
    const some = people(5, 30);
    for (const p of some) {
      w.meta.failNext("sendPrivateReply", PERMANENT());
      await w.sendComment(w.comment("agents", p));
      if (p === some[0]) {
        await w.cron();
        expect(alerts()).toEqual([]);
      }
    }
    await runs(1, ALERTS_EVERY);
    expect(alerts()).toMatchObject([{ problem: "failures", status: "open", people: 5 }]);
  });

  it("see Instagram disconnected even though the Cron then does nothing else", async () => {
    await alertsOn();
    await env.DB.prepare("DELETE FROM settings WHERE key = 'access_token'").run();
    await w.cron();
    expect(alerts()).toMatchObject([{ problem: "token", status: "open", title: "Instagram is disconnected", url: `${BASE}/setup` }]);
  });

  it("stop at the daily cap, saying so in the last one, and send no fixed for what they didn't announce", async () => {
    await alertsOn();
    const now = w.clock.now();
    await env.DB.batch(
      Array.from({ length: DAILY_CAP - 1 }, (_, i) =>
        env.DB.prepare("INSERT INTO deliveries (id, event, payload, test, status, attempts, created_at, updated_at) VALUES (?, 'alert', '{}', 0, 'delivered', 1, ?, ?)").bind(`old-${i}`, now - HOUR, now - HOUR),
      ),
    );
    await TRIGGERS.gave_up!.make();
    await w.cron();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.message).toContain(`That makes ${DAILY_CAP} alerts in 24 hours`);

    await failDms(5);
    await runs(1, ALERTS_EVERY);
    expect(alerts()).toHaveLength(1);
    const skipped = await env.DB.prepare("SELECT reason FROM activity WHERE kind = 'alert' AND outcome = 'skipped'").first<{ reason: string }>();
    expect(skipped?.reason).toContain("DMs failing");
    // It clears over the next two hours: nothing was announced, so nothing is fixed.
    await runs(12, 10 * MINUTE);
    expect(statuses()).toEqual(["gave_up:open"]);
  });

  it("send nothing, and remember nothing, without an alert URL", async () => {
    await TRIGGERS.gave_up!.make();
    await runs(3, MINUTE);
    expect(w.receiver.received).toEqual([]);
    const state = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert_state'").first();
    expect(state).toBeNull();
  });

  it("retry a refused alert for about 20 minutes, then give up", async () => {
    await alertsOn();
    w.receiver.replies.push(503, 503, 503, 503);
    await TRIGGERS.gave_up!.make();
    await w.cron();
    await runs(30, MINUTE);
    expect(alertRequests()).toHaveLength(4);
    const row = await env.DB.prepare("SELECT status, attempts FROM deliveries WHERE event = 'alert'").first();
    expect(row).toEqual({ status: "failed", attempts: 4 });
  });
});

describe("alert messages", () => {
  const payload: AlertPayload = { problem: "waiting", status: "open", title: "3 people waiting for a DM", message: "Instagram has refused the DM of 3 people.", people: 3, url: `${BASE}/dashboard#needs-you`, opened_at: 0 };
  const delivery = { id: "d-1", now: Date.parse("2026-11-21T07:35:00Z"), test: false };

  it("go to ntfy as plain text with its title, click and priority headers", () => {
    const r = alertRequest(NTFY, "text", payload, delivery);
    expect(r.body).toBe(`Instagram has refused the DM of 3 people.\n${BASE}/dashboard#needs-you`);
    expect(r.headers).toEqual({ "content-type": "text/plain; charset=utf-8", title: "OwnChats: 3 people waiting for a DM", tags: "warning", priority: "high", click: `${BASE}/dashboard#needs-you` });
    expect(alertRequest(NTFY, "text", { ...payload, status: "fixed", title: "Fixed: café" }, delivery).headers).toMatchObject({ title: "OwnChats: Fixed: caf", tags: "white_check_mark", priority: "default" });
  });

  it("go to Slack and Discord in the JSON each expects, whatever the format chosen", () => {
    const slack = "https://hooks.slack.com/services/T000/B000/notreal";
    const discord = "https://discord.com/api/webhooks/000/notreal";
    expect(receiverOf(slack)).toBe("slack");
    expect(receiverOf(discord)).toBe("discord");
    expect(receiverOf("https://discord.com/channels/1")).toBe("other");
    expect(JSON.parse(alertRequest(slack, "text", payload, delivery).body)).toEqual({ text: `*OwnChats: 3 people waiting for a DM*\nInstagram has refused the DM of 3 people.\n<${BASE}/dashboard#needs-you|Open OwnChats>` });
    expect(JSON.parse(alertRequest(discord, "json", payload, delivery).body)).toEqual({ content: `**OwnChats: 3 people waiting for a DM**\nInstagram has refused the DM of 3 people.\n${BASE}/dashboard#needs-you` });
  });

  it("carry every field as JSON for the owner's own tools", () => {
    expect(JSON.parse(alertRequest("https://tools.example.net/alerts", "json", payload, delivery).body)).toEqual({
      event: "alert",
      delivery_id: "d-1",
      sent_at: "2026-11-21T07:35:00.000Z",
      test: false,
      problem: "waiting",
      status: "open",
      title: "3 people waiting for a DM",
      message: "Instagram has refused the DM of 3 people.",
      people: 3,
      url: `${BASE}/dashboard#needs-you`,
      opened_at: null,
    });
  });
});

describe("heartbeat", () => {
  const pings = () => w.receiver.received.filter((r) => r.url === HEARTBEAT);

  it("is a GET every 10 minutes, even while Instagram is disconnected", async () => {
    await save({ heartbeat_url: HEARTBEAT });
    await w.cron();
    expect(pings()).toHaveLength(1);
    expect(pings()[0]!.headers["user-agent"]).toBe("OwnChats-Heartbeat/1");
    await runs(9, MINUTE);
    expect(pings()).toHaveLength(1);
    await runs(1, MINUTE);
    expect(pings()).toHaveLength(2);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'access_token'").run();
    await runs(10, MINUTE);
    expect(pings()).toHaveLength(3);
  });

  it("notes a failed ping for Settings and tries again 10 minutes later", async () => {
    await save({ heartbeat_url: HEARTBEAT });
    w.receiver.replies.push("offline");
    await w.cron();
    await runs(5, MINUTE);
    expect(pings()).toHaveLength(1);
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(page).toContain("The last visit failed");
    await runs(5, MINUTE);
    expect(pings()).toHaveLength(2);
    const after = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(after).not.toContain("The last visit failed");
    expect(after).toContain("Last visit:");
  });
});

describe("Settings, Alerts", () => {
  const post = (cookie: string, path: string, data: Record<string, string>) =>
    w.fetch(path, { method: "POST", headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(data), redirect: "manual" });

  it("saves the URLs encrypted, and refuses one that isn't https", async () => {
    const cookie = await w.signIn();
    const bad = await (await post(cookie, "/dashboard/settings/alerts", { do: "save", alert_url: "http://ntfy.sh/x", alert_format: "text", heartbeat_url: "" })).text();
    expect(bad).toContain("must start with https://");
    const res = await post(cookie, "/dashboard/settings/alerts", { do: "save", alert_url: NTFY, alert_format: "text", heartbeat_url: HEARTBEAT });
    expect(res.status).toBe(303);
    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert_url'").first<{ value: string }>();
    expect(stored!.value).not.toContain("ntfy");
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(page).toContain(NTFY);
    expect(page).toContain("Send a test alert");
    expect(page).toContain("No alert is open.");
  });

  it("sends a test alert to ntfy and says it was delivered", async () => {
    const cookie = await w.signIn();
    await alertsOn("text");
    const res = await post(cookie, "/dashboard/settings/test-alert", {});
    expect(res.status).toBe(303);
    const [req] = alertRequests();
    expect(req!.url).toBe(NTFY);
    expect(req!.headers).toMatchObject({ title: "OwnChats test alert", tags: "bell", click: `${BASE}/dashboard` });
    expect(req!.body).toContain("This is a test from OwnChats for @test_creator");
    const page = await (await w.fetch(new URL(res.headers.get("location")!, BASE).pathname + new URL(res.headers.get("location")!, BASE).search, { headers: { cookie } })).text();
    expect(page).toContain("Test alert delivered (HTTP 200)");
    // A test is outside the daily cap and the alert state, and out of the lead webhook's deliveries.
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'alert_state'").first()).toBeNull();
    expect(page).not.toContain("Recent deliveries");
  });

  it("lists the alerts open now", async () => {
    const cookie = await w.signIn();
    await alertsOn();
    await TRIGGERS.gave_up!.make();
    await w.cron();
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(page).toContain("Open now: People waiting for you to send their DM");
  });

  it("turns everything off", async () => {
    const cookie = await w.signIn();
    await save({ alert_url: NTFY, heartbeat_url: HEARTBEAT, heartbeat_at: "1" });
    await post(cookie, "/dashboard/settings/alerts", { do: "off" });
    const { results } = await env.DB.prepare("SELECT key FROM settings WHERE key LIKE 'alert%' OR key LIKE 'heartbeat%'").all();
    expect(results).toEqual([]);
  });
});
