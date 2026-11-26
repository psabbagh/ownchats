export interface Env {
  DB: D1Database;
  /** Chosen on the Deploy to Cloudflare screen. Signs sessions and encrypts stored secrets, so it stays even behind Cloudflare Access. */
  ADMIN_PASSWORD?: string;
  /**
   * The lead webhook's signing secret, if the owner keeps it as a Worker secret
   * rather than entering it in Settings. It wins over the one in Settings.
   */
  LEAD_WEBHOOK_SECRET?: string;
  /**
   * Optional Cloudflare Access sign-in: the team's address (https://<team>.cloudflareaccess.com)
   * and the Access app's audience tag. With both set, the dashboard opens only with Access's
   * signed token and there is no password page. Empty or missing: the password sign-in.
   */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  /** Override for the Graph API host, for tests or a proxy. Defaults to https://graph.facebook.com */
  META_GRAPH_BASE?: string;
}
