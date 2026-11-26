import type { Env } from "./env";

/**
 * Optional sign-in through Cloudflare Access (README, "Signing in with Cloudflare Access").
 * When ACCESS_TEAM and ACCESS_AUD are set, Access stands in front of the dashboard and every
 * request it lets through carries a token it signed, `Cf-Access-Jwt-Assertion`. The Worker checks
 * that token itself, against the team's public keys, so a page never opens because Access was
 * switched off or a path was left out of it.
 */

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEYS_FOR = 60 * 60 * 1000;
const cache = new Map<string, { keys: Jwk[]; at: number }>();

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function teamKeys(team: string, now: number, fresh: boolean): Promise<Jwk[]> {
  const hit = cache.get(team);
  if (hit && !fresh && now - hit.at < KEYS_FOR) return hit.keys;
  try {
    const res = await fetch(`${team}/cdn-cgi/access/certs`);
    if (!res.ok) return hit?.keys ?? [];
    const keys = ((await res.json()) as { keys?: Jwk[] }).keys ?? [];
    cache.set(team, { keys, at: now });
    return keys;
  } catch {
    return hit?.keys ?? [];
  }
}

/** True when both settings are there: the page then opens only through Access, with no password page. */
export function accessIsOn(env: Env): boolean {
  return Boolean(env.ACCESS_TEAM && env.ACCESS_AUD);
}

/** True when the request carries a valid Access token for this app. Never logs or returns who it is. */
export async function throughAccess(env: Env, request: Request, now: number): Promise<boolean> {
  const team = (env.ACCESS_TEAM ?? "").replace(/\/+$/, "");
  const aud = env.ACCESS_AUD ?? "";
  const token = request.headers.get("cf-access-jwt-assertion") ?? "";
  if (!team || !aud || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [h, p, s] = parts as [string, string, string];
  const header = b64urlJson(h);
  const claims = b64urlJson(p);
  if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return false;

  let key = (await teamKeys(team, now, false)).find((k) => k.kid === header.kid);
  // A key rotated since the keys were read: read them again once.
  if (!key) key = (await teamKeys(team, now, true)).find((k) => k.kid === header.kid);
  if (!key) return false;

  try {
    const cryptoKey = await crypto.subtle.importKey("jwk", { kty: key.kty, n: key.n, e: key.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`)))) return false;
  } catch {
    return false;
  }

  const seconds = now / 1000;
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!auds.includes(aud)) return false;
  if (claims.iss !== team) return false;
  if (typeof claims.exp !== "number" || claims.exp < seconds) return false;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 60) return false;
  return true;
}

/** Access's own sign-out, which ends the session on every app behind it. */
export const ACCESS_LOGOUT = "/cdn-cgi/access/logout";

export function notThroughAccess(): Response {
  return new Response("This page opens only through this OwnChats' Cloudflare Access sign-in.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
