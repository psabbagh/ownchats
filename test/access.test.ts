import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { BASE, setupWorld, VERIFY_TOKEN } from "./helpers";

// An invented Access team, app and key pair: nothing here is real.
const AUD = "test-aud-0000";
let keys: CryptoKeyPair;
let other: CryptoKeyPair;
let jwk: JsonWebKey;
let certsRead = 0;

function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let s = "";
  for (const c of b) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(team: string, claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify({ aud: [AUD], iss: team, email: "owner@example.com", iat: now, exp: now + 3600, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

// Each test gets its own team address, so the keys cached for one never serve another.
let n = 0;
let team = "";

function envWith(overrides: Partial<Env> = {}): Env {
  return { ...(env as unknown as Env), ACCESS_TEAM: team, ACCESS_AUD: AUD, ...overrides };
}

async function open(app: ExportedHandler<Env>, path: string, init: RequestInit = {}, withEnv = envWith()): Promise<Response> {
  const execution = createExecutionContext();
  const res = await app.fetch!(new Request(`${BASE}${path}`, { redirect: "manual", ...init }) as Request<unknown, IncomingRequestCfProperties>, withEnv, execution);
  await waitOnExecutionContext(execution);
  return res;
}

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  keys = await gen();
  other = await gen();
  jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
});

beforeEach(() => {
  team = `https://team-${++n}.example.cloudflareaccess.com`;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${team}/cdn-cgi/access/certs`) {
      certsRead++;
      return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
    }
    return new Response("unexpected call", { status: 500 });
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("behind Cloudflare Access", () => {
  it("opens the dashboard with Access's signed token, with no password page", async () => {
    const w = await setupWorld();
    const res = await open(w.app, "/dashboard", { headers: { "cf-access-jwt-assertion": await token(team, {}) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sign out");
    expect(html).not.toContain('type="password"');
  });

  it("refuses a page without a token, instead of offering the password", async () => {
    const w = await setupWorld();
    for (const path of ["/", "/dashboard", "/setup", "/setup/callback", "/dashboard/leads.csv", "/login"]) {
      const res = await open(w.app, path);
      expect(res.status, path).toBe(403);
      expect(await res.text()).not.toContain('type="password"');
    }
    expect((await open(w.app, "/login", { method: "POST", body: new URLSearchParams({ password: "test-admin-password-123" }) })).status).toBe(403);
  });

  it("ignores the old session cookie: only Access's token opens a page", async () => {
    const w = await setupWorld();
    const cookie = await w.signIn();
    expect((await open(w.app, "/dashboard", { headers: { cookie } })).status).toBe(403);
  });

  it("refuses a token signed by another key, for another app, from another team, expired or unknown", async () => {
    const w = await setupWorld();
    const bad = [
      await token(team, {}, { key: other.privateKey }),
      await token(team, { aud: ["another-app"] }),
      await token("https://elsewhere.example.cloudflareaccess.com", {}),
      await token(team, { exp: Math.floor(Date.now() / 1000) - 10 }),
      await token(team, {}, { kid: "unknown" }),
      "not.a.token",
    ];
    for (const t of bad) expect((await open(w.app, "/dashboard", { headers: { "cf-access-jwt-assertion": t } })).status).toBe(403);
  });

  it("reads the team's keys once, not on every page", async () => {
    const w = await setupWorld();
    const before = certsRead;
    const t = await token(team, {});
    for (let i = 0; i < 3; i++) expect((await open(w.app, "/dashboard", { headers: { "cf-access-jwt-assertion": t } })).status).toBe(200);
    expect(certsRead - before).toBe(1);
  });

  it("sends /login to the dashboard and signs out through Access", async () => {
    const w = await setupWorld();
    const t = await token(team, {});
    expect((await open(w.app, "/login", { headers: { "cf-access-jwt-assertion": t } })).headers.get("location")).toBe("/dashboard");
    const res = await open(w.app, "/logout", { method: "POST" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/cdn-cgi/access/logout");
  });

  it("keeps what answers without signing in as it was", async () => {
    const w = await setupWorld();
    expect(await (await open(w.app, `/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`)).text()).toBe("42");
    expect((await open(w.app, "/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect((await open(w.app, "/go/abcdefgh12")).status).toBe(404);
    for (const path of ["/privacy", "/terms", "/data-deletion", "/health"]) expect((await open(w.app, path)).status, path).toBe(200);
    expect((await open(w.app, "/export/leads.csv")).status).toBe(404);
    expect((await open(w.app, "/api/campaigns")).status).toBe(401);
  });

  it("keeps the password sign-in when either setting is empty", async () => {
    const w = await setupWorld();
    for (const e of [envWith({ ACCESS_TEAM: "" }), envWith({ ACCESS_AUD: "" })]) {
      const res = await open(w.app, "/login", {}, e);
      expect(await res.text()).toContain('type="password"');
    }
  });
});
