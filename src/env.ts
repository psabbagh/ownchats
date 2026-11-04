export interface Env {
  DB: D1Database;
  /** Chosen on the Deploy to Cloudflare screen. Signs sessions and encrypts stored secrets. */
  ADMIN_PASSWORD?: string;
  /** Override for the Graph API host, for tests or a proxy. Defaults to https://graph.facebook.com */
  META_GRAPH_BASE?: string;
}
