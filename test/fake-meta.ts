import { MetaError, type AccountStats, type IgComment, type Media, type MediaInsights, type MetaClient, type OutMessage, type ReelMetric, type TokenInfo } from "../src/meta/client";
import { DAY } from "../src/time";

export interface Sent {
  kind: "private_reply" | "message" | "public_reply";
  to: string;
  message: OutMessage | string;
  at: number;
}

/**
 * A stand-in for Meta that enforces the limits OwnChats must respect, so a test
 * fails if the code ever breaks one:
 * - one private reply per comment, within 7 days of the comment;
 * - other messages only within 24 hours of the person's last message or tap.
 * All ids and names here are invented.
 */
export class FakeMeta implements MetaClient {
  account = { id: "17841400000000001", username: "test_creator" };
  media: Media[] = [];
  /** Comments Meta knows about, by id. */
  comments = new Map<string, IgComment>();
  /** When each person last messaged or tapped. */
  lastInbound = new Map<string, number>();
  privateReplied = new Set<string>();
  sent: Sent[] = [];
  calls: string[] = [];
  subscribed: string[] = [];
  token: TokenInfo = { valid: true, expiresAt: null, dataAccessExpiresAt: null, scopes: [] };
  usernames = new Map<string, string>();
  names = new Map<string, string>();
  /** People who follow the account, by messaging id. Meta answers only after they tapped or wrote. */
  followers = new Set<string>();
  accountStats: AccountStats = { followers: 1200, follows: 150, mediaCount: 40 };
  /** Each post's lifetime numbers, as Meta's insights report them. */
  insights = new Map<string, MediaInsights>();
  /** Each Reel's watch time and skip rate, as Meta's insights report them. */
  reelInsights = new Map<string, Partial<Record<ReelMetric, number>>>();
  /** When set, the messaging id Meta returns for a commenter differs from the id on the comment. */
  messagingIds = new Map<string, string>();
  private failures = new Map<string, MetaError[]>();

  constructor(private readonly now: () => number) {}

  /** Makes the next call to `method` fail with this error. */
  failNext(method: keyof MetaClient, error: MetaError): void {
    const list = this.failures.get(method) ?? [];
    list.push(error);
    this.failures.set(method, list);
  }

  private call(method: keyof MetaClient): void {
    this.calls.push(method);
    const err = this.failures.get(method)?.shift();
    if (err) throw err;
  }

  addComment(c: IgComment): IgComment {
    this.comments.set(c.id, c);
    return c;
  }

  personActed(igUserId: string, at: number): void {
    this.lastInbound.set(igUserId, Math.max(this.lastInbound.get(igUserId) ?? 0, at));
  }

  sentTo(to: string): Sent[] {
    return this.sent.filter((s) => s.to === to);
  }

  async getAccount() {
    this.call("getAccount");
    return this.account;
  }
  async subscribeWebhooks(fields: string[]) {
    this.call("subscribeWebhooks");
    this.subscribed = fields;
  }
  async getSubscribedFields() {
    this.call("getSubscribedFields");
    return this.subscribed;
  }
  async tokenInfo() {
    this.call("tokenInfo");
    return this.token;
  }
  async listMedia(limit: number) {
    this.call("listMedia");
    return this.media.slice(0, limit);
  }
  async listMediaSince(since: number, max: number) {
    this.call("listMediaSince");
    return [...this.media].sort((a, b) => b.timestamp - a.timestamp).filter((m) => m.timestamp >= since).slice(0, max);
  }
  async getAccountStats() {
    this.call("getAccountStats");
    return { ...this.accountStats };
  }
  async listComments(mediaId: string) {
    this.call("listComments");
    const comments = [...this.comments.values()].filter((c) => c.mediaId === mediaId).sort((a, b) => b.timestamp - a.timestamp);
    return { comments };
  }
  async replyToComment(commentId: string, text: string) {
    this.call("replyToComment");
    this.sent.push({ kind: "public_reply", to: commentId, message: text, at: this.now() });
    return { id: `reply_${commentId}` };
  }
  async sendPrivateReply(commentId: string, message: OutMessage) {
    this.call("sendPrivateReply");
    const comment = this.comments.get(commentId);
    if (!comment) throw new MetaError("Invalid parameter: comment not found", 400, 100, 33);
    if (this.privateReplied.has(commentId)) {
      throw new MetaError("The comment is invalid for a private reply", 400, 100, 2534025);
    }
    if (this.now() - comment.timestamp > 7 * DAY) throw new MetaError("The comment is invalid for a private reply", 400, 100, 2534025);
    this.privateReplied.add(commentId);
    this.sent.push({ kind: "private_reply", to: commentId, message, at: this.now() });
    return { messageId: `m_${this.sent.length}`, recipientId: this.messagingIds.get(comment.fromId ?? "") ?? comment.fromId };
  }
  async sendMessage(igUserId: string, message: OutMessage) {
    this.call("sendMessage");
    const last = this.lastInbound.get(igUserId);
    if (last === undefined || this.now() - last > DAY) {
      throw new MetaError("This message is sent outside of allowed window.", 400, 10, 2534022);
    }
    this.sent.push({ kind: "message", to: igUserId, message, at: this.now() });
    return { messageId: `m_${this.sent.length}` };
  }
  async getProfile(igUserId: string) {
    this.call("getProfile");
    return { name: this.names.get(igUserId) ?? null, username: this.usernames.get(igUserId) ?? null };
  }
  async getFollowStatus(igUserId: string) {
    this.call("getFollowStatus");
    // Meta's user profile needs the person to have messaged or tapped first.
    if (!this.lastInbound.has(igUserId)) throw new MetaError("User consent is required to access user profile", 400, 230);
    return { follows: this.followers.has(igUserId), name: this.names.get(igUserId) ?? null, username: this.usernames.get(igUserId) ?? null };
  }
  async mediaInsights(mediaId: string) {
    this.call("mediaInsights");
    return { ...(this.insights.get(mediaId) ?? {}) };
  }
  async reelInsight(mediaId: string, metric: ReelMetric) {
    this.call("reelInsight");
    return this.reelInsights.get(mediaId)?.[metric];
  }
}
