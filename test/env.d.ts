declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    ADMIN_PASSWORD: string;
    ACCESS_TEAM: string;
    ACCESS_AUD: string;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
