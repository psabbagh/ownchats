export interface Env {
  DB: D1Database;
  /** Chosen on the Deploy to Cloudflare screen. Signs sessions and encrypts stored secrets. */
  ADMIN_PASSWORD?: string;
  /**
   * The lead webhook's signing secret, if the owner keeps it as a Worker secret
   * rather than entering it in Settings. It wins over the one in Settings.
   */
  LEAD_WEBHOOK_SECRET?: string;
  /** Override for the Graph API host, for tests or a proxy. Defaults to https://graph.facebook.com */
  META_GRAPH_BASE?: string;
}
