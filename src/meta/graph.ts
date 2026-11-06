import type { Env } from "../env";
import { INSIGHT_METRICS, MetaError, type AccountStats, type IgComment, type Media, type MediaInsights, type MetaClient, type OutMessage, type TokenInfo } from "./client";

/** Pinned so Meta's changes arrive when OwnChats is updated, not by surprise. */
export const GRAPH_VERSION = "v26.0";
export const WEBHOOK_FIELDS = ["comments", "messages", "messaging_postbacks"];
/** Pages read by listMediaSince, at most: callers reserve this many calls. */
export const MEDIA_PAGES = 3;

export function graphBase(env: Env): string {
  return (env.META_GRAPH_BASE ?? "https://graph.facebook.com").replace(/\/+$/, "");
}

/** Facebook Login for Business, with the configuration made in the app dashboard. */
export function loginDialogUrl(appId: string, configId: string, redirectUri: string, state: string): string {
  const u = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
  u.searchParams.set("client_id", appId);
  u.searchParams.set("config_id", configId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("override_default_response_type", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

async function graph<T>(
  base: string,
  path: string,
  opts: { method?: "GET" | "POST"; token?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${base}/${GRAPH_VERSION}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  // The token goes in a header, never in the URL, so it stays out of logs.
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new MetaError(`Unexpected response from Meta: ${text.slice(0, 200)}`, res.status);
  }
  const err = (data as GraphErrorBody).error;
  if (!res.ok || err) {
    throw new MetaError(
      err?.message ?? `Meta answered HTTP ${res.status}`,
      res.status,
      err?.code,
      err?.error_subcode,
      err?.type,
      err?.fbtrace_id,
    );
  }
  return data as T;
}

/** Checks an App ID and secret by asking Meta for the app with an app access token. */
export async function checkApp(base: string, appId: string, appSecret: string): Promise<{ id: string; name?: string }> {
  return graph(base, appId, { token: `${appId}|${appSecret}`, query: { fields: "id,name" } });
}

/** Trades the login code for an access token. */
export async function exchangeCode(base: string, appId: string, appSecret: string, redirectUri: string, code: string): Promise<string> {
  const res = await graph<{ access_token: string }>(base, "oauth/access_token", {
    query: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  });
  return res.access_token;
}

/**
 * Finds the Instagram professional account the login was granted for. On Unified
 * Login, /me is a system user, and the account is listed under
 * assigned_instagram_accounts. Some people get an empty list even though the
 * account works; for them /setup accepts the account id typed in by hand.
 */
export async function findInstagramAccount(base: string, token: string, knownId?: string): Promise<{ id: string; username: string }> {
  if (knownId) {
    const a = await graph<{ id: string; username?: string }>(base, knownId, { token, query: { fields: "id,username" } });
    return { id: a.id, username: a.username ?? knownId };
  }
  const res = await graph<{ data?: Array<{ id: string; username?: string }> }>(base, "me/assigned_instagram_accounts", {
    token,
    query: { fields: "id,username" },
  });
  const a = res.data?.[0];
  if (a?.id) return { id: a.id, username: a.username ?? a.id };
  throw new MetaError(
    "Meta returned no Instagram account for this login. Check that the configuration includes business_management and that the account is in your business portfolio, or enter the account id by hand",
    400,
    100,
    33,
  );
}

function messageJson(m: OutMessage): unknown {
  if (m.kind === "text") return { text: m.text };
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "button",
        text: m.text,
        buttons: m.buttons.map((b) =>
          b.type === "web_url" ? { type: "web_url", url: b.url, title: b.title } : { type: "postback", title: b.title, payload: b.payload },
        ),
      },
    },
  };
}

function ms(timestamp: string | undefined): number {
  const t = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** The real client: the Instagram API with Unified Login, on graph.facebook.com. */
export class GraphMetaClient implements MetaClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
    private readonly igUserId: string,
    private readonly appId: string,
    private readonly appSecret: string,
  ) {}

  private get<T>(path: string, query: Record<string, string> = {}) {
    return graph<T>(this.base, path, { token: this.token, query });
  }
  private post<T>(path: string, body: unknown, query: Record<string, string> = {}) {
    return graph<T>(this.base, path, { method: "POST", token: this.token, body, query });
  }

  async getAccount() {
    const a = await this.get<{ id: string; username: string }>(this.igUserId, { fields: "id,username" });
    return { id: a.id, username: a.username };
  }

  async subscribeWebhooks(fields: string[]) {
    await this.post(`${this.igUserId}/subscribed_apps`, { subscribed_fields: fields.join(",") });
  }

  async getSubscribedFields() {
    const res = await this.get<{ data?: Array<{ subscribed_fields?: string[] }> }>(`${this.igUserId}/subscribed_apps`);
    return res.data?.flatMap((d) => d.subscribed_fields ?? []) ?? [];
  }

  async tokenInfo(): Promise<TokenInfo> {
    const res = await graph<{ data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number; scopes?: string[] } }>(
      this.base,
      "debug_token",
      { token: `${this.appId}|${this.appSecret}`, query: { input_token: this.token } },
    );
    const d = res.data ?? {};
    return {
      valid: !!d.is_valid,
      expiresAt: d.expires_at ? d.expires_at * 1000 : null,
      dataAccessExpiresAt: d.data_access_expires_at ? d.data_access_expires_at * 1000 : null,
      scopes: d.scopes ?? [],
    };
  }

  async listMedia(limit: number): Promise<Media[]> {
    return (await this.mediaPage(limit)).media;
  }

  async listMediaSince(since: number, max: number): Promise<Media[]> {
    const out: Media[] = [];
    let after: string | undefined;
    for (let page = 0; page < MEDIA_PAGES && out.length < max; page++) {
      const { media, next } = await this.mediaPage(Math.min(50, max - out.length), after);
      for (const m of media) {
        if (m.timestamp && m.timestamp < since) return out;
        out.push(m);
      }
      if (!next) break;
      after = next;
    }
    return out;
  }

  async getAccountStats(): Promise<AccountStats> {
    const a = await this.get<{ followers_count?: number; follows_count?: number; media_count?: number }>(this.igUserId, {
      fields: "followers_count,follows_count,media_count",
    });
    return { followers: a.followers_count ?? null, follows: a.follows_count ?? null, mediaCount: a.media_count ?? null };
  }

  private async mediaPage(limit: number, after?: string): Promise<{ media: Media[]; next?: string }> {
    type Row = { id: string; caption?: string; permalink?: string; timestamp?: string; media_product_type?: string; media_type?: string; thumbnail_url?: string; media_url?: string };
    type Page = { data?: Row[]; paging?: { cursors?: { after?: string }; next?: string } };
    const page = (fields: string) => this.get<Page>(`${this.igUserId}/media`, { fields, limit: String(limit), ...(after ? { after } : {}) });
    let res: Page;
    try {
      res = await page("id,caption,permalink,timestamp,media_type,media_product_type,thumbnail_url,media_url");
    } catch (err) {
      // Meta's reference marks caption and media_product_type as Facebook Login only; ask again without them.
      if (!(err instanceof MetaError) || err.code !== 100) throw err;
      res = await page("id,permalink,timestamp,media_type,thumbnail_url,media_url");
    }
    const next = res.paging?.next ? res.paging.cursors?.after : undefined;
    const media = (res.data ?? []).map((m) => ({
      id: m.id,
      caption: m.caption ?? "",
      permalink: m.permalink ?? "",
      timestamp: ms(m.timestamp),
      mediaType: m.media_product_type ?? m.media_type ?? "",
      thumbnailUrl: m.thumbnail_url ?? (m.media_type === "IMAGE" ? m.media_url : undefined),
    }));
    return { media, next };
  }

  async listComments(mediaId: string, after?: string) {
    const query: Record<string, string> = { fields: "id,text,timestamp,username,from{id,username},parent_id", limit: "50" };
    if (after) query.after = after;
    const res = await this.get<{
      data?: Array<{ id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string }; parent_id?: string }>;
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${mediaId}/comments`, query);
    const comments: IgComment[] = (res.data ?? []).map((c) => ({
      id: c.id,
      mediaId,
      text: c.text ?? "",
      timestamp: ms(c.timestamp),
      fromId: c.from?.id,
      fromUsername: c.from?.username ?? c.username,
      parentId: c.parent_id,
    }));
    return { comments, next: res.paging?.next ? res.paging.cursors?.after : undefined };
  }

  async replyToComment(commentId: string, text: string) {
    return this.post<{ id: string }>(`${commentId}/replies`, { message: text });
  }

  async sendPrivateReply(commentId: string, message: OutMessage) {
    const res = await this.post<{ message_id?: string; recipient_id?: string }>(`${this.igUserId}/messages`, {
      recipient: { comment_id: commentId },
      message: messageJson(message),
    });
    return { messageId: res.message_id, recipientId: res.recipient_id };
  }

  async sendMessage(igUserId: string, message: OutMessage) {
    const res = await this.post<{ message_id?: string }>(`${this.igUserId}/messages`, {
      recipient: { id: igUserId },
      message: messageJson(message),
    });
    return { messageId: res.message_id };
  }

  async getProfile(igUserId: string) {
    const res = await this.get<{ name?: string; username?: string }>(igUserId, { fields: "name,username" });
    return { name: res.name ?? null, username: res.username ?? null };
  }

  async mediaInsights(mediaId: string): Promise<MediaInsights> {
    type Row = { name?: string; values?: Array<{ value?: unknown }>; total_value?: { value?: unknown } };
    let res: { data?: Row[] };
    try {
      res = await this.get(`${mediaId}/insights`, { metric: INSIGHT_METRICS.join(",") });
    } catch (err) {
      // Meta refuses the whole request when one metric doesn't apply to the post's type: ask again for the ones every post has.
      if (!(err instanceof MetaError) || err.code !== 100 || err.subcode === 33) throw err;
      res = await this.get(`${mediaId}/insights`, { metric: "reach,likes,comments,saved" });
    }
    const out: MediaInsights = {};
    for (const row of res.data ?? []) {
      const value = row.total_value?.value ?? row.values?.[0]?.value;
      const name = INSIGHT_METRICS.find((m) => m === row.name);
      if (name && typeof value === "number") out[name] = value;
    }
    return out;
  }
}

/** Builds the real client from stored settings, or null until Instagram is connected. */
export function graphClientFromSettings(env: Env, s: { access_token?: string; ig_user_id?: string; meta_app_id?: string; meta_app_secret?: string }): MetaClient | null {
  if (!s.access_token || !s.ig_user_id || !s.meta_app_id || !s.meta_app_secret) return null;
  return new GraphMetaClient(graphBase(env), s.access_token, s.ig_user_id, s.meta_app_id, s.meta_app_secret);
}
