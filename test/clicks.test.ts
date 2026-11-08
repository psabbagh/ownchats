import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { OPEN_PAYLOAD_PREFIX } from "../src/campaigns";
import { isPreviewFetch } from "../src/clicks";
import type { OutMessage } from "../src/meta/client";
import { HOUR } from "../src/time";
import { BASE, FAN, FAN2, setupWorld } from "./helpers";

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

// User agents as they arrive. All invented apart from the products' own published formats.
/** Meta's link-preview fetcher: what Instagram uses to draw a link's card in a DM. */
const INSTAGRAM_PREVIEW = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
/** A person tapping the link in Instagram's app, which opens its in-app browser. */
const INSTAGRAM_IN_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.27.92 (iPhone15,3; iOS 18_1; en_US; en; scale=3.00; 1290x2796; 712345678)";
const ANDROID_IN_APP =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 400.0.0.27.92 Android (34/14; 420dpi; 1080x2400; Google/google; Pixel 8; shiba; shiba; en_US; 712345678)";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const PREVIEWS = [
  INSTAGRAM_PREVIEW,
  "facebookexternalhit/1.1;line-poker/1.0",
  "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
  "meta-externalfetcher/1.1",
  // iMessage's link previews
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0",
  "WhatsApp/2.24.20.80 A",
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "TelegramBot (like TwitterBot)",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

const GO_URL = /^https:\/\/ownchats\.example\.workers\.dev\/go\/([A-Za-z0-9_-]{16})$/;

function urlsIn(m: OutMessage | string): string[] {
  if (typeof m === "string") return [];
  if (m.kind === "buttons") return m.buttons.flatMap((b) => (b.type === "web_url" ? [b.url] : []));
  return m.text.split("\n").filter((l) => l.startsWith("https://"));
}

/** A comment and a tap: the person gets the link message. Returns the URLs it carried. */
async function getLinks(w: World, campaign: number, who = FAN): Promise<string[]> {
  await w.sendComment(w.comment("agents", who));
  await w.tap(who.id, `${OPEN_PAYLOAD_PREFIX}${campaign}`);
  return urlsIn(w.meta.sentTo(who.id).at(-1)!.message);
}

const open = (url: string, ua: string | null = INSTAGRAM_IN_APP, method = "GET") =>
  w.fetch(new URL(url).pathname, { method, headers: ua === null ? {} : { "user-agent": ua }, redirect: "manual" });

async function apiToken(): Promise<string> {
  const cookie = await w.signIn();
  const page = await (await w.fetch("/dashboard/settings/api-token", form(cookie, { do: "new" }))).text();
  return page.match(/oc_[A-Za-z0-9_-]+/)![0];
}

async function clicksInApi(token: string) {
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const stats = (await (await w.fetch("/api/stats", auth)).json()) as { totals: { clicks: number } };
  const campaigns = (await (await w.fetch("/api/campaigns", auth)).json()) as { campaigns: Array<{ id: number; counts: { clicks: number } | null }> };
  return { total: stats.totals.clicks, byCampaign: campaigns.campaigns.map((c) => [c.id, c.counts?.clicks ?? 0]) };
}

describe("link clicks", () => {
  it("send each link as a /go/ link with a random id per person and link, carrying nothing that identifies them", async () => {
    const id = await w.campaign({ links: [{ label: "Library", url: "https://example.com/1" }, { label: "Bonus", url: "https://example.com/2" }] });
    const fan = await getLinks(w, id);
    const other = await getLinks(w, id, FAN2);
    for (const url of [...fan, ...other]) {
      expect(url).toMatch(GO_URL);
      for (const secret of [FAN.id, FAN.username, FAN2.id, FAN2.username, "example.com"]) expect(url).not.toContain(secret);
    }
    expect(new Set([...fan, ...other]).size).toBe(4);
    expect(await w.realUrl(fan[0]!)).toBe("https://example.com/1");
    expect(await w.realUrl(fan[1]!)).toBe("https://example.com/2");

    // The same person asking again by DM gets the same links back.
    await w.sendDm(FAN.id, "AGENTS");
    expect(urlsIn(w.meta.sentTo(FAN.id).at(-1)!.message)).toEqual(fan);
  });

  it("track links that go in the text too, and in a first DM with no button", async () => {
    await w.campaign({ openingButton: "", links: [{ label: "", url: "https://example.com/a" }] });
    await w.sendComment(w.comment("agents", FAN));
    const dm = w.meta.sent.find((s) => s.kind === "private_reply")!.message as { kind: "text"; text: string };
    const lines = dm.text.split("\n");
    expect(lines[0]).toBe("Here you go:");
    expect(lines[1]).toMatch(GO_URL);
    expect(await w.realUrl(lines[1]!)).toBe("https://example.com/a");
  });

  it("answer a click with a 302 to the real link, and count each person's first click once", async () => {
    const id = await w.campaign({ links: [{ label: "Library", url: "https://example.com/1" }, { label: "Bonus", url: "https://example.com/2" }] });
    const [first, second] = await getLinks(w, id);
    const res = await open(first!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/1");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    w.clock.advance(HOUR);
    await open(first!, ANDROID_IN_APP);
    await open(second!, DESKTOP);
    const token = await apiToken();
    expect(await clicksInApi(token)).toEqual({ total: 1, byCampaign: [[id, 1]] });

    // A second person.
    const [theirs] = await getLinks(w, id, FAN2);
    await open(theirs!, DESKTOP);
    expect(await clicksInApi(token)).toEqual({ total: 2, byCampaign: [[id, 2]] });

    // The first click on each link is in the log, under the person.
    const { results } = await env.DB.prepare("SELECT reason, ig_user_id, campaign_id FROM activity WHERE kind = 'click' ORDER BY id").all();
    expect(results).toEqual([
      { reason: "first click on link 1", ig_user_id: FAN.id, campaign_id: id },
      { reason: "first click on link 2", ig_user_id: FAN.id, campaign_id: id },
      { reason: "first click on link 1", ig_user_id: FAN2.id, campaign_id: id },
    ]);

    // The dashboard funnel and the campaign page.
    const cookie = await w.signIn();
    expect(await (await w.fetch("/dashboard", { headers: { cookie } })).text()).toContain("<b>2</b>clicked");
    const page = await (await w.fetch(`/dashboard/campaigns/${id}`, { headers: { cookie } })).text();
    expect(page).toContain('<tr><td>Clicked a link</td><td class="num">2 (100%)</td>');
    expect(page).toContain("2 people clicked for the first time");
  });

  it("don't count Instagram's link preview, other previews and crawlers, HEAD requests, or a fetch with no user agent", async () => {
    const id = await w.campaign();
    const [link] = await getLinks(w, id);
    for (const ua of PREVIEWS) {
      const res = await open(link!, ua);
      expect(res.status, ua).toBe(302);
      expect(res.headers.get("location")).toBe("https://example.com/library");
    }
    expect((await open(link!, INSTAGRAM_IN_APP, "HEAD")).status).toBe(302);
    expect((await open(link!, null)).status).toBe(302);
    const token = await apiToken();
    expect(await clicksInApi(token)).toEqual({ total: 0, byCampaign: [[id, 0]] });
    expect(await env.DB.prepare("SELECT first_clicked_at FROM tracked_links").first()).toEqual({ first_clicked_at: null });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'click'").first()).toEqual({ n: 0 });

    // Then the person opens it.
    await open(link!, INSTAGRAM_IN_APP);
    expect(await clicksInApi(token)).toEqual({ total: 1, byCampaign: [[id, 1]] });
  });

  it("tell a person's browser from a preview by its user agent", () => {
    for (const ua of PREVIEWS) expect(isPreviewFetch(ua), ua).toBe(true);
    for (const ua of [INSTAGRAM_IN_APP, ANDROID_IN_APP, DESKTOP]) expect(isPreviewFetch(ua), ua).toBe(false);
    expect(isPreviewFetch(null)).toBe(true);
    expect(isPreviewFetch("  ")).toBe(true);
  });

  it("answer an unknown link with a 404, and refuse other methods", async () => {
    expect((await w.fetch("/go/AAAAAAAAAAAAAAAA", { headers: { "user-agent": DESKTOP } })).status).toBe(404);
    const id = await w.campaign();
    const [link] = await getLinks(w, id);
    expect((await open(link!, DESKTOP, "POST")).status).toBe(405);
  });

  it("send the real links once counting is off, and keep the links already sent working", async () => {
    const id = await w.campaign();
    const [before] = await getLinks(w, id);
    const cookie = await w.signIn();
    await w.fetch("/dashboard/settings/clicks", form(cookie, { do: "off" }));
    const [after] = await getLinks(w, id, FAN2);
    expect(after).toBe("https://example.com/library");
    expect((await open(before!)).headers.get("location")).toBe("https://example.com/library");
    // Off means off: that click counted nowhere, and the dashboard shows no click count.
    expect(await env.DB.prepare("SELECT first_clicked_at FROM tracked_links").first()).toEqual({ first_clicked_at: null });
    expect(await (await w.fetch("/dashboard", { headers: { cookie } })).text()).not.toContain("clicked</div>");
    await w.fetch("/dashboard/settings/clicks", form(cookie, { do: "on" }));
    const [again] = await getLinks(w, id, { id: "900000000000003", username: "third_invented_fan" });
    expect(again).toMatch(GO_URL);
  });

  it("forget a person's links when their data is deleted, and keep a deleted campaign's links working", async () => {
    const id = await w.campaign({ emailMode: "optional" });
    const [fanLink] = await getLinks(w, id);
    const [otherLink] = await getLinks(w, id, FAN2);
    await open(fanLink!);
    const cookie = await w.signIn();
    await w.fetch("/dashboard/people/delete", form(cookie, { ig_user_id: FAN.id }));
    expect((await open(fanLink!)).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_links").first()).toEqual({ n: 1 });

    await w.fetch(`/dashboard/campaigns/${id}/delete`, form(cookie, {}));
    const res = await open(otherLink!);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/library");
    expect(await env.DB.prepare("SELECT conversation_id FROM tracked_links").first()).toEqual({ conversation_id: null });
  });

  it("give a failed first DM's links back, so a later conversation never inherits them", async () => {
    await w.campaign({ openingButton: "", links: [{ label: "", url: "https://example.com/a" }] });
    const { MetaError } = await import("../src/meta/client");
    w.meta.failNext("sendPrivateReply", new MetaError("Invalid parameter", 400, 100));
    await w.sendComment(w.comment("agents", FAN));
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tracked_links").first()).toEqual({ n: 0 });
  });
});
