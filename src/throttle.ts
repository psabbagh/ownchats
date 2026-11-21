import { MetaError, type MetaClient, type MetaUsage } from "./meta/client";
import { saveSettings, type Settings } from "./settings";
import { HOUR, MINUTE } from "./time";

/**
 * Sends first. Meta's app-level rate limit (code 4) counts every Graph API call the app
 * makes, so background reads (comment polling, insights, account days) can use up the
 * room a DM needs. OwnChats reads Meta's usage headers on every answer and holds those
 * reads back as the limit nears; a DM is never held back by this.
 */

/** Above this share of a Meta limit, the reads that can wait are skipped: insights, account days, older posts. */
export const BUSY_PERCENT = 70;
/** Above this, every background read is skipped, new posts' comments included. */
export const FULL_PERCENT = 90;
/** A reading older than this no longer says anything: Meta's window rolls over the hour. */
const READING_LASTS = 5 * MINUTE;
/** How long background reads stop after Meta refuses for a rate limit, when Meta gives no time. */
export const PAUSE = 10 * MINUTE;
/** The longest pause, whatever Meta says. */
const MAX_PAUSE = HOUR;
/** Sends the Cron retries in one run while paused: enough to see whether Meta lets them through. */
export const RETRIES_WHILE_PAUSED = 2;

/** "low": can wait for hours (insights, account days, older posts). "high": a new post's comments, attaching a waiting campaign. */
export type Priority = "low" | "high";

/** What OwnChats knows of Meta's limits, shared by everything in one invocation. */
export interface MetaLoad {
  /** The latest reading and when it was seen; null when none yet. */
  usage: MetaUsage | null;
  usageAt: number;
  /** Background reads stop until then, after a rate-limit refusal. */
  pausedUntil: number;
  /** A reading came in that has not been saved. */
  dirty: boolean;
}

export function loadMetaLoad(s: Settings): MetaLoad {
  let usage: MetaUsage | null = null;
  let usageAt = 0;
  try {
    const saved = s.meta_usage ? (JSON.parse(s.meta_usage) as { at?: unknown; percent?: unknown; regainMs?: unknown; detail?: unknown }) : null;
    if (saved && typeof saved.at === "number" && typeof saved.percent === "number") {
      usageAt = saved.at;
      usage = { percent: saved.percent, regainMs: typeof saved.regainMs === "number" ? saved.regainMs : null, detail: typeof saved.detail === "string" ? saved.detail : "" };
    }
  } catch {
    // An unreadable reading is no reading.
  }
  return { usage, usageAt, pausedUntil: Number(s.meta_paused_until ?? 0) || 0, dirty: false };
}

/** Saves the latest reading and the pause, so the next invocation starts from them. */
export async function saveMetaLoad(db: D1Database, password: string | undefined, load: MetaLoad): Promise<void> {
  if (!load.dirty) return;
  load.dirty = false;
  await saveSettings(db, password, {
    meta_usage: load.usage ? JSON.stringify({ at: load.usageAt, ...load.usage }) : "",
    meta_paused_until: String(load.pausedUntil),
  });
}

/** The latest reading, if it is recent enough to go by. */
export function currentUsage(load: MetaLoad, now: number): MetaUsage | null {
  return load.usage && now - load.usageAt <= READING_LASTS ? load.usage : null;
}

export function paused(load: MetaLoad, now: number): boolean {
  return load.pausedUntil > now;
}

/** Whether a background read of this priority may call Meta now. Sends never ask. */
export function backgroundAllowed(load: MetaLoad, now: number, priority: Priority): boolean {
  if (paused(load, now)) return false;
  const usage = currentUsage(load, now);
  if (!usage) return true;
  return usage.percent < (priority === "low" ? BUSY_PERCENT : FULL_PERCENT);
}

/** Records a refusal for a rate limit: background reads stop for Meta's time, or PAUSE. */
export function noteRefusal(load: MetaLoad, now: number): void {
  const regain = load.usage && now - load.usageAt <= READING_LASTS ? load.usage.regainMs : null;
  const until = now + Math.min(MAX_PAUSE, Math.max(PAUSE, regain ?? 0));
  if (until > load.pausedUntil) load.pausedUntil = until;
  load.dirty = true;
}

/**
 * The Meta client as OwnChats uses it: every call's usage reading is kept, and a
 * rate-limit refusal starts a pause, saved at once so a webhook arriving meanwhile
 * sees it too. The calls themselves are unchanged.
 */
export function watchMeta(client: MetaClient, load: MetaLoad, now: () => number, save: () => Promise<void>): MetaClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        let refused = false;
        try {
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        } catch (err) {
          refused = err instanceof MetaError && err.rateLimited;
          throw err;
        } finally {
          const usage = target.lastUsage;
          if (usage && usage !== load.usage) {
            load.usage = usage;
            load.usageAt = now();
            load.dirty = true;
          }
          if (refused) {
            noteRefusal(load, now());
            await save().catch(() => undefined);
          }
        }
      };
    },
  });
}
