import type { Env } from "./env";
import type { MetaClient } from "./meta/client";
import { loadSettings, type Settings } from "./settings";

/**
 * Everything a request or a Cron run needs. Built fresh for each one; tests build
 * it with a fake Meta client and a fixed clock.
 */
export interface Ctx {
  env: Env;
  db: D1Database;
  settings: Settings;
  /** Null until Instagram is connected. */
  meta: MetaClient | null;
  now(): number;
  /** For picking public reply variants; tests make it predictable. */
  random(): number;
  budget: Budget;
  /** Private replies sent in the last hour, counted once per invocation. */
  sentLastHour?: number;
}

export type MetaFactory = (env: Env, settings: Settings) => MetaClient | null;

export interface AppOptions {
  meta: MetaFactory;
  now?: () => number;
  random?: () => number;
}

/**
 * The Workers free plan allows 50 outgoing requests and 50 D1 queries per
 * invocation (a batch counts as one query). Meta calls are reserved with `take`;
 * D1 queries are counted by the wrapper below. Work that does not fit waits for
 * the next Cron run.
 */
export class Budget {
  used = 0;
  queries = 0;
  constructor(
    readonly limit = 45,
    readonly queryLimit = 45,
  ) {}
  get left(): number {
    return this.limit - this.used;
  }
  get queriesLeft(): number {
    return this.queryLimit - this.queries;
  }
  /** True if `n` Meta calls fit; reserves them. */
  take(n = 1): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
}

/** Wraps D1 so every query and batch is counted against the budget. */
export function countingDb(db: D1Database, budget: Budget): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            budget.queries++;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    real.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          budget.queries++;
          return target.batch(statements.map((s) => real.get(s) ?? s));
        };
      }
      if (prop === "exec") {
        return (sql: string) => {
          budget.queries++;
          return target.exec(sql);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export async function buildCtx(env: Env, options: AppOptions): Promise<Ctx> {
  const budget = new Budget();
  const db = countingDb(env.DB, budget);
  const settings = await loadSettings(db, env.ADMIN_PASSWORD);
  return {
    env,
    db,
    settings,
    meta: options.meta(env, settings),
    now: options.now ?? Date.now,
    random: options.random ?? Math.random,
    budget,
  };
}

export interface ActivityEntry {
  kind: string;
  outcome: "sent" | "saved" | "received" | "skipped" | "failed" | "queued";
  reason?: string;
  campaignId?: number | null;
  commentId?: string | null;
  igUserId?: string | null;
  username?: string | null;
  detail?: string | null;
}

export function logStatement(ctx: Ctx, e: ActivityEntry): D1PreparedStatement {
  return ctx.db
    .prepare(
      "INSERT INTO activity (at, kind, outcome, reason, campaign_id, comment_id, ig_user_id, username, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      ctx.now(),
      e.kind,
      e.outcome,
      e.reason ?? null,
      e.campaignId ?? null,
      e.commentId ?? null,
      e.igUserId ?? null,
      e.username ?? null,
      e.detail ? e.detail.slice(0, 1000) : null,
    );
}

export async function log(ctx: Ctx, e: ActivityEntry): Promise<void> {
  await logStatement(ctx, e).run();
}
