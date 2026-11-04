const enc = new TextEncoder();
const dec = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random URL-safe token. 24 bytes gives 192 bits. */
export function randomToken(bytes = 24): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant-time string comparison (it reveals only whether the lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// Keys derived from ADMIN_PASSWORD with HKDF, one per purpose. HKDF is cheap,
// which matters on the Workers free plan (10 ms of CPU per request).
const keyCache = new Map<string, Promise<CryptoKey>>();

async function baseKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(password), "HKDF", false, ["deriveKey"]);
}

function derive(password: string, purpose: "encrypt" | "sign"): Promise<CryptoKey> {
  const cacheKey = `${purpose}:${password}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = baseKey(password).then((base) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: enc.encode("ownchats-v1"), info: enc.encode(purpose) },
        base,
        purpose === "encrypt" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        purpose === "encrypt" ? ["encrypt", "decrypt"] : ["sign", "verify"],
      ),
    );
    keyCache.set(cacheKey, key);
  }
  return key;
}

export async function encryptText(password: string, plaintext: string): Promise<string> {
  const key = await derive(password, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ct))}`;
}

/** Returns null when the value cannot be decrypted, for example after the admin password changed. */
export async function decryptText(password: string, sealed: string): Promise<string | null> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) return null;
  try {
    const key = await derive(password, "encrypt");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** Signs a short value (session expiry, OAuth state) with a key derived from the admin password. */
export async function signValue(password: string, value: string): Promise<string> {
  const key = await derive(password, "sign");
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return `${value}.${toBase64Url(new Uint8Array(sig))}`;
}

/** Returns the value if the signature is valid, otherwise null. */
export async function verifySigned(password: string, signed: string): Promise<string | null> {
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  try {
    const key = await derive(password, "sign");
    const ok = await crypto.subtle.verify("HMAC", key, fromBase64Url(signed.slice(i + 1)), enc.encode(value));
    return ok ? value : null;
  } catch {
    return null;
  }
}
