import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { DEFAULTS, saveCampaign, type CampaignInput } from "../src/campaigns";
import { buildCtx } from "../src/context";
import { hmacSha256Hex } from "../src/crypto";
import { createApp } from "../src/index";
import type { IgComment } from "../src/meta/client";
import { saveSettings } from "../src/settings";
import { HOUR } from "../src/time";
import { FakeMeta } from "./fake-meta";

// Everything here is invented: ids, names, secrets.
export const OWNER = { id: "17841400000000001", username: "test_creator" };
export const APP_SECRET = "test-app-secret-not-real";
export const VERIFY_TOKEN = "test-verify-token";
export const BASE = "https://ownchats.example.workers.dev";
export const REEL = "18000000000000001";
export const OTHER_POST = "18000000000000002";

export class Clock {
  t = Date.parse("2026-11-04T12:00:00Z");
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

const TABLES = ["settings", "campaigns", "comments", "conversations", "leads", "inbound", "activity", "login_attempts"];

export async function setupWorld(opts: { connected?: boolean } = {}) {
  await env.DB.batch(TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const clock = new Clock();
  const meta = new FakeMeta(clock.now);
  meta.account = OWNER;
  const base = { meta_app_id: "1000000000000001", meta_app_secret: APP_SECRET, meta_config_id: "2000000000000001", verify_token: VERIFY_TOKEN, base_url: BASE };
  await saveSettings(
    env.DB,
    env.ADMIN_PASSWORD,
    opts.connected === false ? base : { ...base, access_token: "test-access-token", ig_user_id: OWNER.id, ig_username: OWNER.username },
  );
  // Public reply picks are random in production; here they follow a fixed sequence.
  let r = 0;
  const random = () => [0.1, 0.6, 0.3, 0.9, 0.5][r++ % 5]!;
  const options = { meta: (_e: unknown, s: { access_token?: string }) => (s.access_token ? meta : null), now: clock.now, random };
  const app = createApp(options);
  let seq = 0;

  const world = {
    clock,
    meta,
    app,
    ctx: () => buildCtx(env, options),

    /** A campaign created an hour before "now", so new comments count. */
    async campaign(overrides: Partial<CampaignInput> = {}): Promise<number> {
      const input: CampaignInput = {
        name: "Agents library",
        keywords: ["AGENTS", "AGENT"],
        anyComment: false,
        mediaId: REEL,
        mediaLabel: "Test reel",
        publicReplies: DEFAULTS.publicReplies,
        openingText: DEFAULTS.openingText,
        openingButton: DEFAULTS.openingButton,
        emailMode: "none",
        emailPrompt: DEFAULTS.emailPrompt,
        emailReask: DEFAULTS.emailReask,
        emailThanks: DEFAULTS.emailThanks,
        optionalPrompt: DEFAULTS.optionalPrompt,
        optionalThanks: DEFAULTS.optionalThanks,
        consentText: "",
        linkText: DEFAULTS.linkText,
        links: [{ label: DEFAULTS.linkLabel, url: "https://example.com/library" }],
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
