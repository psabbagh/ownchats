import type { AlertPayload } from "./alertmessage";
import { listCampaigns, type Campaign } from "./campaigns";
import { log, type Ctx } from "./context";
import { deliverNow, queueStatement, type Attempt } from "./leadwebhook";
import { TRANSIENT_REASON } from "./meta/client";
import { untakenPosts } from "./nextpost";
import { refusedSends } from "./refused";
import { clockTime } from "./retry";
import { saveSettings } from "./settings";
import { paused } from "./throttle";
import { DAY, HOUR, MINUTE, SECOND } from "./time";

/**
 * Owner alerts: a short message to the alert URL set in Settings when something needs
 * the owner, and another when it is fixed. Quiet by design (decision of 2026-11-21):
 *  - only problems the owner has to act on, or has to know people are waiting on;
 *  - a problem opens only after it has lasted its grace period, and closes only after
 *    it has been gone for CLEAR_AFTER, so a problem that comes and goes doesn't flap;
 *  - one message when it opens, one when it is fixed, and while it stays open at most
 *    one reminder every REMIND_EVERY;
 *  - at most DAILY_CAP messages in any 24 hours.
 * Checked by the Cron every minute, from what OwnChats already records: it costs D1
 * queries and no Meta call.
 */
export type AlertKey = "comments" | "webhook" | "token" | "waiting" | "gave_up" | "untaken" | "failures";

export const REMIND_EVERY = 12 * HOUR;
/** A problem must be gone this long before "fixed" goes out. */
export const CLEAR_AFTER = 30 * MINUTE;
/** Alert messages in any 24 hours, at most. Tests don't count. */
export const DAILY_CAP = 10;

/** Comments the check for missed comments found, over this window, that no webhook brought. */
export const MISSED_WINDOW = 3 * HOUR;
/** That many, and more than the webhooks brought over the same window, mean webhooks stopped. */
export const MISSED_AT_LEAST = 3;
/** No webhook at all for this long, while a campaign's post is young, also means webhooks stopped. */
export const QUIET_FOR = 6 * HOUR;
/** A campaign's post younger than this gets comments steadily, so silence from Meta is suspicious. */
export const YOUNG_POST = 2 * DAY;
/** People waiting this long on a send Meta refused for a passing reason (a rate limit) need the owner to know. */
export const WAITING_FOR = 30 * MINUTE;
/** A burst of DM failures: this many people... */
export const BURST_PEOPLE = 5;
/** ...whose DM failed for a reason OwnChats won't retry, within this window. */
export const BURST_WINDOW = HOUR;

/** How long each problem must last before it opens. */
const OPEN_AFTER: Record<AlertKey, number> = {
  // Built from windows of their own (MISSED_WINDOW, QUIET_FOR, WAITING_FOR, BURST_WINDOW).
  comments: 0,
  waiting: 0,
  failures: 0,
  // A stray POST to /webhook from a scanner sets the problem too; a real webhook in the next 15 minutes clears it.
  webhook: 15 * MINUTE,
  // Read once a day, so it is already stable.
  token: 0,
  // Every refusal it counts already went through about a week (or 21 hours) of retries.
  gave_up: 0,
  // The Cron attaches a waiting campaign within a minute or two of seeing its post; a caption fixed right away never alerts.
  untaken: 15 * MINUTE,
};

/** The problem's name in a "fixed" message. */
const FIXED: Record<AlertKey, string> = {
  comments: "comments are arriving from Meta again",
  webhook: "Meta's webhooks are accepted again",
  token: "Instagram is connected and the token works",
  waiting: "nobody is waiting on a refused DM any more",
  gave_up: "nobody is left waiting for you to send their DM",
  untaken: "every new post has a campaign or was marked not for one",
  failures: "DMs are going out again",
};

/** One problem as checked now. */
export interface Problem {
  key: AlertKey;
  title: string;
  message: string;
  people: number;
  /** The dashboard path where to act. */
  path: string;
}

/** What is remembered of each problem between runs, in the alert_state setting. */
interface State {
  /** First seen in the current streak of being present. */
  since?: number;
  open?: boolean;
  openedAt?: number;
  /** Last open or reminder message, or when one was held back by the daily cap. */
  notifiedAt?: number;
  /** Whether the owner was told it opened, so a "fixed" is worth sending. */
  told?: boolean;
  /** First seen gone while open. */
  goneSince?: number;
}

type States = Partial<Record<AlertKey, State>>;

export function alertStates(ctx: Ctx): States {
  try {
    const parsed = JSON.parse(ctx.settings.alert_state ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as States) : {};
  } catch {
    return {};
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every problem present now, from what OwnChats has recorded. */
export async function currentProblems(ctx: Ctx): Promise<Problem[]> {
  const s = ctx.settings;
  const now = ctx.now();
  const problems: Problem[] = [];
  const campaigns = await listCampaigns(ctx.db, true);

  // Meta's webhooks refused: nothing Meta sends is read.
  const [refusedAt, refusedWhy] = (s.last_webhook_problem ?? "").split("|");
  const webhookRefused = !!refusedWhy && Number(refusedAt) > Number(s.last_webhook_at ?? 0);
  if (webhookRefused) {
    problems.push({
      key: "webhook",
      title: "OwnChats is refusing Meta's webhooks",
      message: `Since ${clockTime(ctx, Number(refusedAt))}, what Meta sends is refused (${refusedWhy}), so new comments and DMs are not read as they come. Usually the app secret in setup doesn't match your Meta app's.`,
      people: 0,
      path: "/setup",
    });
  }

  // The token: stopped working, or Instagram disconnected. "Could not check" is a failed check, not a bad token.
  const connected = !!(s.access_token && s.ig_user_id);
  if (!connected && s.ig_user_id) {
    problems.push({
      key: "token",
      title: "Instagram is disconnected",
      message: `OwnChats can't reach Instagram, so no DM goes out${campaigns.length ? ` on your ${plural(campaigns.length, "campaign")} that are on` : ""}. Reconnect Instagram in setup.`,
      people: 0,
      path: "/setup",
    });
  } else if (connected && s.token_problem && !s.token_problem.startsWith("Could not check")) {
    problems.push({ key: "token", title: "Your Instagram token needs you", message: `${s.token_problem} Until then, DMs may stop going out.`, people: 0, path: "/setup" });
  }

  // People waiting on a refused send: still retried (WAITING_FOR in), or no longer retried (only the owner can send).
  const refused = [...(await refusedSends(ctx, campaigns.map((c) => c.id))).values()].flat();
  const waiting = refused.filter((r) => r.nextAt !== null && now - r.since >= WAITING_FOR);
  if (waiting.length) {
    const first = Math.min(...waiting.map((r) => r.since));
    // A pause lasts 10 minutes or so, and the people counted have waited 30: one that ended in that time is the likely reason.
    const why = paused(ctx.load, now) || ctx.load.pausedUntil > first ? "Instagram's rate limit has held back" : "Instagram has refused";
    problems.push({
      key: "waiting",
      title: `${plural(waiting.length, "person", "people")} waiting for a DM`,
      message: `${why} the DM ${waiting.length === 1 ? "of 1 person" : `of ${waiting.length} people`} for over ${WAITING_FOR / MINUTE} minutes (the first since ${clockTime(ctx, first)}). OwnChats keeps retrying on its own; you can send each one now from To check.`,
      people: waiting.length,
      path: "/dashboard#needs-you",
    });
  }
  const stopped = refused.filter((r) => r.nextAt === null);
  if (stopped.length) {
    // Listed until the owner sends it or marks it answered by hand, even after Meta's window closed.
    const open = stopped.filter((r) => r.canSend && r.left > 0);
    const closes = open.length ? Math.min(...open.map((r) => now + r.left)) : null;
    problems.push({
      key: "gave_up",
      title: `${plural(stopped.length, "person", "people")} need you to send their DM`,
      message: `Instagram refused ${stopped.length === 1 ? "a DM" : `${stopped.length} DMs`} and OwnChats has stopped retrying. ${
        closes ? `Send ${open.length === 1 ? "it" : "each"} from To check while Meta still allows it (the first window closes ${clockTime(ctx, closes)}), or` : "Meta's window has closed, so"
      } answer by hand in Instagram and mark it so under To check.`,
      people: stopped.length,
      path: "/dashboard#needs-you",
    });
  }

  // A post went up while a campaign waited and nothing took it.
  const untaken = untakenPosts(ctx, campaigns);
  if (untaken.length) {
    const first = untaken[0]!;
    problems.push({
      key: "untaken",
      title: untaken.length === 1 ? "A post went up with no campaign" : `${untaken.length} posts went up with no campaign`,
      message: `${untaken.length === 1 ? `Your post of ${clockTime(ctx, first.post.timestamp)}` : "They"} went up while ${first.waiting.map((c) => c.name).join(", ")} waited, and no campaign attached, so ${untaken.length === 1 ? "its" : "their"} comments get no DM. Attach ${untaken.length === 1 ? "it" : "each"} to its campaign, or mark it not for a campaign.`,
      people: untaken.length,
      path: "/dashboard#no-campaign",
    });
  }

  const [counts, failures] = await ctx.db.batch<Record<string, number | null>>([
    // Top-level comments by others, written and received in the window, by how they came.
    ctx.db
      .prepare(
        `SELECT COALESCE(SUM(source = 'poll'), 0) AS poll, COALESCE(SUM(source = 'webhook'), 0) AS webhook FROM comments
         WHERE received_at > ?1 AND commented_at > ?1 AND parent_id IS NULL AND (from_id IS NULL OR from_id <> ?2)`,
      )
      .bind(now - MISSED_WINDOW, s.ig_user_id ?? ""),
    // DMs that failed for a reason no retry will fix: rate limits and outages are retried, and counted above.
    ctx.db
      .prepare(
        `SELECT COUNT(DISTINCT COALESCE(ig_user_id, username, comment_id, id)) AS people, MAX(at) AS last FROM activity
         WHERE at > ? AND outcome = 'failed' AND kind IN ('private_reply', 'message') AND (reason IS NULL OR reason NOT LIKE ?)`,
      )
      .bind(now - BURST_WINDOW, `${TRANSIENT_REASON.split(",")[0]}%`),
  ]);

  // Comments stopped arriving. Not while webhooks are refused: that problem already says so.
  if (connected && !webhookRefused) {
    const poll = Number(counts!.results[0]?.poll ?? 0);
    const webhook = Number(counts!.results[0]?.webhook ?? 0);
    const quiet = quietPost(ctx, campaigns, await postedTimes(ctx, campaigns));
    if (poll >= MISSED_AT_LEAST && poll > webhook) {
      problems.push({
        key: "comments",
        title: "Comments are not arriving from Meta",
        message: `In the last ${MISSED_WINDOW / HOUR} hours the check for missed comments found ${plural(poll, "comment")} that Meta's webhooks never brought (they brought ${webhook}). Those get their DM late, up to minutes after the comment. Check the webhook subscription in setup.`,
        people: poll,
        path: "/setup",
      });
    } else if (quiet) {
      const last = Number(s.last_webhook_at);
      problems.push({
        key: "comments",
        title: `Nothing from Meta for ${Math.floor((now - last) / HOUR)} hours`,
        message: `No webhook since ${clockTime(ctx, last)}, while ${quiet.name} watches a post under ${YOUNG_POST / DAY} days old. If people are commenting, Meta has stopped sending comments and DMs. Check the webhook in setup.`,
        people: 0,
        path: "/setup",
      });
    }
  }

  // A burst of DM failures.
  const people = Number(failures!.results[0]?.people ?? 0);
  if (people >= BURST_PEOPLE) {
    const latest = await ctx.db
      .prepare(
        `SELECT reason FROM activity WHERE at > ? AND outcome = 'failed' AND kind IN ('private_reply', 'message') AND (reason IS NULL OR reason NOT LIKE ?) ORDER BY at DESC LIMIT 1`,
      )
      .bind(now - BURST_WINDOW, `${TRANSIENT_REASON.split(",")[0]}%`)
      .first<{ reason: string | null }>();
    problems.push({
      key: "failures",
      title: `DMs failing: ${plural(people, "person", "people")} in the last hour`,
      message: `Instagram refused the DM to ${plural(people, "person", "people")} in the last hour, for reasons OwnChats doesn't retry${latest?.reason ? ` (latest: ${latest.reason})` : ""}. See what Meta said in the activity log.`,
      people,
      path: "/dashboard/activity?show=failed",
    });
  }
  return problems;
}

/** When each campaign's post went up, from the hourly post list. */
async function postedTimes(ctx: Ctx, campaigns: Campaign[]): Promise<Map<string, number>> {
  const ids = campaigns.flatMap((c) => (c.mediaId ? [c.mediaId] : []));
  if (!ids.length) return new Map();
  const { results } = await ctx.db
    .prepare("SELECT media_id, posted_at FROM media_stats WHERE posted_at IS NOT NULL AND media_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ media_id: string; posted_at: number }>();
  return new Map(results.map((r) => [r.media_id, r.posted_at]));
}

/** A campaign whose young post has heard nothing from Meta for QUIET_FOR, once webhooks have worked at least once. */
function quietPost(ctx: Ctx, campaigns: Campaign[], posted: Map<string, number>): Campaign | null {
  const last = Number(ctx.settings.last_webhook_at ?? 0);
  const now = ctx.now();
  if (!last || now - last < QUIET_FOR) return null;
  return campaigns.find((c) => c.mediaId && now - (posted.get(c.mediaId) ?? 0) < YOUNG_POST) ?? null;
}

/** The full link to a dashboard path, when the Worker knows its own address. */
function linkTo(ctx: Ctx, path: string): string {
  return ctx.settings.base_url ? `${ctx.settings.base_url}${path}` : "";
}

/** Alert messages sent (or queued) in the last 24 hours, tests left out, and the oldest of them. */
async function sentToday(ctx: Ctx): Promise<{ n: number; oldest: number | null }> {
  const row = await ctx.db
    .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM deliveries WHERE event = 'alert' AND test = 0 AND created_at > ?")
    .bind(ctx.now() - DAY)
    .first<{ n: number; oldest: number | null }>();
  return { n: row?.n ?? 0, oldest: row?.oldest ?? null };
}

/** Queues one alert and tries it at once. Returns false when the daily cap held it back. */
async function send(ctx: Ctx, payload: AlertPayload, test = false): Promise<{ id: string | null; attempt: Attempt | null }> {
  if (!test) {
    const today = await sentToday(ctx);
    if (today.n >= DAILY_CAP) {
      await log(ctx, { kind: "alert", outcome: "skipped", reason: `Alert "${payload.title}" not sent: ${DAILY_CAP} alerts in 24 hours is the most OwnChats sends` });
      return { id: null, attempt: null };
    }
    if (today.n === DAILY_CAP - 1) {
      const until = (today.oldest ?? ctx.now()) + DAY;
      payload = { ...payload, message: `${payload.message}\n\nThat makes ${DAILY_CAP} alerts in 24 hours, the most OwnChats sends: none until ${clockTime(ctx, until)}. The dashboard shows the rest.` };
    }
  }
  const { id, statement } = queueStatement(ctx, { event: "alert", payload: payload as unknown as Record<string, unknown>, test });
  await statement.run();
  return { id, attempt: await deliverNow(ctx, id) };
}

/**
 * The Cron's part, every minute: compares the problems present now with those
 * remembered, and sends what changed. Does nothing while no alert URL is set, and
 * forgets every problem then, so setting a URL later starts from what is true then.
 */
export async function checkAlerts(ctx: Ctx): Promise<void> {
  if (!ctx.settings.alert_url) {
    if (ctx.settings.alert_state && ctx.settings.alert_state !== "{}") await saveAlertStates(ctx, {});
    return;
  }
  const now = ctx.now();
  const before = alertStates(ctx);
  const states: States = structuredClone(before);
  const present = new Map((await currentProblems(ctx)).map((p) => [p.key, p]));
  const keys = new Set<AlertKey>([...(Object.keys(states) as AlertKey[]), ...present.keys()]);
  for (const key of keys) {
    const p = present.get(key);
    const st: State = states[key] ?? {};
    if (p) {
      delete st.goneSince;
      st.since ??= now;
      const payload = (status: AlertPayload["status"], title: string, message: string): AlertPayload => ({
        problem: key,
        status,
        title,
        message,
        people: p.people,
        url: linkTo(ctx, p.path),
        opened_at: st.openedAt ?? now,
      });
      if (!st.open && now - st.since >= OPEN_AFTER[key]) {
        st.open = true;
        st.openedAt = now;
        st.notifiedAt = now;
        st.told = (await send(ctx, payload("open", p.title, p.message))).id !== null;
      } else if (st.open && now - (st.notifiedAt ?? 0) >= REMIND_EVERY) {
        st.notifiedAt = now;
        const told = (await send(ctx, payload("reminder", `Still open: ${p.title}`, `${p.message} Open since ${clockTime(ctx, st.openedAt ?? now)}.`))).id !== null;
        st.told ||= told;
      }
      states[key] = st;
      continue;
    }
    if (!st.open) {
      delete states[key];
      continue;
    }
    st.goneSince ??= now;
    if (now - st.goneSince < CLEAR_AFTER) {
      states[key] = st;
      continue;
    }
    if (st.told) {
      await send(ctx, {
        problem: key,
        status: "fixed",
        title: `Fixed: ${FIXED[key]}`,
        message: `Since ${clockTime(ctx, st.goneSince)}, ${FIXED[key]}. It was open from ${clockTime(ctx, st.openedAt ?? st.goneSince)}.`,
        people: 0,
        url: linkTo(ctx, "/dashboard"),
        opened_at: st.openedAt ?? null,
      });
    }
    delete states[key];
  }
  if (JSON.stringify(states) !== JSON.stringify(before)) await saveAlertStates(ctx, states);
}

async function saveAlertStates(ctx: Ctx, states: States): Promise<void> {
  const value = JSON.stringify(states);
  ctx.settings.alert_state = value;
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { alert_state: value });
}

/** The problems open now, for Settings: which, and since when. */
export function openAlerts(ctx: Ctx): Array<{ key: AlertKey; since: number }> {
  return Object.entries(alertStates(ctx)).flatMap(([key, st]) => (st?.open && !st.goneSince ? [{ key: key as AlertKey, since: st.openedAt ?? 0 }] : []));
}

/** Each problem's name in Settings' list of open alerts. */
export const ALERT_NAME: Record<AlertKey, string> = {
  comments: "Comments not arriving from Meta",
  webhook: "Meta's webhooks refused",
  token: "Instagram token or connection",
  waiting: "People waiting on a refused DM",
  gave_up: "People waiting for you to send their DM",
  untaken: "A post with no campaign",
  failures: "A burst of DM failures",
};

/** "Send a test alert": a message marked as a test, sent like a real one, outside the daily cap and the alert state. */
export async function sendTestAlert(ctx: Ctx): Promise<{ id: string; attempt: Attempt | null } | null> {
  if (!ctx.settings.alert_url) return null;
  const sent = await send(
    ctx,
    {
      problem: "test",
      status: "test",
      title: "OwnChats test alert",
      message: `This is a test from OwnChats${ctx.settings.ig_username ? ` for @${ctx.settings.ig_username}` : ""}, sent ${clockTime(ctx, ctx.now())}. Alerts arrive like this one when something needs you, and once more when it's fixed.`,
      people: 0,
      url: linkTo(ctx, "/dashboard"),
      opened_at: null,
    },
    true,
  );
  return sent.id ? { id: sent.id, attempt: sent.attempt } : null;
}

/** How often the heartbeat URL is pinged. */
export const HEARTBEAT_EVERY = 10 * MINUTE;
const HEARTBEAT_TIMEOUT = 10 * SECOND;

/**
 * Pings the heartbeat URL (a healthchecks.io-style check) every HEARTBEAT_EVERY, with a
 * GET. That service alerts when the pings stop, which covers what no alert from
 * inside can: the Worker or its Cron not running at all. A failed ping is noted for
 * Settings and not retried before the next one is due.
 */
export async function heartbeat(ctx: Ctx): Promise<void> {
  const url = ctx.settings.heartbeat_url;
  const now = ctx.now();
  // The Cron fires on the minute, give or take; half a minute of slack keeps a 10-minute rhythm from slipping to 11.
  if (!url || now - Number(ctx.settings.heartbeat_at ?? 0) < HEARTBEAT_EVERY - 30 * SECOND) return;
  if (!ctx.budget.take()) return;
  let problem = "";
  try {
    const res = await ctx.fetch(url, { method: "GET", headers: { "user-agent": "OwnChats-Heartbeat/1" }, redirect: "follow", signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT) });
    if (!res.ok) problem = `HTTP ${res.status}`;
    await res.body?.cancel();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    problem = name === "TimeoutError" || name === "AbortError" ? `timed out after ${HEARTBEAT_TIMEOUT / SECOND} seconds` : `could not connect (${err instanceof Error ? err.message : String(err)})`.slice(0, 200);
  }
  const values = { heartbeat_at: String(now), heartbeat_problem: problem ? `${now}|${problem}` : "" };
  Object.assign(ctx.settings, values);
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, values);
}
