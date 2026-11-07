import { decryptText, encryptText } from "./crypto";

/** Settings stored encrypted with a key derived from ADMIN_PASSWORD. */
const SECRET_KEYS = new Set(["meta_app_secret", "access_token", "export_key"]);

export type SettingKey =
  | "base_url"
  | "meta_app_id"
  | "meta_app_secret"
  | "meta_config_id"
  | "verify_token"
  | "access_token"
  | "token_expires_at"
  | "token_data_expires_at"
  | "token_checked_at"
  | "token_problem"
  | "ig_user_id"
  | "ig_username"
  | "ig_account_hint"
  | "subscribed_fields"
  | "webhook_verified_at"
  | "last_webhook_at"
  | "last_webhook_problem"
  | "published_confirmed_at"
  | "contact"
  | "api_token_hash"
  | "export_key"
  | "media_cache"
  | "media_cache_at"
  | "poll_cursor"
  | "last_poll_at"
  | "last_poll_problem"
  | "next_post_problem"
  | "daily_at"
  | "posts_listed_at"
  | "posts_problem"
  | "account_stats_at"
  | "account_problem"
  | "followers_count"
  | "follows_count"
  | "media_count";

export type Settings = Partial<Record<SettingKey, string>>;

/**
 * Reads every setting in one query. Encrypted values are decrypted; a value that
 * no longer decrypts (the admin password changed) reads as missing.
 */
export async function loadSettings(db: D1Database, password: string | undefined): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const out: Settings = {};
  for (const row of results) {
    if (SECRET_KEYS.has(row.key)) {
      if (!password) continue;
      const plain = await decryptText(password, row.value);
      if (plain !== null) out[row.key as SettingKey] = plain;
    } else {
      out[row.key as SettingKey] = row.value;
    }
  }
  return out;
}

export async function saveSettings(
  db: D1Database,
  password: string | undefined,
  values: Settings,
  now = Date.now(),
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    let stored = value;
    if (SECRET_KEYS.has(key)) {
      if (!password) throw new Error("ADMIN_PASSWORD is not set, so secrets cannot be stored");
      stored = await encryptText(password, value);
    }
    statements.push(
      db
        .prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        )
        .bind(key, stored, now),
    );
  }
  if (statements.length) await db.batch(statements);
}

export async function deleteSettings(db: D1Database, keys: SettingKey[]): Promise<void> {
  if (!keys.length) return;
  await db.batch(keys.map((k) => db.prepare("DELETE FROM settings WHERE key = ?").bind(k)));
}
