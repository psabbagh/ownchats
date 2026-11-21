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

/** "low": can wait for hours (insights, account days, older posts). "high": a new post's comments, attaching a waiting campaign. */
export type Priority = "low" | "high";

/** The latest reading of one of Meta's limits. */
interface Reading {
  percent: number;
  at: number;
}

/** What OwnChats knows of Meta's limits, shared by everything in one invocation. */
export interface MetaLoad {
  /**
   * The latest reading of each limit, by label ("app", "instagram"). Kept apart because
   * an answer may carry one header and not the other: a low reading of one limit must
   * never hide a high reading of another.
   */
  readings: Record<string, Reading>;
  /** How long Meta said until access returns, and when it said so; 0 when it hasn't. */
  regainMs: number;
  regainAt: number;
  /** Background reads stop until then, after a rate-limit refusal. */
  pausedUntil: number;
  /** A reading came in that has not been saved. */
  dirty: boolean;
}

export function loadMetaLoad(s: Settings): MetaLoad {
  const load: MetaLoad = { readings: {}, regainMs: 0, regainAt: 0, pausedUntil: Number(s.meta_paused_until ?? 0) || 0, dirty: false };
  try {
    const saved = s.meta_usage ? (JSON.parse(s.meta_usage) as { readings?: unknown; regainMs?: unknown; regainAt?: unknown }) : null;
    if (saved?.readings && typeof saved.readings === "object") {
      for (const [label, r] of Object.entries(saved.readings as Record<string, { percent?: unknown; at?: unknown }>)) {
        if (typeof r?.percent === "number" && typeof r.at === "number") load.readings[label] = { percent: r.percent, at: r.at };
      }
    }
    if (typeof saved?.regainMs === "number" && typeof saved.regainAt === "number") {
      load.regainMs = saved.regainMs;
      load.regainAt = saved.regainAt;
    }
  } catch {
    // An unreadable reading is no reading; one saved in the earlier single-reading shape is dropped too.
  }
  return load;
}

/** Saves the latest readings and the pause, so the next invocation starts from them. */
export async function saveMetaLoad(db: D1Database, password: string | undefined, load: MetaLoad): Promise<void> {
  if (!load.dirty) return;
  load.dirty = false;
  await saveSettings(db, password, {
    meta_usage: JSON.stringify({ readings: load.readings, regainMs: load.regainMs, regainAt: load.regainAt }),
    meta_paused_until: String(load.pausedUntil),
  });
}

/** Records what one answer said: each limit it carried replaces only that limit's reading. */
export function noteUsage(load: MetaLoad, usage: MetaUsage, now: number): void {
  for (const [label, percent] of Object.entries(usage.limits)) load.readings[label] = { percent, at: now };
  if (usage.regainMs) {
    load.regainMs = usage.regainMs;
    load.regainAt = now;
  }
  load.dirty = true;
}

/** The highest of the readings recent enough to go by, with each of them for the dashboard; null when none is. */
export function currentUsage(load: MetaLoad, now: number): MetaUsage | null {
  const fresh = Object.entries(load.readings).filter(([, r]) => now - r.at <= READING_LASTS);
  if (!fresh.length) return null;
  const limits = Object.fromEntries(fresh.map(([label, r]) => [label, r.percent]));
  return {
    percent: Math.max(...fresh.map(([, r]) => r.percent)),
    regainMs: load.regainMs && now - load.regainAt <= READING_LASTS ? load.regainMs : null,
    detail: fresh.map(([label, r]) => `${label} ${Math.round(r.percent)}%`).join(", "),
    limits,
  };
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
  const regain = currentUsage(load, now)?.regainMs ?? null;
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
  let seen: MetaUsage | null = null;
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
          // Only an answer's own reading: the client keeps its last one between calls.
          const usage = target.lastUsage;
          if (usage && usage !== seen) {
            seen = usage;
            noteUsage(load, usage, now());
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
