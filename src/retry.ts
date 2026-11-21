import type { Ctx } from "./context";
import { paused } from "./throttle";
import { DAY, HOUR, MESSAGING_WINDOW, MINUTE, PRIVATE_REPLY_WINDOW, timeZoneOf } from "./time";

/**
 * When a send Meta refused for a passing reason (a rate limit, an outage) is tried
 * again. Both kinds follow the owner's schedule of 2026-11-21: 1, 5 and 30 minutes, then
 * 1, 3, 6 and 12 hours after the first refusal, and a tail that reaches toward the end
 * of Meta's window without passing it. A retry that would land past the window is
 * dropped, and the person waits under To check instead.
 */
const STEPS = [MINUTE, 5 * MINUTE, 30 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];

/** Kept clear of the end of Meta's window, so a retry is never refused for arriving late. */
const MARGIN = 15 * MINUTE;

/** The times a refused send is tried again, and the last moment one may go. */
export interface RetryPlan {
  times: number[];
  deadline: number;
}

/**
 * A first DM (private reply): the steps from the first refusal, then 24 and 48 hours, and
 * a last try about 6.5 days after the comment, inside Meta's 7 days.
 */
export function privateReplyPlan(firstRefusedAt: number, commentedAt: number): RetryPlan {
  const times = [...STEPS, DAY, 2 * DAY].map((d) => firstRefusedAt + d);
  times.push(commentedAt + 6.5 * DAY);
  return { times: times.sort((a, b) => a - b), deadline: commentedAt + PRIVATE_REPLY_WINDOW - MARGIN };
}

/**
 * A message after a tap or a reply: the steps from the first refusal, then a last try
 * about 21.5 hours after the person's tap or message, in the last tenth of Meta's 24
 * hours with room to spare.
 */
export function messagePlan(firstRefusedAt: number, lastInboundAt: number): RetryPlan {
  const times = STEPS.map((d) => firstRefusedAt + d);
  times.push(lastInboundAt + 21.5 * HOUR);
  return { times: times.sort((a, b) => a - b), deadline: lastInboundAt + MESSAGING_WINDOW - MARGIN };
}

/** The next try: which one it is out of how many, and when. */
export interface NextTry {
  n: number;
  total: number;
  at: number;
}

/**
 * The next try after `retriesDone` retries, or null when none is left inside the window.
 * Each gets a little random delay (a tenth of the wait, between 1 and 20 minutes), so a
 * burst of refusals doesn't all come back in the same minute. While Meta has paused the
 * app (throttle.ts), a try that would fall inside the pause goes after it.
 */
export function nextTry(ctx: Ctx, plan: RetryPlan, retriesDone: number): NextTry | null {
  const now = ctx.now();
  for (let i = Math.max(0, retriesDone); i < plan.times.length; i++) {
    const planned = plan.times[i]!;
    if (planned <= now) continue;
    const spread = Math.min(20 * MINUTE, Math.max(MINUTE, (planned - now) / 10));
    let at = planned + Math.floor(ctx.random() * spread);
    if (paused(ctx.load, now) && at < ctx.load.pausedUntil) at = ctx.load.pausedUntil + Math.floor(ctx.random() * 2 * MINUTE);
    if (at > plan.deadline) at = Math.max(planned, paused(ctx.load, now) ? ctx.load.pausedUntil : planned);
    if (at > plan.deadline) return null;
    return { n: i + 1, total: plan.times.length, at };
  }
  return null;
}

/** "9:40 am", or "Nov 22, 9:40 am" on another day, in the owner's zone. */
export function clockTime(ctx: Ctx, ms: number): string {
  const tz = timeZoneOf(ctx.settings);
  const day = (t: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(t);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(ms).replace(" AM", " am").replace(" PM", " pm");
  return day(ms) === day(ctx.now()) ? time : `${day(ms)}, ${time}`;
}

/**
 * What the activity log says about a refused send: which try it was and when the next
 * one is, "Meta rate limit or outage, try 3 of 10, next at 9:40 am"; the first refusal is
 * try 0, and is said as "will retry".
 */
export function retryLog(ctx: Ctx, tried: number, next: NextTry | null, total: number): string {
  const which = tried === 0 ? "will retry" : `try ${tried} of ${total}`;
  if (next) return `Meta rate limit or outage, ${which}, next at ${clockTime(ctx, next.at)}${next.n > tried + 1 ? ` (try ${next.n})` : ""}`;
  return `Meta rate limit or outage, ${which}, stopped retrying: send it from To check`;
}
