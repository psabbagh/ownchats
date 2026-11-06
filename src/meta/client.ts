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
  /** Newest comments first, one page. */
  listComments(mediaId: string, after?: string): Promise<{ comments: IgComment[]; next?: string }>;
  /** Public reply under a comment. */
  replyToComment(commentId: string, text: string): Promise<{ id: string }>;
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
   * Lifetime numbers for one of the account's posts. Needs instagram_manage_insights
   * in the login configuration. A metric Meta has no number for is left out.
   */
  mediaInsights(mediaId: string): Promise<MediaInsights>;
}

export const INSIGHT_METRICS = ["views", "reach", "likes", "comments", "shares", "saved"] as const;
export type MediaInsights = Partial<Record<(typeof INSIGHT_METRICS)[number], number>>;

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
    return this.status >= 500 || this.status === 429 || [1, 2, 4, 17, 32, 341, 613].includes(this.code ?? -1);
  }

  get detail(): string {
    const parts = [`HTTP ${this.status}`];
    if (this.code !== undefined) parts.push(`code ${this.code}`);
    if (this.subcode !== undefined) parts.push(`subcode ${this.subcode}`);
    if (this.traceId) parts.push(`trace ${this.traceId}`);
    return `${this.message} (${parts.join(", ")})`;
  }
}

/** A short reason for the activity log, in plain words where the error is known. */
export function explainError(err: unknown): { reason: string; detail: string } {
  if (err instanceof MetaError) {
    return { reason: knownReason(err) ?? "Meta refused", detail: err.detail };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { reason: "error", detail: message };
}

// Codes from Meta's Messenger Platform error list and reports from other tools.
function knownReason(err: MetaError): string | null {
  const m = err.message.toLowerCase();
  const sub = err.subcode ?? -1;
  if (err.code === 190) return "token expired or revoked: reconnect Instagram on /setup";
  if (err.transient) return "Meta rate limit or outage, will retry";
  if (sub === 2534025 || sub === 2534023 || err.code === 10900) return "Meta refused a private reply to this comment (already answered, or too old)";
  if (sub === 2534022 || sub === 2018278) return "outside Meta's 24-hour messaging window";
  if (sub === 2534037 || sub === 2018300 || m.includes("thread owner")) return "another app owns this conversation: check Conversation routing in Meta Business Suite";
  if (err.code === 200 && m.includes("direct messaging")) return "\"Allow access to messages\" is off in Instagram's settings";
  if (err.code === 200 || sub === 2534048) return "Meta refused: the app may still be in Development mode, or the person has no role on it";
  if (err.code === 100 && sub === 33) return "the Instagram account is not assigned to this login: see Connect Instagram on /setup";
  if (err.code === 551 || sub === 2018108) return "this person can't be messaged right now";
  if (err.code === 10 && m.includes("business or creator")) return "the Instagram account must be a Business or Creator account";
  if (err.code === 10 && m.includes("permission")) return "a permission is missing from the app's configuration";
  return null;
}

/** Meta refused the button template itself, not the message: worth sending as plain text. */
export function isTemplateRejection(err: unknown): boolean {
  if (!(err instanceof MetaError) || err.transient) return false;
  if (err.code !== 100) return false;
  return ![33, 2534025, 2534023, 2534037, 2534022, 2018278].includes(err.subcode ?? -1);
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
