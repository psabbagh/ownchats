import type { Ctx } from "./context";
import { hmacSha256Hex, safeEqual } from "./crypto";
import type { IgComment } from "./meta/client";
import { receiveComments } from "./pipeline/comments";
import { handleInbound, type InboundEvent } from "./pipeline/messages";
import { saveSettings } from "./settings";

/** Meta's verification handshake: echo hub.challenge, as plain text, if the token matches. */
export async function verifyWebhook(ctx: Ctx, url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const expected = ctx.settings.verify_token;
  if (mode !== "subscribe" || !expected || !safeEqual(token, expected)) {
    return new Response("Verify token does not match. Copy it again from /setup.", { status: 403 });
  }
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { webhook_verified_at: String(ctx.now()) });
  return new Response(challenge, { headers: { "content-type": "text/plain" } });
}

/** Checks X-Hub-Signature-256: an HMAC of the raw body with the app secret. */
export async function signatureValid(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  return safeEqual(header.slice(7), await hmacSha256Hex(secret, body));
}

/**
 * Receives an event delivery. The signature is checked before anything is read.
 * Returns the work to finish after Meta gets its 200, which Meta wants fast.
 */
export async function receiveWebhook(ctx: Ctx, request: Request): Promise<{ response: Response; work?: Promise<void> }> {
  const body = await request.text();
  const secret = ctx.settings.meta_app_secret;
  if (!secret || !(await signatureValid(secret, body, request.headers.get("x-hub-signature-256")))) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
      last_webhook_problem: `${ctx.now()}|${secret ? "signature did not match the app secret" : "app secret not entered yet"}`,
    });
    return { response: new Response("Bad signature", { status: 403 }) };
  }
  let payload: WebhookPayload;
  try {
    payload = JSON.parse(body) as WebhookPayload;
  } catch {
    return { response: new Response("Bad JSON", { status: 400 }) };
  }
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { last_webhook_at: String(ctx.now()) });
  return { response: new Response("OK"), work: processPayload(ctx, payload) };
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    changes?: Array<{ field?: string; value?: CommentValue & MessagingEvent }>;
    messaging?: MessagingEvent[];
  }>;
}

interface CommentValue {
  id?: string;
  /** Unified Login's example payload names the id comment_id. */
  comment_id?: string;
  text?: string;
  parent_id?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
}

interface MessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
  postback?: { mid?: string; title?: string; payload?: string };
}

/** Meta sends seconds in some places and milliseconds in others. */
function toMs(t: number | undefined, fallback: number): number {
  if (!t) return fallback;
  return t < 1e12 ? t * 1000 : t;
}

export function parsePayload(payload: WebhookPayload, now: number): { comments: IgComment[]; events: InboundEvent[] } {
  const comments: IgComment[] = [];
  const events: InboundEvent[] = [];
  if (payload.object !== "instagram") return { comments, events };
  for (const entry of payload.entry ?? []) {
    // Real DMs arrive in `messaging`; the dashboard's Test button sends them in `changes`.
    const messaging = [...(entry.messaging ?? [])];
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if ((change.field === "messages" || change.field === "messaging_postbacks") && v?.sender) messaging.push(v);
      const id = v?.id ?? v?.comment_id;
      if (change.field !== "comments" || !id || !v?.media?.id) continue;
      comments.push({
        id,
        mediaId: v.media.id,
        text: v.text ?? "",
        timestamp: toMs(entry.time, now),
        fromId: v.from?.id,
        fromUsername: v.from?.username,
        parentId: v.parent_id,
      });
    }
    for (const m of messaging) {
      const senderId = m.sender?.id;
      if (!senderId) continue;
      const timestamp = toMs(m.timestamp, now);
      if (m.postback?.mid || m.postback?.payload) {
        events.push({
          mid: m.postback.mid ?? `postback:${senderId}:${timestamp}`,
          senderId,
          timestamp,
          postbackPayload: m.postback.payload,
          text: m.postback.title,
        });
      } else if (m.message?.mid && !m.message.is_deleted) {
        events.push({ mid: m.message.mid, senderId, timestamp, text: m.message.text, isEcho: m.message.is_echo });
      }
    }
  }
  return { comments, events };
}

export async function processPayload(ctx: Ctx, payload: WebhookPayload): Promise<void> {
  const { comments, events } = parsePayload(payload, ctx.now());
  if (comments.length) await receiveComments(ctx, comments, "webhook");
  for (const ev of events) await handleInbound(ctx, ev);
}
