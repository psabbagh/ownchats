import type { Ctx } from "./context";
import { safeEqual, sha256Hex, signValue, verifySigned } from "./crypto";
import { html, page, redirect } from "./pages/html";
import { DAY, MINUTE } from "./time";

const COOKIE = "ownchats_session";
const SESSION_LENGTH = 30 * DAY;
const MAX_FAILURES = 10;
const FAILURE_WINDOW = 15 * MINUTE;

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** True if the request carries a valid admin session. */
export async function isAdmin(ctx: Ctx, request: Request): Promise<boolean> {
  const password = ctx.env.ADMIN_PASSWORD;
  const cookie = cookieValue(request, COOKIE);
  if (!password || !cookie) return false;
  const value = await verifySigned(password, cookie);
  return value !== null && Number(value) > ctx.now();
}

/** Same-origin check for form posts, on top of the SameSite=Lax cookie. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function loginPage(message = "", next = "/dashboard"): Response {
  return page(
    "Sign in to OwnChats",
    html`<h1>Sign in</h1>
      ${message ? html`<div class="card errors">${message}</div>` : ""}
      <form method="post" action="/login" class="card">
        <input type="hidden" name="next" value="${next}">
        <label for="password">Admin password</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
        <p class="hint">The password you chose on the Deploy to Cloudflare screen (the ADMIN_PASSWORD secret).</p>
        <p><button>Sign in</button></p>
      </form>`,
  );
}

export function noPasswordPage(): Response {
  return page(
    "OwnChats needs an admin password",
    html`<h1>Set an admin password first</h1>
      <div class="card notice">
        <p>This OwnChats has no admin password yet, so nobody can sign in.</p>
        <ol>
          <li>Open your Cloudflare dashboard, then <b>Workers &amp; Pages</b>, then this Worker.</li>
          <li>Go to <b>Settings</b>, then <b>Variables and Secrets</b>, and add a secret named <code>ADMIN_PASSWORD</code>. Use a long password you keep in a password manager.</li>
          <li>Deploy, then reload this page.</li>
        </ol>
      </div>`,
  );
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

export async function handleLogin(ctx: Ctx, request: Request): Promise<Response> {
  const password = ctx.env.ADMIN_PASSWORD;
  if (!password) return noPasswordPage();
  const form = await request.formData();
  const next = String(form.get("next") ?? "/dashboard");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  const ip = clientIp(request);
  const failures = await ctx.db
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND at > ?")
    .bind(ip, ctx.now() - FAILURE_WINDOW)
    .first<{ n: number }>();
  if ((failures?.n ?? 0) >= MAX_FAILURES) {
    return new Response("Too many wrong passwords. Wait 15 minutes and try again.", { status: 429 });
  }
  if (!safeEqual(String(form.get("password") ?? ""), password)) {
    await ctx.db.prepare("INSERT INTO login_attempts (ip, at) VALUES (?, ?)").bind(ip, ctx.now()).run();
    const res = loginPage("That password is not right.", safeNext);
    return new Response(res.body, { status: 401, headers: res.headers });
  }
  const session = await signValue(password, String(ctx.now() + SESSION_LENGTH));
  return redirect(safeNext, {
    "set-cookie": `${COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_LENGTH / 1000}`,
  });
}

export function handleLogout(): Response {
  return redirect("/login", { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

/**
 * Bearer tokens for /api, each stored as a SHA-256 hash. The read token reads; the
 * write token (`ocw_...`) creates campaigns and checks captions, and reads nothing.
 * Two tokens, so a tool that only reads can never change what DMs go out, and the
 * agent that sets up campaigns never holds a token that reads leads.
 */
export async function apiAuthorized(ctx: Ctx, request: Request, scope: "read" | "write" = "read"): Promise<boolean> {
  const stored = scope === "write" ? ctx.settings.api_write_token_hash : ctx.settings.api_token_hash;
  const header = request.headers.get("authorization") ?? "";
  if (!stored || !header.startsWith("Bearer ")) return false;
  return safeEqual(await sha256Hex(header.slice(7).trim()), stored);
}
