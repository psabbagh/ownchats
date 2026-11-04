import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { saveSettings } from "../src/settings";
import { BASE, FAN, OWNER, setupWorld, VERIFY_TOKEN } from "./helpers";

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

  it("create a campaign from the form, and explain mistakes", async () => {
    const cookie = await w.signIn();
    const bad = await w.fetch("/dashboard/campaigns/new", form(cookie, { name: "", keywords: "", link_url: "not a link", media_id: "all" }));
    const text = await bad.text();
    expect(text).toContain("Give the campaign a name.");
    expect(text).toContain("full web address");
    const ok = await w.fetch(
      "/dashboard/campaigns/new",
      form(cookie, { name: "Prompts", keywords: "PROMPTS, PROMPT", media_id: "all", link_url: "https://example.com/p", link_text: "Here:", public_replies: "a\nb", active: "on", dm_keyword: "on" }),
    );
    expect(ok.status).toBe(303);
    const row = await env.DB.prepare("SELECT keywords, media_id, public_replies FROM campaigns").first();
    expect(row).toEqual({ keywords: '["PROMPTS","PROMPT"]', media_id: null, public_replies: '["a","b"]' });
  });

  it("refuse cross-site form posts", async () => {
    const cookie = await w.signIn();
    const res = await w.fetch("/dashboard/settings/export", { ...form(cookie, { do: "new" }), headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(403);
  });

  it("delete everything about a person on request", async () => {
    const id = await w.campaign({ askEmail: true, openingButton: "" });
    await w.sendComment(w.comment("agents", FAN));
    await w.sendDm(FAN.id, "fan@example.com");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first()).toMatchObject({ n: 1 });
    const cookie = await w.signIn();
    await w.fetch("/dashboard/people/delete", form(cookie, { username: `@${FAN.username}` }));
    for (const table of ["leads", "conversations", "comments"]) {
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first(), table).toMatchObject({ n: 0 });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM activity WHERE ig_user_id = ?").bind(FAN.id).first()).toMatchObject({ n: 0 });
    expect(id).toBeGreaterThan(0);
  });
});

describe("Google Sheets link", () => {
  it("serves the CSV only with the current secret, and stops after it is turned off", async () => {
    await w.campaign({ askEmail: true, openingButton: "" });
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
