import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULTS, saveCampaign, type CampaignInput } from "../src/campaigns";
import { buildCtx } from "../src/context";
import { hmacSha256Hex } from "../src/crypto";
import { createApp } from "../src/index";
import type { IgComment, OutMessage } from "../src/meta/client";
import { saveSettings } from "../src/settings";
import { HOUR } from "../src/time";
import { FakeMeta } from "./fake-meta";

// Everything here is invented: ids, names, secrets.
export const OWNER = { id: "17841400000000001", username: "test_creator" };
export const APP_SECRET = "test-app-secret-not-real";
export const VERIFY_TOKEN = "test-verify-token";
export const BASE = "https://ownchats.example.workers.dev";
export const WEBHOOK_SECRET = "test-webhook-secret-not-real-0123456789";
export const REEL = "18000000000000001";
export const OTHER_POST = "18000000000000002";

export class Clock {
  t = Date.parse("2026-11-04T12:00:00Z");
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const TABLES = ["settings", "campaigns", "comments", "conversations", "leads", "inbound", "activity", "login_attempts", "media_stats", "deliveries", "tracked_links", "account_days"];

/** The default email lines. */
export const EMAIL_LINES = { emailPrompt: DEFAULTS.emailPrompt, optionalPrompt: DEFAULTS.optionalPrompt };

export interface Received {
  url: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

/**
 * Stands in for the owner's webhook receiver: records every request OwnChats
 * makes and answers with the replies queued in `replies` (200 when none is).
 */
export class FakeReceiver {
  received: Received[] = [];
  replies: Array<number | "timeout" | "offline"> = [];
  constructor(private readonly now: () => number) {}
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const body = await req.text();
    this.received.push({ url: req.url, headers: Object.fromEntries(req.headers), body, at: this.now() });
    const next = this.replies.shift() ?? 200;
    if (next === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    if (next === "offline") throw new TypeError("Network connection lost.");
    return new Response(next >= 200 && next < 300 ? "ok" : `refused with ${next}`, { status: next });
  };
  /** The parsed bodies, in order. */
  bodies(): Array<Record<string, any>> {
    return this.received.map((r) => JSON.parse(r.body) as Record<string, any>);
  }
}

export async function setupWorld(opts: { connected?: boolean } = {}) {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const clock = new Clock();
  const meta = new FakeMeta(clock.now);
  meta.account = OWNER;
  const receiver = new FakeReceiver(clock.now);
  const base = { meta_app_id: "1000000000000001", meta_app_secret: APP_SECRET, meta_config_id: "2000000000000001", verify_token: VERIFY_TOKEN, base_url: BASE };
  await saveSettings(
    env.DB,
    env.ADMIN_PASSWORD,
    opts.connected === false ? base : { ...base, access_token: "test-access-token", ig_user_id: OWNER.id, ig_username: OWNER.username },
  );
  // Public reply picks are random in production; here they follow a fixed sequence.
  let r = 0;
  const random = () => [0.1, 0.6, 0.3, 0.9, 0.5][r++ % 5]!;
  const options = { meta: (_e: unknown, s: { access_token?: string }) => (s.access_token ? meta : null), now: clock.now, random, fetch: receiver.fetch as typeof fetch };
  const app = createApp(options);
  let seq = 0;

  const world = {
    clock,
    meta,
    receiver,
    app,
    ctx: () => buildCtx(env, options),

    /** A campaign created an hour before "now", so new comments count. */
    async campaign(overrides: Partial<CampaignInput> = {}): Promise<number> {
      const input: CampaignInput = {
        name: "Agents library",
        videoId: "",
        keywords: ["AGENTS", "AGENT"],
        anyComment: false,
        mediaId: REEL,
        mediaLabel: "Test reel",
        nextPostAfter: null,
        publicReplies: DEFAULTS.publicReplies,
        openingText: DEFAULTS.openingText,
        openingButton: DEFAULTS.openingButton,
        emailMode: "none",
        emailPrompt: EMAIL_LINES.emailPrompt,
        emailReask: DEFAULTS.emailReask,
        emailThanks: DEFAULTS.emailThanks,
        optionalPrompt: EMAIL_LINES.optionalPrompt,
        optionalThanks: DEFAULTS.optionalThanks,
        optionalThanksButton: DEFAULTS.optionalThanksButton,
        consentText: "",
        emailTag: "",
        linkText: DEFAULTS.linkText,
        links: [{ label: DEFAULTS.linkLabel, url: "https://example.com/library" }],
        linkTitle: "",
        followCheck: false,
        followPrompt: DEFAULTS.followPrompt,
        followReask: DEFAULTS.followReask,
        followButton: DEFAULTS.followButton,
        dmKeyword: true,
        active: true,
        ...overrides,
      };
      return saveCampaign(env.DB, input, null, clock.now() - HOUR);
    },

    /** A comment Meta knows about (so it can be private-replied), written `ago` ms before now. */
    comment(text: string, from: { id: string; username: string }, opts: { media?: string; ago?: number; parentId?: string } = {}): IgComment {
      seq++;
      return meta.addComment({
        id: `17900000000000${String(seq).padStart(3, "0")}`,
        mediaId: opts.media ?? REEL,
        text,
        timestamp: clock.now() - (opts.ago ?? 0),
        fromId: from.id,
        fromUsername: from.username,
        parentId: opts.parentId,
      });
    },

    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      const execution = createExecutionContext();
      const res = await app.fetch!(new Request(`${BASE}${path}`, init) as Request<unknown, IncomingRequestCfProperties>, env, execution);
      await waitOnExecutionContext(execution);
      return res;
    },

    /** Delivers a signed webhook and waits for the work after the 200. */
    async webhook(payload: unknown, secret = APP_SECRET): Promise<Response> {
      const body = JSON.stringify(payload);
      return world.fetch("/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmacSha256Hex(secret, body)}` },
        body,
      });
    },

    async sendComment(c: IgComment): Promise<Response> {
      return world.webhook({
        object: "instagram",
        entry: [
          {
            id: OWNER.id,
            time: Math.floor(c.timestamp / 1000),
            changes: [
              {
                field: "comments",
                value: { from: { id: c.fromId, username: c.fromUsername }, media: { id: c.mediaId, media_product_type: "REELS" }, id: c.id, parent_id: c.parentId, text: c.text },
              },
            ],
          },
        ],
      });
    },

    /** The person sends a DM (or taps a button) at `at`, default now. Meta then opens its 24-hour window. */
    async sendDm(senderId: string, text: string, at = clock.now()): Promise<Response> {
      meta.personActed(senderId, at);
      seq++;
      return world.webhook({
        object: "instagram",
        entry: [{ id: OWNER.id, time: at, messaging: [{ sender: { id: senderId }, recipient: { id: OWNER.id }, timestamp: at, message: { mid: `mid.dm.${seq}`, text } }] }],
      });
    },

    async tap(senderId: string, payload: string, at = clock.now()): Promise<Response> {
      meta.personActed(senderId, at);
      seq++;
      return world.webhook({
        object: "instagram",
        entry: [
          { id: OWNER.id, time: at, messaging: [{ sender: { id: senderId }, recipient: { id: OWNER.id }, timestamp: at, postback: { mid: `mid.pb.${seq}`, title: "Send me the link", payload } }] },
        ],
      });
    },

    /**
     * The person opens the link in the last message they got that carries one, in
     * Instagram's in-app browser. Does nothing when it isn't a /go/ link.
     */
    async openLink(igUserId: string): Promise<void> {
      const urls = meta
        .sentTo(igUserId)
        .flatMap((s) => (typeof s.message === "string" ? [] : s.message.kind === "buttons" ? s.message.buttons.flatMap((b) => (b.type === "web_url" ? [b.url] : [])) : s.message.text.split("\n")))
        .filter((u) => u.startsWith(`${BASE}/go/`));
      const url = urls.at(-1);
      if (!url) return;
      await world.fetch(new URL(url).pathname, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 400.0.0.27.92" }, redirect: "manual" });
    },

    /** Where a /go/ link leads, read from the database without counting a click; any other URL as it is. */
    async realUrl(url: string): Promise<string> {
      const m = url.match(/^https:\/\/ownchats\.example\.workers\.dev\/go\/([A-Za-z0-9_-]+)$/);
      if (!m) return url;
      const row = await env.DB.prepare("SELECT url FROM tracked_links WHERE id = ?").bind(m[1]).first<{ url: string }>();
      return row?.url ?? `(unknown link ${m[1]})`;
    },

    /** A sent message with each /go/ link replaced by where it leads. */
    async unwrap(message: OutMessage | string): Promise<OutMessage | string> {
      if (typeof message === "string") return message;
      if (message.kind === "buttons") {
        const buttons = [];
        for (const b of message.buttons) buttons.push(b.type === "web_url" ? { ...b, url: await world.realUrl(b.url) } : b);
        return { ...message, buttons };
      }
      const lines = [];
      for (const line of message.text.split("\n")) lines.push(await world.realUrl(line));
      return { kind: "text", text: lines.join("\n") };
    },

    /** Sets up the lead webhook, as the owner would in Settings. */
    async lead_webhook(url = "https://hooks.example.net/ownchats", secret = WEBHOOK_SECRET): Promise<void> {
      await saveSettings(env.DB, env.ADMIN_PASSWORD, { lead_webhook_url: url, lead_webhook_secret: secret });
    },

    async cron(): Promise<void> {
      const execution = createExecutionContext();
      await app.scheduled!(createScheduledController({ scheduledTime: clock.now(), cron: "* * * * *" }), env, execution);
      await waitOnExecutionContext(execution);
    },

    async activity(): Promise<Array<{ kind: string; outcome: string; reason: string | null; comment_id: string | null }>> {
      const { results } = await env.DB.prepare("SELECT kind, outcome, reason, comment_id FROM activity ORDER BY id").all<{
        kind: string;
        outcome: string;
        reason: string | null;
        comment_id: string | null;
      }>();
      return results;
    },

    async signIn(): Promise<string> {
      const res = await world.fetch("/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
        body: new URLSearchParams({ password: env.ADMIN_PASSWORD, next: "/dashboard" }),
      });
      const cookie = res.headers.get("set-cookie") ?? "";
      return cookie.split(";")[0]!;
    },
  };
  return world;
}

export const FAN = { id: "900000000000001", username: "invented_fan" };
export const FAN2 = { id: "900000000000002", username: "another_invented_fan" };
