import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveSettings } from "../src/settings";
import { BASE, FAN, FAN2, OWNER, setupWorld, VERIFY_TOKEN } from "./helpers";

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

describe("webhook", () => {
  it("answers Meta's verification handshake with the bare challenge", async () => {
    const res = await w.fetch(`/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("1158201444");
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key = 'webhook_verified_at'").first()).toBeTruthy();
  });

  it("refuses a wrong verify token", async () => {
    const res = await w.fetch("/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1");
    expect(res.status).toBe(403);
  });

  it("refuses a delivery signed with the wrong secret, and says so on /setup", async () => {
    await w.campaign();
    const res = await w.webhook({ object: "instagram", entry: [] }, "some-other-secret");
    expect(res.status).toBe(403);
    const cookie = await w.signIn();
    const page = await (await w.fetch("/setup", { headers: { cookie } })).text();
    expect(page).toContain("signature did not match the app secret");
  });

  it("accepts Unified Login's comment_id key and the dashboard's Test payloads", async () => {
    await w.campaign();
    const c = w.comment("agents", FAN);
    await w.webhook({
      object: "instagram",
      entry: [{ id: OWNER.id, time: Math.floor(c.timestamp / 1000), changes: [{ field: "comments", value: { comment_id: c.id, text: c.text, from: { id: FAN.id, username: FAN.username }, media: { id: c.mediaId } } }] }],
    });
    expect(w.meta.sent.filter((s) => s.kind === "private_reply")).toHaveLength(1);
  });
});

describe("admin pages", () => {
  it("send visitors to sign in", async () => {
    for (const path of ["/dashboard", "/setup", "/dashboard/leads"]) {
      const res = await w.fetch(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/login");
    }
  });

  it("refuse a wrong password, then lock out after repeated failures", async () => {
    const attempt = () =>
      w.fetch("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9" }, body: new URLSearchParams({ password: "nope" }) });
    expect((await attempt()).status).toBe(401);
    for (let i = 0; i < 9; i++) await attempt();
    expect((await attempt()).status).toBe(429);
  });

  it("render the dashboard, setup and campaign form when signed in", async () => {
    const cookie = await w.signIn();
    expect(cookie).toMatch(/^ownchats_session=/);
    await w.campaign();
    for (const path of ["/dashboard", "/setup", "/dashboard/campaigns/new", "/dashboard/leads", "/dashboard/activity", "/dashboard/settings"]) {
      const res = await w.fetch(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).not.toContain("—"); // no em dashes in what people read
    }
  });

  it("start new campaigns, and the setup test campaign, with the DM keyword off", async () => {
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/campaigns/new", { headers: { cookie } })).text();
    expect(page).toMatch(/<input type="checkbox" name="dm_keyword"\s*>/);
    expect(page).not.toMatch(/name="dm_keyword" checked/);
    expect((await w.fetch("/setup/test", form(cookie, { do: "create" }))).status).toBe(303);
    expect(await env.DB.prepare("SELECT dm_keyword FROM campaigns").first()).toEqual({ dm_keyword: 0 });
  });

  it("create a campaign from the form, and explain mistakes", async () => {
    const cookie = await w.signIn();
    const bad = await w.fetch("/dashboard/campaigns/new", form(cookie, { name: "", keywords: "", link_url_0: "not a link", media_id: "all" }));
    const text = await bad.text();
    expect(text).toContain("Give the campaign a name.");
    expect(text).toContain("full web address");
    const ok = await w.fetch(
      "/dashboard/campaigns/new",
      form(cookie, {
        name: "Prompts",
        keywords: "PROMPTS, PROMPT",
        media_id: "all",
        link_text: "Here:",
        link_url_0: "https://example.com/p",
        link_label_0: "Prompts",
        link_url_1: "https://example.com/q",
        link_label_1: "Bonus",
        email_mode: "optional",
        optional_prompt: "Reply with your email for more.",
        public_replies: "a\nb",
        active: "on",
        dm_keyword: "on",
      }),
    );
    expect(ok.status).toBe(303);
    const row = await env.DB.prepare("SELECT keywords, media_id, public_replies, email_mode, links FROM campaigns").first();
    expect(row).toEqual({
      keywords: '["PROMPTS","PROMPT"]',
      media_id: null,
      public_replies: '["a","b"]',
      email_mode: "optional",
      links: '[{"url":"https://example.com/p","label":"Prompts"},{"url":"https://example.com/q","label":"Bonus"}]',
    });
    const mixed = await w.fetch("/dashboard/campaigns/new", form(cookie, { name: "x", keywords: "X", media_id: "all", link_text: "t", link_url_0: "https://example.com/a", link_label_0: "A", link_url_1: "https://example.com/b" }));
    expect(await mixed.text()).toContain("every link a button label, or none");
  });

  it("let browsers send their real Origin on form posts", async () => {
    // With "no-referrer", browsers send "Origin: null" on POSTs and every form would be refused.
    const res = await w.fetch("/login");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("refuse cross-site form posts", async () => {
    const cookie = await w.signIn();
    const res = await w.fetch("/dashboard/settings/export", { ...form(cookie, { do: "new" }), headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(403);
  });

  it("delete everything about a person on request", async () => {
    const id = await w.campaign({ emailMode: "first", openingButton: "" });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "fan@example.com");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 1 });
    const logged = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE ig_user_id = ?").bind(FAN.id).first<{ n: number }>();
    const cookie = await w.signIn();

    // The typed username only shows what it matches: nothing is deleted yet.
    const found = await (await w.fetch("/dashboard/people/delete", form(cookie, { username: `@${FAN.username.toUpperCase()}` }))).text();
    expect(found).toContain(`Delete @${FAN.username}'s data?`);
    expect(found).toContain("<li>1 email: fan@example.com</li>");
    expect(found).toContain("<li>1 conversation</li>");
    expect(found).toContain("<li>1 comment</li>");
    expect(found).toContain(`<li>${logged!.n} log ${logged!.n === 1 ? "entry" : "entries"}</li>`);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 1 });

    // The second click sends back the ids it found.
    const fields = [...found.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]+)">/g)].map((m) => [m[1]!, m[2]!]);
    expect(fields).toContainEqual(["ig_user_id", FAN.id]);
    const done = await w.fetch("/dashboard/people/delete", { ...form(cookie, {}), body: new URLSearchParams(fields) });
    expect(await done.text()).toContain(`Deleted everything stored about @${FAN.username}.`);
    for (const table of ["leads", "conversations"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first(), table).toMatchObject({ n: 0 });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE ig_user_id = ?").bind(FAN.id).first()).toMatchObject({ n: 0 });
    // The comment keeps its id and nothing about the person.
    expect(await env.DB.prepare("SELECT from_id, from_username, text, status, campaign_id FROM comments").all().then((r) => r.results)).toEqual([
      { from_id: null, from_username: null, text: "", status: "skipped", campaign_id: null },
    ]);
    expect(id).toBeGreaterThan(0);
  });

  it("delete nothing for a username that matches nobody, and nothing else about the person searched for", async () => {
    await w.campaign({ emailMode: "first", openingButton: "" });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendComment(w.comment("agents", FAN2));
    const cookie = await w.signIn();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first();

    const typo = await (await w.fetch("/dashboard/people/delete", form(cookie, { username: `@${FAN.username}x` }))).text();
    expect(typo).toContain(`Nobody with the username @${FAN.username}x was found. Nothing was deleted.`);
    const empty = await (await w.fetch("/dashboard/people/delete", form(cookie, { username: " " }))).text();
    expect(empty).toContain("Enter the Instagram username");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM conversations").first()).toEqual(before);

    // Finding one person counts only their data, and lists only their ids.
    const found = await (await w.fetch("/dashboard/people/delete", form(cookie, { username: FAN2.username }))).text();
    expect(found).toContain("<li>0 emails</li>");
    expect(found).toContain("<li>1 conversation</li>");
    expect(found).toContain("<li>1 comment</li>");
    expect(found).not.toContain(FAN.id);
  });

  it("never take a deleted person's old comment for a new one", async () => {
    await w.campaign({ emailMode: "first", openingButton: "" });
    const old = w.comment("agents", FAN);
    await w.sendComment(old);
    await w.sendDm(FAN.id, "fan@example.com");
    const cookie = await w.signIn();
    await w.fetch("/dashboard/people/delete", form(cookie, { ig_user_id: FAN.id }));
    const sent = w.meta.sent.length;

    // The poll reads the comment again, and Meta delivers its webhook again.
    w.meta.calls.length = 0;
    w.clock.advance(5 * 60_000);
    await w.cron();
    expect(w.meta.calls).toContain("listComments");
    await w.sendComment(old);

    expect(w.meta.sent.length).toBe(sent);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE from_id IS NOT NULL OR from_username IS NOT NULL OR text != ''").first()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE ig_user_id = ? OR username = ?").bind(FAN.id, FAN.username).first()).toMatchObject({ n: 0 });

    // A new comment from them is a new request, and gets its answer.
    await w.sendComment(w.comment("agents please", FAN));
    expect(w.meta.sent.filter((s) => s.kind === "private_reply").length).toBe(2);
  });
});

describe("Google Sheets link", () => {
  it("serves the CSV only with the current secret, and stops after it is turned off", async () => {
    await w.campaign({ emailMode: "first", openingButton: "" });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "=cmd@example.com is my address? no: fan@example.com");
    const cookie = await w.signIn();
    expect((await w.fetch("/export/leads.csv")).status).toBe(404);
    await w.fetch("/dashboard/settings/export", form(cookie, { do: "new" }));
    const page = await (await w.fetch("/dashboard/settings", { headers: { cookie } })).text();
    const link = page.match(/IMPORTDATA\(&quot;([^&]+)&quot;\)/)![1]!;
    const csv = await (await w.fetch(link.replace(BASE, ""))).text();
    expect(csv.split("\r\n")[0]).toBe("email,instagram_username,campaign,consented_at,consent_text");
    expect(csv).toContain('"invented_fan"');
    expect((await w.fetch("/export/leads.csv?key=wrong")).status).toBe(404);
    await w.fetch("/dashboard/settings/export", form(cookie, { do: "revoke" }));
    expect((await w.fetch(link.replace(BASE, ""))).status).toBe(404);
  });

  it("neutralises spreadsheet formulas in cells", async () => {
    const { leadsCsv } = await import("../src/export");
    const csv = leadsCsv([{ id: 1, campaign_id: 1, campaign_name: "=HYPERLINK(1)", ig_user_id: "1", username: "u", email: "a@b.co", consent_text: 'say "hi"', consented_at: 0 }]);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
    expect(csv).toContain('"say ""hi"""');
  });
});

describe("time zone", () => {
  it("shows UTC until the owner picks a zone in Settings, then shows every page's times in it", async () => {
    await w.campaign();
    await w.sendComment(w.comment("agents", FAN));
    const cookie = await w.signIn();
    const text = async (path: string) => (await w.fetch(path, { headers: { cookie } })).text();

    expect(await text("/dashboard")).toContain("Times are in UTC");
    expect(await text("/dashboard/activity")).toContain("2026-11-04 12:00 UTC");
    const settings = await text("/dashboard/settings");
    expect(settings).toContain("<option selected>UTC</option>");
    expect(settings).toContain("<option>America/Toronto</option>");

    // A name Intl doesn't know is not saved.
    await w.fetch("/dashboard/settings/time-zone", form(cookie, { time_zone: "Mars/Olympus" }));
    expect(await text("/dashboard/activity")).toContain("2026-11-04 12:00 UTC");

    await w.fetch("/dashboard/settings/time-zone", form(cookie, { time_zone: "America/Toronto" }));
    expect(await text("/dashboard/settings")).toContain("<option selected>America/Toronto</option>");
    const home = await text("/dashboard");
    expect(home).not.toContain("Times are in UTC");
    expect(home).toContain("Started 2026-11-04");
    expect(home).toContain("Last webhook: 2026-11-04 07:00 EST");
    expect(await text("/dashboard/activity")).toContain("2026-11-04 07:00 EST");
  });
});

describe("API", () => {
  it("needs the token, which is shown once and can be revoked", async () => {
    await w.campaign();
    expect((await w.fetch("/api/campaigns")).status).toBe(401);
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings/api-token", form(cookie, { do: "new" }))).text();
    const token = page.match(/oc_[A-Za-z0-9_-]+/)![0];
    const auth = { headers: { authorization: `Bearer ${token}` } };
    const res = await w.fetch("/api/campaigns", auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { campaigns: Array<{ name: string; keywords: string[] }> };
    expect(body.campaigns[0]).toMatchObject({ name: "Agents library", keywords: ["AGENTS", "AGENT"] });
    const stats = (await (await w.fetch("/api/stats", auth)).json()) as { health: { instagram_connected: boolean } };
    expect(stats.health.instagram_connected).toBe(true);
    expect((await w.fetch("/api/leads", { method: "POST", ...auth })).status).toBe(405);
    await w.fetch("/dashboard/settings/api-token", form(cookie, { do: "revoke" }));
    expect((await w.fetch("/api/campaigns", auth)).status).toBe(401);
  });
});

describe("public pages", () => {
  it("serves the privacy, terms and data-deletion pages Meta asks for", async () => {
    await saveSettings(env.DB, env.ADMIN_PASSWORD, { contact: "privacy@example.com" });
    for (const path of ["/privacy", "/terms", "/data-deletion"]) {
      const res = await w.fetch(path);
      expect(res.status, path).toBe(200);
      const body = await res.text();
      expect(body, path).toContain(`@${OWNER.username}`);
      expect(body, path).not.toContain("—");
    }
    expect(await (await w.fetch("/data-deletion")).text()).toContain("privacy@example.com");
  });
});

describe("without a connection", () => {
  it("shows the setup checklist and does nothing on Cron", async () => {
    w = await setupWorld({ connected: false });
    const cookie = await w.signIn();
    const page = await (await w.fetch("/setup", { headers: { cookie } })).text();
    expect(page).toContain(`${BASE}/setup/callback`);
    expect(page).toContain(`${BASE}/webhook`);
    await w.cron();
    expect(w.meta.calls).toHaveLength(0);
  });
});

describe("the Settings forms say when they've saved", () => {
  const SECRET = "a-test-secret-not-real-0123456";
  const note = (word: string) => `role="status">${word}</span>`;

  it.each([
    ["contact", { sender_name: "Sam Lee", sender_address: "PO Box 1, Testville", contact: "" }, "contact", "sender", "Saved"],
    ["time-zone", { time_zone: "America/Toronto" }, "time-zone", "time-zone", "Saved"],
    ["clicks", { do: "off" }, "clicks", "clicks", "Saved"],
    ["export", { do: "new" }, "export", "sheets", "New link made"],
    ["export", { do: "revoke" }, "export-off", "sheets", "Turned off"],
    ["webhook", { do: "save", url: "https://receiver.example/hook", secret: SECRET }, "webhook", "webhook", "Saved"],
    ["webhook", { do: "off" }, "webhook-off", "webhook", "Turned off"],
    ["api-token", { do: "revoke" }, "api-token-off", "api-token", "Revoked"],
  ])("%s with %j", async (path, data, done, card, word) => {
    const cookie = await w.signIn();
    const res = await w.fetch(`/dashboard/settings/${path}`, form(cookie, data as Record<string, string>));
    expect(res.status).toBe(303);
    const location = res.headers.get("location")!;
    expect(location).toBe(`/dashboard/settings?saved=${done}#${card}`);

    const page = await (await w.fetch(location, { headers: { cookie } })).text();
    expect(page.split('id="saved-note"')).toHaveLength(2);
    // In the card of the form that saved, inside that form.
    const inCard = page.slice(page.indexOf(`id="${card}"`));
    const formEnd = inCard.indexOf("</form>", inCard.indexOf('id="saved-note"'));
    expect(inCard.indexOf(note(word))).toBeGreaterThan(0);
    expect(inCard.indexOf(note(word))).toBeLessThan(formEnd);
  });

  it("shows nothing on a plain visit, or for a value it doesn't know", async () => {
    const cookie = await w.signIn();
    const page = async (path: string) => (await w.fetch(path, { headers: { cookie } })).text();
    expect(await page("/dashboard/settings")).not.toContain("saved-note");
    const odd = await page(`/dashboard/settings?saved=${encodeURIComponent("<b>nope</b>")}`);
    expect(odd).not.toContain("saved-note");
    expect(odd).not.toContain("nope");
    expect(await page("/dashboard/settings?saved=constructor")).not.toContain("saved-note");
  });

  it("doesn't say Saved when nothing was", async () => {
    const cookie = await w.signIn();
    const zone = await w.fetch("/dashboard/settings/time-zone", form(cookie, { time_zone: "Mars/Olympus" }));
    expect(zone.headers.get("location")).toBe("/dashboard/settings#time-zone");

    const bad = await w.fetch("/dashboard/settings/webhook", form(cookie, { do: "save", url: "http://not-https.example/hook", secret: SECRET }));
    expect(bad.status).toBe(200);
    expect(await bad.text()).not.toContain("saved-note");
  });

  it("drops the word when the form is edited, and cleans the address", async () => {
    const cookie = await w.signIn();
    const page = await (await w.fetch("/dashboard/settings?saved=contact#sender", { headers: { cookie } })).text();
    expect(page).toContain('addEventListener("input",()=>n.remove(),{once:true})');
    expect(page).toContain('history.replaceState(null,"",location.pathname+location.hash)');
  });
});
