import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import type { Ctx } from "../src/context";
import { hmacSha256Hex } from "../src/crypto";
import { MAX_ATTEMPTS, RETRY_DELAYS, webhookConfig } from "../src/leadwebhook";
import { HOUR, MINUTE } from "../src/time";
import { BASE, FAN, FAN2, setupWorld, WEBHOOK_SECRET, type Received } from "./helpers";

type World = Awaited<ReturnType<typeof setupWorld>>;
let w: World;

beforeEach(async () => {
  w = await setupWorld();
});

const form = (cookie: string, data: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { cookie, origin: BASE, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data),
});

/** Checks a request the way a receiver must: HMAC-SHA256 over "<timestamp>.<raw body>" with the shared secret. */
async function signedCorrectly(r: Received, secret = WEBHOOK_SECRET): Promise<boolean> {
  const ts = r.headers["x-ownchats-timestamp"]!;
  return r.headers["x-ownchats-signature"] === `v1=${await hmacSha256Hex(secret, `${ts}.${r.body}`)}`;
}

/** A comment, a tap, the link opened (which brings the email ask) and an email reply, on a "link plus optional email" campaign. */
async function giveEmail(w: World, campaign: number, who = FAN, email = "fan@example.com") {
  await w.sendComment(w.comment("agents", who));
  await w.tap(who.id, `${OPEN_PAYLOAD_PREFIX}${campaign}`);
  await w.openLink(who.id);
  await w.sendDm(who.id, `here: ${email}`);
}

async function webhookLog() {
  const { results } = await env.DB.prepare("SELECT outcome, reason, detail, campaign_id, ig_user_id FROM activity WHERE kind = 'lead_webhook' ORDER BY id").all<{
    outcome: string;
    reason: string;
    detail: string;
    campaign_id: number | null;
    ig_user_id: string | null;
  }>();
  return results;
}

describe("lead webhook", () => {
  it("POSTs each new email once, signed over the timestamp and body, in the agreed format", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ name: "SETUP", emailMode: "optional", emailTag: "setupGuide", consentText: "", linkTitle: "Turn YouTube videos into Claude skills" });
    w.meta.names.set(FAN.id, "Sam");
    await giveEmail(w, id);
    // The link the DM sent this person: their own /go/ link.
    const dmLink = (w.meta.sentTo(FAN.id)[0]!.message as { buttons: Array<{ url: string }> }).buttons[0]!.url;
    expect(dmLink).toMatch(/^https:\/\/ownchats\.example\.workers\.dev\/go\/[A-Za-z0-9_-]{16}$/);

    expect(w.receiver.received).toHaveLength(1);
    const [req] = w.receiver.received as [Received];
    expect(req.url).toBe("https://hooks.example.net/ownchats");
    const timestamp = String(Math.floor(w.clock.now() / 1000));
    expect(req.headers).toMatchObject({
      "content-type": "application/json",
      "x-ownchats-event": "lead.created",
      "x-ownchats-timestamp": timestamp,
    });
    expect(req.headers["x-ownchats-delivery"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await signedCorrectly(req)).toBe(true);
    expect(await signedCorrectly(req, "another-secret-of-some-length")).toBe(false);

    const lead = await env.DB.prepare("SELECT id, consent_text, consented_at FROM leads").first<{ id: number; consent_text: string; consented_at: number }>();
    const at = new Date(lead!.consented_at).toISOString();
    expect(JSON.parse(req.body)).toEqual({
      event: "lead.created",
      delivery_id: req.headers["x-ownchats-delivery"],
      sent_at: new Date(w.clock.now()).toISOString(),
      test: false,
      lead: { id: lead!.id, email: "fan@example.com", name: "Sam", created_at: at },
      campaign: { id, name: "SETUP", email_tag: "setupGuide", link: dmLink, link_title: "Turn YouTube videos into Claude skills" },
      consent: { wording: lead!.consent_text, given_at: at, channel: "instagram_dm" },
    });
    // The consent wording is the line the person answered.
    expect(lead!.consent_text).toBe("Want more like this? Reply with your email and I'll send you my next ones as they come out. Unsubscribe anytime.");

    // The person got their thank-you, and the attempt is in the log under them.
    expect(w.meta.sentTo(FAN.id).at(-1)!.message).toMatchObject({ kind: "buttons", text: "Thanks, you're on the list!", buttons: [{ title: "Privacy", url: `${BASE}/privacy` }] });
    expect(await webhookLog()).toEqual([
      expect.objectContaining({ outcome: "sent", reason: "lead.created delivered (HTTP 200)", campaign_id: id, ig_user_id: FAN.id }),
    ]);
    const delivery = await env.DB.prepare("SELECT status, attempts, payload FROM deliveries").first();
    expect(delivery).toEqual({ status: "delivered", attempts: 1, payload: "{}" });
  });

  it("sends name as null when Meta shared none, never the username, and email_tag and link_title as null when empty", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "first" });
    await giveEmail(w, id);
    const body = w.receiver.bodies()[0]!;
    expect(body.lead.name).toBeNull();
    expect(body.campaign.email_tag).toBeNull();
    expect(body.campaign.link_title).toBeNull();
    expect(JSON.stringify(body)).not.toContain(FAN.username);
  });

  it("sends the person's own /go/ link even when the email comes before the link, and the DM then carries the same one", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "first" });
    await giveEmail(w, id);
    // Email first: the email was saved, and the webhook queued, before the link DM went out.
    const { link } = w.receiver.bodies()[0]!.campaign;
    const dm = w.meta.sentTo(FAN.id).at(-1)!.message as { buttons: Array<{ url: string }> };
    expect(dm.buttons[0]!.url).toBe(link);
    expect(await w.realUrl(link)).toBe("https://example.com/library");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_links").first()).toEqual({ n: 1 });

    // A click from the email counts as the person's click, like one from the DM.
    const res = await w.fetch(new URL(link).pathname, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.1 Safari/605.1.15" }, redirect: "manual" });
    expect(res.headers.get("location")).toBe("https://example.com/library");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'click' AND ig_user_id = ?").bind(FAN.id).first()).toEqual({ n: 1 });
  });

  it("sends the link itself when click counting is off", async () => {
    await w.lead_webhook();
    const cookie = await w.signIn();
    await w.fetch("/dashboard/settings/clicks", form(cookie, { do: "off" }));
    const id = await w.campaign({ emailMode: "optional", linkTitle: "The library" });
    await giveEmail(w, id);
    expect(w.receiver.bodies()[0]!.campaign).toMatchObject({ link: "https://example.com/library", link_title: "The library" });
  });

  it("sends nothing, and queues nothing, until a webhook is set up", async () => {
    const id = await w.campaign({ emailMode: "optional" });
    await giveEmail(w, id);
    await w.cron();
    expect(w.receiver.received).toHaveLength(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM deliveries").first()).toEqual({ n: 0 });
  });

  it("retries a 429, a 5xx, a timeout or no connection with backoff for about a day, keeping one delivery id", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "optional" });
    w.receiver.replies = [503, "timeout", 429, "offline", 500, 502, 503, 504];
    const start = w.clock.now();
    await giveEmail(w, id);
    expect(w.receiver.received).toHaveLength(1);

    for (const wait of RETRY_DELAYS) {
      // Not before it is due.
      w.clock.advance(wait - MINUTE / 2);
      await w.cron();
      w.clock.advance(MINUTE / 2);
      await w.cron();
    }
    const got = w.receiver.received;
    expect(got).toHaveLength(MAX_ATTEMPTS);
    expect(new Set(got.map((r) => r.headers["x-ownchats-delivery"])).size).toBe(1);
    expect(new Set(got.map((r) => JSON.parse(r.body).delivery_id)).size).toBe(1);
    // A fresh timestamp and signature on each attempt, each one valid.
    expect(new Set(got.map((r) => r.headers["x-ownchats-timestamp"])).size).toBe(MAX_ATTEMPTS);
    for (const r of got) expect(await signedCorrectly(r)).toBe(true);
    // The last attempt comes about a day after the first.
    const span = got.at(-1)!.at - start;
    expect(span).toBeGreaterThan(20 * HOUR);
    expect(span).toBeLessThan(24 * HOUR);

    const log = await webhookLog();
    expect(log.map((l) => l.outcome)).toEqual([...Array(MAX_ATTEMPTS - 1).fill("queued"), "failed"]);
    expect(log[0]!.reason).toBe("lead.created: HTTP 503, retrying in 1 minute");
    expect(log[1]!.reason).toBe("lead.created: timed out after 10 seconds, retrying in 5 minutes");
    expect(log[3]!.reason).toMatch(/^lead\.created: could not connect/);
    expect(log.at(-1)!.reason).toBe("lead.created: HTTP 504, gave up after 8 attempts");
    expect(log.at(-1)!.detail).toContain("attempt 8 of 8");
    expect(await env.DB.prepare("SELECT status, attempts, payload FROM deliveries").first()).toEqual({ status: "failed", attempts: 8, payload: "{}" });

    // Given up: nothing more is sent.
    w.clock.advance(2 * 24 * HOUR);
    await w.cron();
    expect(w.receiver.received).toHaveLength(MAX_ATTEMPTS);
  });

  it("stops retrying once one attempt gets through", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "first" });
    w.receiver.replies = [500];
    await giveEmail(w, id);
    w.clock.advance(RETRY_DELAYS[0]!);
    await w.cron();
    w.clock.advance(HOUR);
    await w.cron();
    expect(w.receiver.received).toHaveLength(2);
    expect((await webhookLog()).map((l) => l.outcome)).toEqual(["queued", "sent"]);
    expect(await env.DB.prepare("SELECT status, attempts FROM deliveries").first()).toEqual({ status: "delivered", attempts: 2 });
  });

  it("treats any other 4xx, and a redirect, as final", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "optional" });
    w.receiver.replies = [401, 301];
    await giveEmail(w, id);
    await giveEmail(w, id, FAN2, "other@example.com");
    w.clock.advance(HOUR);
    await w.cron();
    expect(w.receiver.received).toHaveLength(2);
    const log = await webhookLog();
    expect(log.map((l) => [l.outcome, l.reason])).toEqual([
      ["failed", "lead.created: HTTP 401, not retried"],
      ["failed", "lead.created: HTTP 301, not retried"],
    ]);
    expect(log[0]!.detail).toContain("refused with 401");
    expect(log[1]!.detail).toContain("the URL redirects");
  });

  it("delivers what is waiting even while Instagram is disconnected", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "optional" });
    w.receiver.replies = [503];
    await giveEmail(w, id);
    await env.DB.prepare("DELETE FROM settings WHERE key = 'access_token'").run();
    w.clock.advance(RETRY_DELAYS[0]!);
    await w.cron();
    expect(w.receiver.received).toHaveLength(2);
    expect(await env.DB.prepare("SELECT status FROM deliveries").first()).toEqual({ status: "delivered" });
  });

  it("sends lead.deleted when someone's data is deleted, and cancels their delivery still waiting", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ emailMode: "optional" });
    w.receiver.replies = [503];
    await giveEmail(w, id);
    const lead = await env.DB.prepare("SELECT id FROM leads").first<{ id: number }>();

    const cookie = await w.signIn();
    await w.fetch("/dashboard/people/delete", form(cookie, { ig_user_id: FAN.id }));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 0 });

    const deleted = w.receiver.received.at(-1)!;
    expect(deleted.headers["x-ownchats-event"]).toBe("lead.deleted");
    expect(await signedCorrectly(deleted)).toBe(true);
    const body = JSON.parse(deleted.body);
    expect(body).toEqual({
      event: "lead.deleted",
      delivery_id: deleted.headers["x-ownchats-delivery"],
      sent_at: new Date(w.clock.now()).toISOString(),
      test: false,
      lead: { id: lead!.id, email: "fan@example.com" },
    });
    // The first lead.created was waiting for a retry: it is gone, not sent after the deletion.
    w.clock.advance(HOUR);
    await w.cron();
    expect(w.receiver.received.map((r) => r.headers["x-ownchats-event"])).toEqual(["lead.created", "lead.deleted"]);
    // Nothing about the person is left in OwnChats once lead.deleted is through.
    const rows = await env.DB.prepare("SELECT event, status, payload, ig_user_id FROM deliveries").all();
    expect(rows.results).toEqual([{ event: "lead.deleted", status: "delivered", payload: "{}", ig_user_id: null }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE ig_user_id = ?").bind(FAN.id).first()).toEqual({ n: 0 });
  });

  it("uses the LEAD_WEBHOOK_SECRET Worker secret over the one in Settings", async () => {
    const ctx = await w.ctx();
    const at = (worker: string | undefined, saved: string | undefined): Ctx =>
      ({ ...ctx, env: { ...ctx.env, LEAD_WEBHOOK_SECRET: worker }, settings: { lead_webhook_url: "https://hooks.example.net/x", lead_webhook_secret: saved } }) as Ctx;
    expect(webhookConfig(at("from-the-worker-secret-123", "from-settings-123456"))).toMatchObject({ secret: "from-the-worker-secret-123", secretFrom: "worker" });
    expect(webhookConfig(at(undefined, "from-settings-123456"))).toMatchObject({ secret: "from-settings-123456", secretFrom: "settings" });
    expect(webhookConfig(at(undefined, undefined))).toBeNull();
  });
});

describe("lead webhook settings", () => {
  it("need an https URL and a secret of 16 characters, keep the secret encrypted and never show it", async () => {
    const cookie = await w.signIn();
    const save = (data: Record<string, string>) => w.fetch("/dashboard/settings/webhook", form(cookie, { do: "save", ...data }));
    expect(await (await save({ url: "http://hooks.example.net/x", secret: WEBHOOK_SECRET })).text()).toContain("must start with https://");
    expect(await (await save({ url: "https://hooks.example.net/x", secret: "short" })).text()).toContain("at least 16 characters");
    expect(await (await save({ url: "https://hooks.example.net/x" })).text()).toContain("Choose a signing secret");
    expect((await save({ url: "https://hooks.example.net/x", secret: WEBHOOK_SECRET })).status).toBe(303);

    const stored = await env.DB.prepare("SELECT value FROM settings WHERE key = 'lead_webhook_secret'").first<{ value: string }>();
    expect(stored!.value).not.toContain(WEBHOOK_SECRET);
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    expect(page).not.toContain(WEBHOOK_SECRET);
    expect(page).toContain("Saved. Type a new one to replace it.");
    expect(page).toContain("Send a test lead");

    // Saving the URL again without typing the secret keeps the secret.
    expect((await save({ url: "https://hooks.example.net/y" })).status).toBe(303);
    expect(webhookConfig(await w.ctx())).toMatchObject({ url: "https://hooks.example.net/y", secret: WEBHOOK_SECRET });

    await w.fetch("/dashboard/settings/webhook", form(cookie, { do: "off" }));
    expect(webhookConfig(await w.ctx())).toBeNull();
  });

  it("put the email tag and the link's title on the campaign form", async () => {
    const cookie = await w.signIn();
    const res = await w.fetch(
      "/dashboard/campaigns/new",
      form(cookie, { name: "Setup", keywords: "SETUP", media_id: "all", link_text: "Here:", link_url_0: "https://example.com/s", email_mode: "optional", optional_prompt: "Reply with your email.", email_tag: "setupGuide", link_title: "The setup guide", active: "on" }),
    );
    expect(res.status).toBe(303);
    expect(await env.DB.prepare("SELECT email_tag, link_title FROM campaigns").first()).toEqual({ email_tag: "setupGuide", link_title: "The setup guide" });
    const edit = await (await w.fetch(`${res.headers.get("location")}/edit`, { headers: { cookie } })).text();
    expect(edit).toContain('name="email_tag" type="text" value="setupGuide"');
    expect(edit).toContain('name="link_title" type="text" value="The setup guide"');
  });

  it("start new campaigns with email lines that say people can unsubscribe, and a thank-you button to the privacy page, which names the sender", async () => {
    const cookie = await w.signIn();
    await w.fetch("/dashboard/settings/contact", form(cookie, { sender_name: "Invented Creator", sender_address: "PO Box 123\nInvented City", contact: "" }));
    const page = await (await w.fetch("/dashboard/campaigns/new", { headers: { cookie } })).text();
    expect(page).toContain("I&#39;ll send you my next ones as they come out. Unsubscribe anytime.</textarea>");
    expect(page).toContain('name="optional_thanks_button" type="text" value="Privacy"');
    const privacy = await (await w.fetch("/privacy")).text();
    expect(privacy).toContain("Invented Creator (@test_creator on Instagram)<br>PO Box 123<br>Invented City");
    expect(privacy).toContain("unsubscribe");
    // The privacy page says the email goes to an email tool only once a webhook is set up.
    expect(privacy).toContain("It is not shared with anyone else.");
    await w.lead_webhook();
    expect(await (await w.fetch("/privacy")).text()).toContain("passed, with your Instagram name and the wording you agreed to, to the email service");
  });
});

describe("Send a test lead", () => {
  it("posts a lead marked as a test, built exactly like a real one, to the address the owner types, and logs it", async () => {
    await w.lead_webhook();
    const id = await w.campaign({
      name: "SETUP",
      emailMode: "optional",
      emailTag: "setupGuide",
      consentText: "Guide by email from Invented Creator",
      linkTitle: "Turn YouTube videos into Claude skills",
    });
    const cookie = await w.signIn();
    const res = await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "owner@example.org", name: "", campaign_id: String(id) }));
    expect(res.status).toBe(303);
    const page = await (await w.fetch(res.headers.get("location")!, { headers: { cookie } })).text();
    expect(page).toContain("Test lead delivered (HTTP 200).");

    const [req] = w.receiver.received as [Received];
    expect(req.headers["x-ownchats-event"]).toBe("lead.created");
    expect(await signedCorrectly(req)).toBe(true);
    const test = JSON.parse(req.body);
    expect(test).toMatchObject({
      event: "lead.created",
      test: true,
      lead: { id: 0, email: "owner@example.org", name: null },
      campaign: { id, name: "SETUP", email_tag: "setupGuide", link_title: "Turn YouTube videos into Claude skills" },
      consent: { wording: "Guide by email from Invented Creator", channel: "instagram_dm" },
    });
    // Its link works like a person's /go/ link, and a click on it counts nowhere.
    expect(test.campaign.link).toMatch(/^https:\/\/ownchats\.example\.workers\.dev\/go\/[A-Za-z0-9_-]{16}$/);
    const opened = await w.fetch(new URL(test.campaign.link).pathname, { headers: { "user-agent": "Mozilla/5.0 (iPhone) Mobile/15E148" }, redirect: "manual" });
    expect(opened.headers.get("location")).toBe("https://example.com/library");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'click'").first()).toEqual({ n: 0 });
    // Not a lead: nothing is saved.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 0 });
    expect(await webhookLog()).toEqual([expect.objectContaining({ outcome: "sent", reason: "Test lead.created delivered (HTTP 200)", campaign_id: null })]);

    // A real lead has exactly the same shape.
    await giveEmail(w, id);
    const real = w.receiver.bodies()[1]!;
    expect(real.campaign.link).not.toBe(test.campaign.link);
    const shape = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && typeof v === "object" ? Object.keys(v) : typeof v]));
    expect(shape(real)).toEqual(shape(test));
    expect(real.test).toBe(false);
  });

  it("is retried like a real lead when the receiver fails, and the page says so", async () => {
    await w.lead_webhook();
    await w.campaign({ emailMode: "optional" });
    w.receiver.replies = [502];
    const cookie = await w.signIn();
    const res = await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "owner@example.org" }));
    const page = await (await w.fetch(res.headers.get("location")!, { headers: { cookie } })).text();
    expect(page).toContain("The test lead didn't get through yet (HTTP 502). OwnChats tries again at");
    w.clock.advance(RETRY_DELAYS[0]!);
    await w.cron();
    expect(w.receiver.received).toHaveLength(2);
    expect((await webhookLog()).map((l) => [l.outcome, l.reason])).toEqual([
      ["queued", "Test lead.created: HTTP 502, retrying in 1 minute"],
      ["sent", "Test lead.created delivered (HTTP 200)"],
    ]);
    expect(await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text()).toContain("Recent deliveries");
  });

  it("works before any campaign exists, and refuses a bad address or a missing webhook", async () => {
    const cookie = await w.signIn();
    expect(await (await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "owner@example.org" }))).text()).toContain("URL and secret first.");
    await w.lead_webhook();
    expect(await (await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "not an email" }))).text()).toContain("Enter one email address");
    expect((await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "owner@example.org", name: "Sam" }))).status).toBe(303);
    expect(w.receiver.bodies()[0]).toMatchObject({ test: true, lead: { name: "Sam" }, campaign: { id: 0, name: "Test", email_tag: null, link: null, link_title: null } });
  });
});

describe("POST /api/test-lead", () => {
  let cookie: string;
  let write: Record<string, string>;
  beforeEach(async () => {
    cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings/api-write-token", form(cookie, { do: "new" }))).text();
    write = { authorization: `Bearer ${page.match(/ocw_[A-Za-z0-9_-]+/)![0]}`, "content-type": "application/json" };
  });
  const send = (body: unknown, headers = write) => w.fetch("/api/test-lead", { method: "POST", headers, body: JSON.stringify(body) });

  it("sends the same test lead as Settings and answers with the delivery id, the HTTP status and the receiver's reply", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ name: "SETUP", emailMode: "optional", emailTag: "setupGuide", consentText: "Guide by email from Invented Creator", linkTitle: "A guide" });
    const res = await send({ email: "Owner@Example.org", name: "Sam", campaign_id: id });
    expect(res.status).toBe(200);
    const [req] = w.receiver.received as [Received];
    const out = await res.json();
    expect(out).toEqual({
      delivery_id: req.headers["x-ownchats-delivery"],
      status: "delivered",
      message: "Test lead delivered (HTTP 200).",
      http_status: 200,
      result: "HTTP 200",
      reply: "ok",
      attempts: 1,
      next_attempt_at: null,
      campaign_id: id,
    });
    expect(await signedCorrectly(req)).toBe(true);
    expect(JSON.parse(req.body)).toMatchObject({
      test: true,
      lead: { id: 0, email: "owner@example.org", name: "Sam" },
      campaign: { id, name: "SETUP", email_tag: "setupGuide", link_title: "A guide" },
      consent: { wording: "Guide by email from Invented Creator", channel: "instagram_dm" },
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toEqual({ n: 0 });
    expect(await webhookLog()).toEqual([expect.objectContaining({ outcome: "sent", reason: "Test lead.created delivered (HTTP 200)", campaign_id: null })]);
  });

  it("builds the payload exactly as the dashboard's button does", async () => {
    await w.lead_webhook();
    const id = await w.campaign({ name: "SETUP", emailMode: "optional", emailTag: "setupGuide", linkTitle: "A guide" });
    await w.fetch("/dashboard/settings/test-lead", form(cookie, { email: "owner@example.org", name: "Sam", campaign_id: String(id) }));
    await send({ email: "owner@example.org", name: "Sam", campaign_id: id });
    const [fromDashboard, fromApi] = w.receiver.bodies() as [Record<string, any>, Record<string, any>];
    const strip = (b: Record<string, any>) => ({ ...b, delivery_id: null, campaign: { ...b.campaign, link: null } });
    expect(strip(fromApi)).toEqual(strip(fromDashboard));
  });

  it("works with no campaign, and says when the receiver fails and the lead will be retried or was refused", async () => {
    await w.lead_webhook();
    w.receiver.replies = [502, 401];
    const retried = await (await send({ email: "owner@example.org" })).json<Record<string, unknown>>();
    expect(retried).toMatchObject({ status: "pending", http_status: 502, result: "HTTP 502", reply: "refused with 502", attempts: 1, campaign_id: null });
    expect(retried.next_attempt_at).toBe(new Date(w.clock.now() + RETRY_DELAYS[0]!).toISOString());
    expect(retried.message).toContain("The test lead didn't get through yet (HTTP 502)");
    expect(w.receiver.bodies()[0]).toMatchObject({ campaign: { id: 0, name: "Test" } });
    const refused = await (await send({ email: "owner@example.org" })).json();
    expect(refused).toMatchObject({ status: "failed", http_status: 401, message: "The test lead was refused (HTTP 401) and won't be retried.", next_attempt_at: null });
  });

  it("refuses what the form refuses: no webhook, a bad address, an unknown campaign", async () => {
    let res = await send({ email: "owner@example.org" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Set the webhook's URL and secret first.", problem: "no_webhook" });
    await w.lead_webhook();
    res = await send({ email: "not an email" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ problem: "bad_email" });
    expect((await send({})).status).toBe(422);
    expect((await send({ email: "a@example.org, b@example.org" })).status).toBe(422);
    res = await send({ email: "owner@example.org", campaign_id: 999 });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ problem: "no_campaign" });
    expect((await send({ email: "owner@example.org", campaign_id: "abc" })).status).toBe(400);
    expect((await send({ email: 5 })).status).toBe(400);
    expect(w.receiver.received).toHaveLength(0);
  });

  it("needs the write token", async () => {
    await w.lead_webhook();
    expect((await send({ email: "owner@example.org" }, { "content-type": "application/json" })).status).toBe(401);
    const page = await (await w.fetch("/dashboard/settings/api-token", form(cookie, { do: "new" }))).text();
    const read = { authorization: `Bearer ${page.match(/oc_[A-Za-z0-9_-]+/)![0]}`, "content-type": "application/json" };
    expect((await send({ email: "owner@example.org" }, read)).status).toBe(401);
    expect(w.receiver.received).toHaveLength(0);
    const index = await (await w.fetch("/api", { headers: { authorization: read.authorization } })).json<{ endpoints: Record<string, string> }>();
    expect(index.endpoints["POST /api/test-lead"]).toBeDefined();
  });
});
