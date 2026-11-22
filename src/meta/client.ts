/**
 * Everything OwnChats asks of Meta, behind one interface. The real client is in
 * graph.ts; tests use a fake that enforces Meta's limits (test/fake-meta.ts).
 */
export interface MetaClient {
  /** The connected Instagram professional account. */
  getAccount(): Promise<{ id: string; username: string }>;
  /** Subscribes the account to the app's webhooks for these fields. */
  subscribeWebhooks(fields: string[]): Promise<void>;
  /** The webhook fields the account is subscribed to. */
  getSubscribedFields(): Promise<string[]>;
  /** Expiry and validity of the access token. */
  tokenInfo(): Promise<TokenInfo>;

  listMedia(limit: number): Promise<Media[]>;
  /** The account's posts from `since` (Unix ms) on, newest first, at most `max`, following Meta's pages. */
  listMediaSince(since: number, max: number): Promise<Media[]>;
  /** Follower, following and post counts of the connected account. Null where Meta leaves one out. */
  getAccountStats(): Promise<AccountStats>;
  /** Newest comments first, one page. */
  listComments(mediaId: string, after?: string): Promise<{ comments: IgComment[]; next?: string }>;
  /** Public reply under a comment. */
  replyToComment(commentId: string, text: string): Promise<{ id: string }>;
  /**
   * Likes a comment as the account (a heart under it). Needs instagram_manage_engagement in
   * the login configuration, and Facebook Login, which OwnChats uses. Meta refuses comments
   * by private accounts. Liking a comment already liked does nothing.
   */
  likeComment(commentId: string): Promise<void>;
  /**
   * The one private reply Meta allows per comment, within 7 days of it. Meta
   * answers with the person's messaging id, which taps and DMs will come from.
   */
  sendPrivateReply(commentId: string, message: OutMessage): Promise<{ messageId?: string; recipientId?: string }>;
  /** A DM to someone who messaged or tapped within the last 24 hours. */
  sendMessage(igUserId: string, message: OutMessage): Promise<{ messageId?: string }>;
  /** The person's name and username, readable once they have messaged or tapped. */
  getProfile(igUserId: string): Promise<{ name: string | null; username: string | null }>;
  /**
   * The same profile with whether the person follows the account
   * (`is_user_follow_business`). Null when Meta leaves the field out.
   */
  getFollowStatus(igUserId: string): Promise<{ follows: boolean | null; name: string | null; username: string | null }>;
  /**
   * Lifetime numbers for one of the account's posts. Needs instagram_manage_insights
   * in the login configuration. A metric Meta has no number for is left out.
   */
  mediaInsights(mediaId: string): Promise<MediaInsights>;
  /**
   * One lifetime number Meta gives only for Reels, asked alone (see REEL_METRICS).
   * Undefined when Meta has none. Meta refuses it for other post types.
   */
  reelInsight(mediaId: string, metric: ReelMetric): Promise<number | undefined>;
  /**
   * The account's reach and follows for one of Meta's days (YYYY-MM-DD), which run
   * midnight to midnight Pacific time. Null where Meta has no number yet.
   */
  accountDay(day: string): Promise<AccountDay>;
  /**
   * How close the app is to Meta's rate limits, as Meta reported on its latest
   * response (X-App-Usage, X-Business-Use-Case-Usage). Null until a response carried it.
   */
  readonly lastUsage: MetaUsage | null;
}

/** Meta's own count of how much of a rate limit the app has used, from its response headers. */
export interface MetaUsage {
  /** The highest share used, 0 to 100 (it can pass 100 once Meta refuses). */
  percent: number;
  /** How long until Meta lets calls through again, when it said; null otherwise. */
  regainMs: number | null;
  /** Which limit is at what, for the dashboard: "app 72%, instagram 4%". */
  detail: string;
  /**
   * Each limit's share on its own, by label ("app", "instagram"). Not every answer
   * carries every header, so a reading of one limit says nothing about another.
   */
  limits: Record<string, number>;
}

const USAGE_FIELDS = ["call_count", "total_cputime", "total_time"] as const;

/**
 * Reads Meta's usage headers. X-App-Usage counts every call the app makes in a rolling
 * hour (`{"call_count":28,"total_time":25,"total_cputime":25}`, percentages); Meta
 * refuses with code 4 at 100. X-Business-Use-Case-Usage has the same per account and
 * use case, with `estimated_time_to_regain_access` in minutes once it is reached.
 * Null when neither header is there or neither can be read.
 */
export function parseUsage(appUsage: string | null, businessUsage: string | null): MetaUsage | null {
  const parts: string[] = [];
  const limits: Record<string, number> = {};
  let percent = -1;
  let regain = 0;
  const take = (label: string, o: unknown) => {
    if (!o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    const values = USAGE_FIELDS.map((f) => r[f]).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!values.length) return;
    const top = Math.max(...values);
    percent = Math.max(percent, top);
    parts.push(`${label} ${Math.round(top)}%`);
    limits[label] = Math.max(limits[label] ?? 0, top);
    const minutes = r.estimated_time_to_regain_access;
    if (typeof minutes === "number" && Number.isFinite(minutes)) regain = Math.max(regain, minutes);
  };
  const read = (header: string | null): unknown => {
    if (!header) return null;
    try {
      return JSON.parse(header) as unknown;
    } catch {
      return null;
    }
  };
  take("app", read(appUsage));
  const business = read(businessUsage);
  if (business && typeof business === "object") {
    for (const list of Object.values(business as Record<string, unknown>)) {
      for (const entry of Array.isArray(list) ? list : []) {
        take(typeof (entry as { type?: unknown })?.type === "string" ? String((entry as { type: string }).type).toLowerCase() : "account", entry);
      }
    }
  }
  if (percent < 0) return null;
  return { percent, regainMs: regain > 0 ? regain * 60_000 : null, detail: parts.join(", "), limits };
}

export interface AccountStats {
  followers: number | null;
  follows: number | null;
  mediaCount: number | null;
}

export const INSIGHT_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;
/** Every post type has reposts, but it is newer: asked with INSIGHT_METRICS, and dropped if Meta refuses it. */
export const REPOSTS = "reposts";
export type MediaInsights = Partial<Record<(typeof INSIGHT_METRICS)[number] | typeof REPOSTS, number>>;

/** One of Meta's days for the account. Reach is split by follow_type; follows and unfollows come from follows_and_unfollows. */
export interface AccountDay {
  reach: number | null;
  reachFollowers: number | null;
  reachNonFollowers: number | null;
  reachUnknown: number | null;
  follows: number | null;
  /** Accounts that unfollowed or left Instagram. */
  unfollows: number | null;
}

/**
 * Reel-only numbers, one request each: Meta refuses a whole request over one
 * metric it won't give, so asked together, one refusal would cost the other.
 * `ig_reels_avg_watch_time` is in milliseconds. `reels_skip_rate` is the
 * percentage (0 to 100) of initial views skipped within the first 3 seconds.
 */
export const REEL_METRICS = ["ig_reels_avg_watch_time", "reels_skip_rate"] as const;
export type ReelMetric = (typeof REEL_METRICS)[number];

export interface TokenInfo {
  valid: boolean;
  /** Unix ms; null when the token does not expire. */
  expiresAt: number | null;
  /** Unix ms; null when not reported. */
  dataAccessExpiresAt: number | null;
  scopes: string[];
}

export interface Media {
  id: string;
  caption: string;
  permalink: string;
  timestamp: number;
  mediaType: string;
  thumbnailUrl?: string;
}

export interface IgComment {
  id: string;
  mediaId: string;
  text: string;
  timestamp: number;
  fromId?: string;
  fromUsername?: string;
  parentId?: string;
}

export type Button = { type: "web_url"; title: string; url: string } | { type: "postback"; title: string; payload: string };

export type OutMessage = { kind: "text"; text: string } | { kind: "buttons"; text: string; buttons: Button[] };

/** An error returned by the Graph API, kept whole for the activity log. */
export class MetaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
    readonly type?: string,
    readonly traceId?: string,
  ) {
    super(message);
    this.name = "MetaError";
  }

  /** Worth trying again later: rate limits and Meta-side errors. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 341, 613, 80002].includes(this.code ?? -1);
  }

  /**
   * One of Meta's rate limits refused the call: 4 is the app's (every call it makes counts),
   * 17 the user's, 32 the page's, 613 a custom one, 80002 the Instagram account's.
   */
  get rateLimited(): boolean {
    return this.status === 429 || [4, 17, 32, 613, 80002].includes(this.code ?? -1);
  }

  get detail(): string {
    const parts = [`HTTP ${this.status}`];
    if (this.code !== undefined) parts.push(`code ${this.code}`);
    if (this.subcode !== undefined) parts.push(`subcode ${this.subcode}`);
    if (this.traceId) parts.push(`trace ${this.traceId}`);
    return `${this.message} (${parts.join(", ")})`;
  }
}

/**
 * The reason logged for a refusal worth trying again: a rate limit or an outage. Sends
 * refused this way are retried by the Cron, and listed under To check meanwhile.
 */
export const TRANSIENT_REASON = "Meta rate limit or outage, will retry";

/** A short reason for the activity log, in plain words where the error is known. */
export function explainError(err: unknown): { reason: string; detail: string } {
  if (err instanceof MetaError) {
    return { reason: knownReason(err) ?? "Meta refused", detail: err.detail };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { reason: "error", detail: message };
}

/**
 * The same for a public reply. There the object Meta can't reach is the comment, so subcode 33
 * says nothing about the connection. A public reply is only tried once its DM went out.
 */
export function explainReplyError(err: unknown): { reason: string; detail: string } {
  const explained = explainError(err);
  if (!(err instanceof MetaError)) return explained;
  if (err.code === 100 && err.subcode === 33) return { ...explained, reason: "this comment can't be replied to, it may be hidden or deleted (the DM still went out)" };
  if (err.code === 20) return { ...explained, reason: "Instagram blocked this public reply, possibly as spam (the DM still went out)" };
  return explained;
}

/** Stored as the like problem when Meta refuses for lack of instagram_manage_engagement: Settings explains the fix. */
export const LIKE_PERMISSION_REASON = "Meta refused the like: add instagram_manage_engagement to your Meta login configuration, then reconnect on /setup (the DM still went out)";

/** Meta refused a like for lack of permission, which is the owner's to fix, not the person's. */
export function isLikePermissionError(err: unknown): boolean {
  if (!(err instanceof MetaError) || err.transient) return false;
  const m = err.message.toLowerCase();
  return err.code === 10 || err.code === 200 || (err.code === 100 && m.includes("permission"));
}

/**
 * Why a like was refused. Like a public reply, a like is only tried once the DM went out,
 * so it never stands between the person and what they asked for.
 */
export function explainLikeError(err: unknown): { reason: string; detail: string } {
  const explained = explainError(err);
  if (!(err instanceof MetaError)) return explained;
  if (err.code === 190) return explained;
  if (isLikePermissionError(err)) return { ...explained, reason: LIKE_PERMISSION_REASON };
  if (err.message.toLowerCase().includes("private")) return { ...explained, reason: "this person's account is private, and Meta doesn't allow liking their comments (the DM still went out)" };
  if (err.code === 100 && err.subcode === 33) return { ...explained, reason: "this comment can't be liked, it may be hidden or deleted (the DM still went out)" };
  return { ...explained, reason: `${explained.reason} (the DM still went out)` };
}

// Codes from Meta's Messenger Platform error list and reports from other tools.
function knownReason(err: MetaError): string | null {
  const m = err.message.toLowerCase();
  const sub = err.subcode ?? -1;
  if (err.code === 190) return "token expired or revoked: reconnect Instagram on /setup";
  if (err.transient) return TRANSIENT_REASON;
  if (sub === 2534025 || sub === 2534023 || err.code === 10900) return "Meta refused a private reply to this comment (already answered, or too old)";
  if (sub === 2534022 || sub === 2018278) return "outside Meta's 24-hour messaging window";
  if (sub === 2534037 || sub === 2018300 || m.includes("thread owner")) return "another app owns this conversation: check Conversation routing in Meta Business Suite";
  if (err.code === 200 && m.includes("direct messaging")) return "\"Allow access to messages\" is off in Instagram's settings";
  if (err.code === 200 || sub === 2534048) return "Meta refused: the app may still be in Development mode, or the person has no role on it";
  if (err.code === 100 && sub === 33) return "the Instagram account is not assigned to this login: see Connect Instagram on /setup";
  if (err.code === 551 || sub === 2018108) return "this person can't be messaged right now";
  if (sub === 2534014) return "Meta can't find this person to message: the account may be deactivated, or closed to messages from you";
  if (err.code === 10 && m.includes("business or creator")) return "the Instagram account must be a Business or Creator account";
  if (err.code === 10 && m.includes("permission")) return "a permission is missing from the app's configuration";
  return null;
}

/** Meta refused the button template itself, not the message: worth sending as plain text. */
export function isTemplateRejection(err: unknown): boolean {
  if (!(err instanceof MetaError) || err.transient) return false;
  if (err.code !== 100) return false;
  return ![33, 2534014, 2534025, 2534023, 2534037, 2534022, 2018278].includes(err.subcode ?? -1);
}

/** The same content without buttons: link buttons become the link itself. */
export function plainText(m: OutMessage): OutMessage {
  if (m.kind === "text") return m;
  const links = m.buttons.flatMap((b) => (b.type === "web_url" ? [b.url] : []));
  return { kind: "text", text: [m.text, ...links].filter(Boolean).join("\n") };
}

/**
 * Meta documents button templates for DMs but not on every path, so if one is
 * refused, the content goes again as plain text.
 */
export async function sendWithFallback<T>(send: (m: OutMessage) => Promise<T>, message: OutMessage): Promise<T> {
  try {
    return await send(message);
  } catch (err) {
    if (message.kind === "buttons" && isTemplateRejection(err)) return send(plainText(message));
    throw err;
  }
}
