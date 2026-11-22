import {
  answersShortcuts,
  campaignFromForm,
  DEFAULT_LIMITS,
  DEFAULTS,
  fill,
  getCampaign,
  listCampaigns,
  NEXT_POST,
  ownDefaults,
  postLabel,
  saveCampaign,
  setCampaignActive,
  type Campaign,
  type CampaignInput,
  type EmailMode,
} from "../campaigns";

export const EMAIL_MODE_LABEL: Record<EmailMode, string> = { none: "link only", optional: "link plus optional email", first: "email first" };

/** The flows a new campaign can start from. Everything they set stays editable in the form. */
export type StartFlow = "link" | "email";
const START_FLOWS: Record<StartFlow, { openingButton: string; emailMode: EmailMode; label: string; hint: string }> = {
  link: { openingButton: "", emailMode: "none", label: "DM with the link", hint: "The first DM carries the link. No email ask." },
  // The tap brings the link, and the email ask follows once they open it, so nobody has to give an email to get it.
  email: {
    openingButton: DEFAULTS.openingButton,
    emailMode: "optional",
    label: "DM with a button, then ask for their email",
    hint: "The first DM has a button. The tap brings the link, and once they open it, a message asks for their email.",
  },
};

export function newCampaignDefaults(settings: Settings, flow: StartFlow): CampaignInput {
  // The owner's own wording from Settings, where they chose one.
  const own = ownDefaults(settings);
  return {
    name: "",
    videoId: "",
    keywords: [],
    anyComment: false,
    mediaId: null,
    mediaLabel: null,
    nextPostAfter: null,
    publicReplies: DEFAULTS.publicReplies,
    openingText: DEFAULTS.openingText,
    openingButton: START_FLOWS[flow].openingButton,
    emailMode: START_FLOWS[flow].emailMode,
    emailPrompt: DEFAULTS.emailPrompt,
    emailReask: DEFAULTS.emailReask,
    emailThanks: DEFAULTS.emailThanks,
    optionalPrompt: own.optionalPrompt,
    optionalThanks: own.optionalThanks,
    optionalThanksButton: own.optionalThanksButton,
    consentText: "",
    emailTag: "",
    linkText: own.linkText,
    links: [{ label: own.linkLabel, url: "" }],
    linkTitle: "",
    followCheck: false,
    followPrompt: DEFAULTS.followPrompt,
    followReask: DEFAULTS.followReask,
    followButton: DEFAULTS.followButton,
    // Off by default: a keyword that is a common word ("traffic") would answer ordinary DMs.
    dmKeyword: false,
    active: true,
  };
}
import type { Ctx } from "../context";
import { trackingBase } from "../clicks";
import { randomToken, sha256Hex } from "../crypto";
import { leadsCsv, listLeads } from "../export";
import { ALERT_NAME, HEARTBEAT_EVERY, openAlerts, sendTestAlert } from "../alerts";
import { checkTestLead, getDelivery, MIN_SECRET_LENGTH, recentDeliveries, sendTestLead, webhookConfig, type DeliveryRow } from "../leadwebhook";
import { parseKeywords } from "../match";
import type { Media } from "../meta/client";
import { pollEvery, recentMedia } from "../pipeline/poll";
import { MISSING_PERMISSION, readMediaStats } from "../insights";
import { missedComments, timeLeft, type MissedComment } from "../missed";
import { peopleCounts, refusedPeople, refusedSends, type RefusedPeople, type RefusedSend } from "../refused";
import { BUSY_PERCENT, currentUsage, paused } from "../throttle";
import { attachUntakenPost, dismissUntakenPost, untakenPosts, type UntakenPost } from "../nextpost";
import { deleteSettings, saveSettings, shortcutKeywords, type Settings } from "../settings";
import { CHART_DAYS, campaignCounts, campaignRecent, deletePerson, failuresSince, findPersonByUsername, listActivity, storedAboutPeople, type ActivityRow, type CampaignRecent } from "../stats";
import { copyField, fmtCount, fmtDate, fmtTime, html, page, plural, raw, redirect, type Html } from "./html";
import { DAY, HOUR, isTimeZone, MINUTE, timeZoneOf } from "../time";

/** Which post a campaign watches, in a few words. */
export function postWords(c: Campaign): string {
  if (c.mediaId) return c.mediaLabel || `post ${c.mediaId}`;
  return c.nextPostAfter !== null ? "your next post (waiting for it)" : "all posts";
}

/**
 * What a campaign answers, in a few plain words: "Comment SKILLS on Claude skills pack reel",
 * with its other spellings on hover, and the email ask only when there is one.
 */
export function askLine(c: Campaign): Html {
  const email = c.emailMode === "optional" ? ", then asks for their email" : c.emailMode === "first" ? ", asks for their email first" : "";
  if (c.anyComment || !c.keywords.length) return html`Any comment on ${postWords(c)}${email}`;
  const [first, ...more] = c.keywords;
  const others = more.length
    ? html` <span title="Also answers: ${more.join(", ")}">(+${plural(more.length, "spelling")})</span>`
    : "";
  return html`Comment <b>${first}</b>${others} on ${postWords(c)}${email}`;
}

/** Whether a campaign answers the shortcut keywords from Settings, in a sentence, or nothing when none are set. */
export function shortcutNote(c: Campaign, shortcuts: string[]): Html {
  if (!shortcuts.length || c.anyComment) return html``;
  const link = html`<a href="/dashboard/settings#shortcuts">shortcut keywords</a>`;
  return answersShortcuts(c)
    ? html`Also answers your ${link}: ${shortcuts.join(", ")}.`
    : html`Your ${link} (${shortcuts.join(", ")}) don't apply to a campaign on all posts.`;
}

export function healthBanner(ctx: Ctx): Html {
  const s = ctx.settings;
  const notes: Html[] = [];
  if (!s.access_token || !s.ig_user_id) notes.push(html`Instagram is not connected yet. Finish the <a href="/setup">setup checklist</a>.`);
  if (s.token_problem) notes.push(html`${s.token_problem} <a href="/setup">Open setup</a>.`);
  const [at, problem] = (s.last_webhook_problem ?? "").split("|");
  if (problem && Number(at) > Number(s.last_webhook_at ?? 0)) notes.push(html`A webhook from Meta was refused: ${problem}. Check the app secret on <a href="/setup">setup</a>.`);
  if (!notes.length) return html``;
  return html`<div class="card notice">${notes.map((n) => html`<p>${n}</p>`)}</div>`;
}

/** A problem the Cron saved as "at|detail", in a sentence. */
function cronProblem(saved: string | undefined, what: string, tz: string): Html | null {
  const [at, detail] = (saved ?? "").split("|");
  return detail ? html`${what} failed (${fmtTime(Number(at), tz)}): ${detail}` : null;
}

/** How close Meta's rate limit is, when near it. A pause after a refusal is the first line of "Needs you" instead. */
function metaLoadLine(ctx: Ctx): Html | string {
  const now = ctx.now();
  if (paused(ctx.load, now)) return "";
  const usage = currentUsage(ctx.load, now);
  if (usage && usage.percent >= BUSY_PERCENT) {
    // A status, not a to-do: the readings per limit are on hover.
    return html`<p class="small status-note" title="Meta's readings: ${usage.detail}"><span class="dot warn" aria-hidden="true"></span>Instagram's limit is at ${Math.round(usage.percent)}%. OwnChats checks for missed comments less often; DMs still go first.</p>`;
  }
  return "";
}

/** ", 14 h left to answer" for the soonest of these still inside Meta's window, or nothing when none is. */
function leftWords(list: RefusedSend[]): string {
  const left = Math.min(...list.filter((r) => r.left > 0).map((r) => r.left));
  if (!Number.isFinite(left)) return "";
  if (left >= 2 * DAY) return `, ${Math.floor(left / DAY)} days left to answer`;
  if (left >= HOUR) return `, ${Math.floor(left / HOUR)} h left to answer`;
  return `, ${Math.max(1, Math.floor(left / MINUTE))} min left to answer`;
}

/** What Meta refused in the last 24 hours, for diagnosis: attempts, its code, and what became of the people. */
export interface RefusalHealth {
  attempts: number;
  /** Meta's most frequent error code among them, when the log has one. */
  code: number | null;
  people: RefusedPeople;
  /** Other failures in the log (follow checks, the lead webhook), public replies left out. */
  other: number;
}

async function refusalHealth(ctx: Ctx, campaignIds: number[], refused: Map<number, RefusedSend[]>): Promise<RefusalHealth> {
  const since = ctx.now() - DAY;
  const { results } = await ctx.db
    .prepare("SELECT detail FROM activity WHERE outcome = 'failed' AND kind IN ('private_reply', 'message') AND at > ?")
    .bind(since)
    .all<{ detail: string | null }>();
  const codes = new Map<number, number>();
  for (const r of results) {
    const code = Number(/\bcode (\d+)/.exec(r.detail ?? "")?.[1]);
    if (Number.isFinite(code) && code > 0) codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  const code = [...codes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const people: RefusedPeople = { people: 0, recovered: 0, answeredByHand: 0, waiting: 0, unreached: 0 };
  for (const p of (await refusedPeople(ctx, campaignIds, refused, since)).values()) {
    for (const k of Object.keys(people) as Array<keyof RefusedPeople>) people[k] += p[k];
  }
  return { attempts: results.length, code, people, other: Math.max(0, (await failuresSince(ctx, since)) - results.length) };
}

/** Meta's error codes OwnChats can name. */
const CODE_WORDS: Record<number, string> = { 4: "its app rate limit", 17: "its user rate limit", 32: "its page rate limit", 613: "a rate limit", 80002: "the account's rate limit", 2: "an outage", 1: "an outage" };

/**
 * What Meta refused over the last 24 hours, as history rather than a to-do: one short line on what
 * became of the people, linking to the log, with the attempts and Meta's error code on hover.
 * People still waiting are listed under Needs you, with links, so here they are only counted.
 */
function refusalLine(h: RefusalHealth): Html | string {
  const lines: Html[] = [];
  if (h.attempts) {
    const p = h.people;
    const why = h.code !== null ? `, mostly code ${h.code}${CODE_WORDS[h.code] ? ` (${CODE_WORDS[h.code]})` : ""}` : "";
    const fates = [
      p.recovered ? `${plural(p.recovered, "person", "people")} got it on a retry` : "",
      p.answeredByHand ? `${p.answeredByHand} answered by hand` : "",
      p.waiting ? `${p.waiting} still waiting` : "",
      p.unreached ? `${p.unreached} not reached` : "",
    ].filter(Boolean);
    const detail = `${plural(h.attempts, "DM attempt")} refused in the last 24 hours${why}${fates.length ? `: ${fates.join(", ")}` : ""}.`;
    const open = p.waiting + p.unreached;
    const what = !p.people
      ? `Instagram refused ${plural(h.attempts, "DM attempt")} in the last 24 hours`
      : `Instagram's limit in the last 24 hours: ${plural(p.people, "person", "people")} affected, ${open ? [p.waiting ? `${p.waiting} still waiting` : "", p.unreached ? `${p.unreached} not reached` : ""].filter(Boolean).join(", ") : "all answered"}`;
    lines.push(html`<a href="/dashboard/activity?show=failed" title="${detail}">${what}</a>`);
  }
  if (h.other) lines.push(html`<a href="/dashboard/activity?show=failed">${plural(h.other, "other failure")}</a> in the last 24 hours`);
  return lines.length ? html`<p class="muted small status-note">${lines.map((x, i) => (i ? html`. ${x}` : x))}.</p>` : "";
}

/** Meta's rate limit was reached: until when, how many people wait for a send, and when the next try is. */
function rateLimitLine(ctx: Ctx, refused: Map<number, RefusedSend[]>, tz: string): Html {
  const waiting = [...refused.values()].flat();
  const next = Math.min(...waiting.flatMap((r) => (r.nextAt !== null ? [r.nextAt] : [])));
  const until = fmtTime(ctx.load.pausedUntil, tz);
  const who = waiting.length
    ? html` <b>${plural(waiting.length, "person is", "people are")} waiting for a DM</b> Meta refused.${Number.isFinite(next)
        ? html` ${next > ctx.load.pausedUntil + MINUTE ? html`OwnChats tries again from ${fmtTime(next, tz)}.` : "OwnChats tries again once the pause ends."} To send one sooner, open its campaign below.`
        : " OwnChats has stopped retrying them: send them from their campaign below."}`
    : " Nobody is waiting: new DMs still go out first.";
  return html`<span class="warn"><b>Instagram's rate limit was reached.</b></span> OwnChats holds back its background reads until ${until}.${who}`;
}

/** What the owner should look at, most urgent first: each line says what, and links to where to act. */
function needsYou(ctx: Ctx, campaigns: Campaign[], missed: Map<number, MissedComment[]>, refused: Map<number, RefusedSend[]>, tz: string): Html[] {
  const s = ctx.settings;
  const items: Array<Html | null> = [];
  // While Meta refuses, one line says so with everyone waiting, above the per-campaign lines that link to them.
  if (paused(ctx.load, ctx.now())) items.push(rateLimitLine(ctx, refused, tz));
  // People who asked and got nothing yet come first: their window runs out. Only people still waiting: anyone answered, by OwnChats or by hand, has left the list.
  for (const c of campaigns) {
    const list = refused.get(c.id);
    if (!list?.length) continue;
    const tapped = list.filter((r) => r.type === "message");
    const firstDm = list.filter((r) => r.type === "comment");
    const parts = [
      ...(tapped.length ? [`${plural(tapped.length, "person", "people")} tapped and got nothing${leftWords(tapped)}`] : []),
      ...(firstDm.length ? [`${plural(firstDm.length, "person", "people")} never got the first DM${leftWords(firstDm)}`] : []),
    ];
    items.push(html`<a href="/dashboard/campaigns/${c.id}#to-check">${c.name}: ${parts.join("; ")}</a>`);
  }
  // Each problem is cleared by the next good run, and those runs only happen with work to do.
  if (campaigns.some((c) => c.active && c.nextPostAfter === null)) items.push(cronProblem(s.last_poll_problem, "The last check for missed comments", tz));
  if (campaigns.some((c) => c.nextPostAfter !== null)) items.push(cronProblem(s.next_post_problem, "The last look for your next post", tz));
  // Each such post is an entry in the list below, where its choices are; this only points there.
  const untaken = untakenPosts(ctx, campaigns);
  if (untaken.length) {
    items.push(html`<a href="#no-campaign">${untaken.length > 1 ? `${untaken.length} posts` : "A post"} went up with no campaign</a>: say what ${untaken.length > 1 ? "each is" : "it is"} for.`);
  }
  const toCheck = campaigns.flatMap((c) => {
    const list = missed.get(c.id);
    return list?.length ? [{ c, n: list.length, left: Math.min(...list.map((m) => m.left)) }] : [];
  });
  for (const { c, n, left } of toCheck.sort((a, b) => a.left - b.left)) {
    items.push(html`<a href="/dashboard/campaigns/${c.id}#to-check">${plural(n, "comment")} to check on ${c.name}</a> <span class="muted">(${n > 1 ? "oldest: " : ""}${timeLeft(left)})</span>`);
  }
  return items.filter((i): i is Html => i !== null);
}

/** Says the state and changes it. The form sends the state wanted, so a double click or an old tab can't flip it back. */
function campaignSwitch(c: Campaign, calls: number | null = null, show: Show = "all"): Html {
  const saves = calls === null ? "" : ` It saves ${callsWords(calls)}, and comments`;
  const ask = `Turn off ${c.name}?${saves || " Comments"} that arrive while it is off get no DM.`;
  return html`<form class="switch-form" method="post" action="/dashboard/campaigns/${c.id}/switch"${c.active ? html` data-ask="${ask}" onsubmit="return confirm(this.dataset.ask)"` : ""}>
    <input type="hidden" name="active" value="${c.active ? "off" : "on"}">${show !== "all" ? html`<input type="hidden" name="show" value="${show}">` : ""}<button class="switch${c.active ? " on" : ""}" role="switch" aria-checked="${c.active ? "true" : "false"}" title="${c.active ? `On${calls === null ? "" : `, costing ${callsWords(calls)}`}. Click to turn off.` : "Off. Click to turn on."}">${c.active ? "on" : "off"}</button></form>`;
}

/** "Not for a campaign" on a flagged post: stop flagging it. */
export async function dismissPostForm(ctx: Ctx, request: Request): Promise<Response> {
  await dismissUntakenPost(ctx, String((await request.formData()).get("media_id") ?? ""));
  return redirect("/dashboard");
}

/** "Attach" on a post with no campaign: the chosen waiting campaign takes it. */
export async function attachPostForm(ctx: Ctx, request: Request): Promise<Response> {
  const form = await request.formData();
  const campaignId = String(form.get("campaign_id") ?? "");
  await attachUntakenPost(ctx, String(form.get("media_id") ?? ""), /^\d{1,10}$/.test(campaignId) ? Number(campaignId) : NaN);
  return redirect("/dashboard");
}

/**
 * A recent post no campaign has, shown in the list with the campaigns: what it is, and its
 * two choices side by side. Attach offers only the campaigns that were waiting when it went up.
 */
function untakenEntry({ post, waiting }: UntakenPost, tz: string): Html {
  const asks = waiting.map((c) => (c.anyComment ? `${c.name} (any comment)` : `${c.name} (Comment ${c.keywords[0] ?? ""})`));
  return html`<div class="card row campaign untaken" id="post-${post.id}">
    <span class="cover" aria-hidden="true">${post.thumbnailUrl ? html`<img src="${post.thumbnailUrl}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
    <div class="body">
      <div class="row"><h3 style="flex:1 1 auto">${postLabel(post)}</h3><span class="pill">No campaign</span></div>
      <p class="muted small">Posted ${post.permalink ? html`<a href="${post.permalink}" rel="noopener noreferrer" target="_blank">${fmtTime(post.timestamp, tz)}</a>` : fmtTime(post.timestamp, tz)}. No campaign attached to it.</p>
      <div class="row choices">
        <form method="post" action="/dashboard/posts/attach" class="row">
          <input type="hidden" name="media_id" value="${post.id}">
          ${waiting.length > 1
            ? html`<select name="campaign_id" aria-label="Campaign">${waiting.map((c, i) => html`<option value="${c.id}">${asks[i]}</option>`)}</select><button class="small">Attach</button>`
            : html`<input type="hidden" name="campaign_id" value="${waiting[0]!.id}"><button class="small">Attach to ${asks[0]}</button>`}
        </form>
        <form method="post" action="/dashboard/posts/dismiss"><input type="hidden" name="media_id" value="${post.id}"><button class="secondary small">Not for a campaign</button></form>
      </div>
      <p class="hint">Attach if it is that campaign's post: comments already on it get their DM too. Otherwise, it is not for a campaign.</p>
    </div></div>`;
}

export async function switchCampaign(ctx: Ctx, request: Request, id: number): Promise<Response> {
  const form = await request.formData();
  const wanted = String(form.get("active") ?? "");
  const show = showFrom(String(form.get("show") ?? ""));
  const filter = show === "all" ? "" : `show=${show}&`;
  if (wanted !== "on" && wanted !== "off") return redirect(`/dashboard${filter ? `?${filter.slice(0, -1)}` : ""}`);
  await setCampaignActive(ctx.db, id, wanted === "on", ctx.now());
  // Back to the same row, in the same filter, which says what changed; the page's script puts the scroll back where it was.
  return redirect(`/dashboard?${filter}switched=${id}#c-${id}`);
}

/** How long ago, in the largest whole unit: "just now", "40 minutes ago", "5 hours ago", "3 days ago". */
export function ago(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < MINUTE) return "just now";
  if (d < HOUR) return `${plural(Math.floor(d / MINUTE), "minute")} ago`;
  if (d < DAY) return `${plural(Math.floor(d / HOUR), "hour")} ago`;
  return `${plural(Math.floor(d / DAY), "day")} ago`;
}

/** The list's order: newest post first, whether the campaign is on or off, so a switch never moves a row. */
export function campaignOrder(campaigns: Campaign[], postedAt: (c: Campaign) => number | null): Campaign[] {
  // A campaign waiting for the next post is for the newest post of all; one on all posts dates from its start.
  const key = (c: Campaign) => (c.nextPostAfter !== null ? Infinity : postedAt(c) ?? c.createdAt);
  return [...campaigns].sort((a, b) => key(b) - key(a) || b.createdAt - a.createdAt || b.id - a.id);
}

/** Which campaigns the list shows. "quiet": on, but no matching comment in the last 7 days. */
export type Show = "all" | "on" | "off" | "quiet";
const SHOWS: Show[] = ["all", "on", "off", "quiet"];
const SHOW_LABEL: Record<Show, string> = { all: "All", on: "On", off: "Off", quiet: "Quiet 7 days" };
export function showFrom(value: string | null): Show {
  return SHOWS.includes(value as Show) ? (value as Show) : "all";
}

/** A campaign counts as quiet once it has gone this long without a matching comment. */
const QUIET_AFTER = 7 * DAY;

/**
 * Days since a campaign that is on last matched a comment, once that is a week or more;
 * null otherwise. A campaign still waiting for its post is not quiet, it has no post yet.
 */
export function quietDays(c: Campaign, recent: CampaignRecent | undefined, now: number): number | null {
  if (!c.active || c.nextPostAfter !== null) return null;
  const since = recent?.lastComment?.at ?? c.createdAt;
  return now - since >= QUIET_AFTER ? Math.floor((now - since) / DAY) : null;
}

/**
 * The Meta calls an hour a campaign that is on costs, and turning it off saves: its post's
 * comment checks (pollEvery), every 15 minutes while the post is new. Its post's numbers are
 * read whether or not a campaign watches it, so they don't count. Null for a campaign on
 * all posts or waiting for one, which watches no single post.
 */
export function campaignCalls(c: Campaign, postedAt: number | null, now: number): number | null {
  if (!c.mediaId || c.nextPostAfter !== null) return null;
  return HOUR / Math.max(pollEvery(postedAt, now), MINUTE);
}

/** A day in plain words, in the owner's zone: "today", "yesterday", "3 days ago", then "Nov 2" (with the year when it isn't this one). */
export function dayWords(ms: number, now: number, tz: string): string {
  const day = fmtDate(ms, tz);
  if (day === fmtDate(now, tz)) return "today";
  if (day === fmtDate(now - DAY, tz)) return "yesterday";
  // Whole days between the two dates, so a campaign from 11 pm three days ago reads "3 days ago".
  const days = Math.round((Date.parse(fmtDate(now, tz)) - Date.parse(day)) / DAY);
  if (days > 1 && days < 7) return `${days} days ago`;
  const sameYear = day.slice(0, 4) === fmtDate(now, tz).slice(0, 4);
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }).format(ms);
}

/** "about 1 Meta call an hour", "about 4 Meta calls an hour", "1 Meta call every 3 hours". */
export function callsWords(perHour: number): string {
  if (perHour < 1) return `1 Meta call every ${Math.round(1 / perHour)} hours`;
  const n = Math.round(perHour);
  return `about ${n} Meta ${n === 1 ? "call" : "calls"} an hour`;
}

/** First DMs per day over the last 14 days, as small bars: the newest day on the right. */
export function dmChart(days: number[]): Html {
  const max = Math.max(...days);
  const total = days.reduce((a, b) => a + b, 0);
  const label = `First DMs per day, last ${days.length} days: ${days.join(", ")} (${total} in all)`;
  const bars = days.map((n, i) => {
    const h = max ? Math.max(1, Math.round((n / max) * 18)) : 0;
    return html`<rect x="${i * 6}" y="${20 - h}" width="4" height="${h}" rx="1"></rect>`;
  });
  return html`<svg class="dm-chart" viewBox="0 0 ${days.length * 6 - 2} 20" width="${days.length * 6 - 2}" height="20" role="img" aria-label="${label}"><title>${label}</title><line x1="0" y1="19.5" x2="${days.length * 6 - 2}" y2="19.5"></line>${bars}</svg>`;
}

/** What the owner needs to decide whether a campaign is still worth having on, in one line. */
function recentLine(c: Campaign, postedAt: number | null, recent: CampaignRecent | undefined, now: number, tz: string): Html {
  const last = recent?.lastComment;
  const text = last?.text ? (last.text.length > 60 ? `${last.text.slice(0, 57).trimEnd()}...` : last.text) : "";
  const parts = [
    postedAt ? html`<span>Reel posted <b>${ago(postedAt, now)}</b></span>` : null,
    last
      ? html`<span>Last matching comment <b>${ago(last.at, now)}</b>${text ? html` <span class="muted">"${text}"</span>` : ""}</span>`
      : html`<span>No matching comment ${now - c.createdAt > KEPT_COMMENTS ? "in 30 days" : "yet"}</span>`,
    html`<span class="dms"><b>${fmtCount(recent?.dmsLastWeek ?? 0)}</b> ${recent?.dmsLastWeek === 1 ? "DM" : "DMs"} in the last 7 days ${dmChart(recent?.dmsByDay ?? new Array<number>(CHART_DAYS).fill(0))}</span>`,
  ];
  return html`<p class="small recent">${parts.filter((p) => p !== null)}</p>`;
}

/** How long comments are kept, so "no matching comment" can say over what period. */
const KEPT_COMMENTS = 30 * DAY;

/** Keeps the scroll where it was across a switch, so the row stays under the pointer, and drops "switched" from the address. */
const KEEP_SCROLL = `document.addEventListener('submit',e=>{if(!e.defaultPrevented&&e.target.matches('form.switch-form')){try{sessionStorage.setItem('ownchats-y',String(scrollY))}catch(_){}}});
try{const y=sessionStorage.getItem('ownchats-y');if(y!==null){sessionStorage.removeItem('ownchats-y');addEventListener('load',()=>scrollTo(0,Number(y)));}}catch(_){}
try{const u=new URL(location.href);if(u.searchParams.has('switched')){u.searchParams.delete('switched');history.replaceState(null,'',u.pathname+u.search+u.hash)}}catch(_){}`;

export async function dashboardHome(ctx: Ctx, switched: string | null = null, showParam: string | null = null): Promise<Response> {
  const show = showFrom(showParam);
  const all = await listCampaigns(ctx.db);
  const stats = await readMediaStats(ctx, all.flatMap((c) => (c.mediaId ? [c.mediaId] : [])));
  const postedAt = (c: Campaign) => (c.mediaId ? stats.get(c.mediaId)?.postedAt ?? null : null);
  // Sorted here only: listCampaigns keeps id order, which DM keyword matching relies on.
  const campaigns = campaignOrder(all, postedAt);
  const on = campaigns.filter((c) => c.active);
  const counts = await campaignCounts(ctx);
  const recent = await campaignRecent(ctx);
  const missed = await missedComments(ctx, on);
  const refused = await refusedSends(ctx, campaigns.map((c) => c.id));
  const health = await refusalHealth(ctx, campaigns.map((c) => c.id), refused);
  const people = await peopleCounts(ctx, campaigns.map((c) => c.id), refused);
  const noPermission = on.some((c) => c.mediaId && stats.get(c.mediaId)?.problem === MISSING_PERMISSION);
  const s = ctx.settings;
  const tz = timeZoneOf(s);
  const clicksOn = trackingBase(ctx) !== null;
  const banner = healthBanner(ctx);
  const items = needsYou(ctx, campaigns, missed, refused, tz);
  const untaken = untakenPosts(ctx, campaigns);

  const now = ctx.now();
  const matches: Record<Show, (c: Campaign) => boolean> = {
    all: () => true,
    on: (c) => c.active,
    off: (c) => !c.active,
    quiet: (c) => quietDays(c, recent.get(c.id), now) !== null,
  };
  // The row just switched stays in view even when it no longer fits the filter, so the switch visibly did something.
  const shown = campaigns.filter((c) => matches[show](c) || switched === String(c.id));
  const chips = html`<nav class="chips small" aria-label="Show">${SHOWS.map((f) => {
    const n = campaigns.filter(matches[f]).length;
    return f === show
      ? html`<a class="chip current" aria-current="page" href="/dashboard${f === "all" ? "" : `?show=${f}`}">${SHOW_LABEL[f]} (${n})</a>`
      : html`<a class="chip" href="/dashboard${f === "all" ? "" : `?show=${f}`}">${SHOW_LABEL[f]} (${n})</a>`;
  })}</nav>`;

  const card = (c: Campaign) => {
    const n = counts.get(c.id);
    const p = people.get(c.id);
    const views = c.mediaId ? stats.get(c.mediaId)?.views : undefined;
    // Instagram's cover image for the post: the Reel's first frame unless another cover was chosen. Kept fresh by the hourly post list.
    const cover = c.mediaId ? stats.get(c.mediaId)?.thumbnailUrl : null;
    const justSwitched = switched === String(c.id);
    const quiet = quietDays(c, recent.get(c.id), now);
    return html`<div class="card row campaign${c.active ? "" : " off"}" id="c-${c.id}">
      <a class="cover" href="/dashboard/campaigns/${c.id}" aria-hidden="true" tabindex="-1">${cover ? html`<img src="${cover}" alt="" loading="lazy" onerror="this.remove()">` : ""}</a>
      <div class="body">
      <div class="row"><h3 style="flex:1 1 auto"><a href="/dashboard/campaigns/${c.id}">${c.name}</a>${c.videoId ? html` <span class="muted small">${c.videoId}</span>` : ""}</h3>${c.active ? "" : html`<span class="pill off" title="${recent.get(c.id)?.offSince ? `Turned off ${dayWords(recent.get(c.id)!.offSince!, now, tz)}, at ${fmtTime(recent.get(c.id)!.offSince, tz)}` : "Off"}">Off</span>`}${quiet !== null ? html`<span class="pill quiet">No comment in ${quiet >= 30 && !recent.get(c.id)?.lastComment ? "30+ days" : plural(quiet, "day")}</span>` : ""}<span class="muted small" title="Started ${fmtTime(c.createdAt, tz)}">Started ${dayWords(c.createdAt, now, tz)}</span>
        ${campaignSwitch(c, c.active ? campaignCalls(c, postedAt(c), now) : null, show)}</div>
      ${justSwitched
        ? html`<p class="small ${c.active ? "ok" : "warn"}" role="status">${c.active ? "Turned on. It answers new comments from now on." : "Turned off. New comments on it get no DM until you turn it back on."}</p>`
        : ""}
      ${recentLine(c, postedAt(c), recent.get(c.id), now, tz)}
      <p class="muted small">${askLine(c)}</p>
      ${p?.waitingOnYou ? html`<p class="small"><a class="warn" href="/dashboard/campaigns/${c.id}#to-check">Waiting on you: ${p.waitingOnYou}</a></p>` : ""}
      ${missed.get(c.id)?.length
        ? html`<p class="small"><a class="warn" href="/dashboard/campaigns/${c.id}#to-check">${plural(missed.get(c.id)!.length, "comment")} to check</a></p>`
        : ""}
      <p class="small funnel">
        ${views !== undefined ? html`<span><b>${fmtCount(views)}</b> views</span>` : ""}
        <span><b>${fmtCount(p?.asked ?? 0)}</b> asked</span>
        <span title="${p?.answeredByHand ? `${p.answeredAutomatically} by OwnChats, ${p.answeredByHand} by hand` : "by OwnChats"}"><b>${fmtCount((p?.answeredAutomatically ?? 0) + (p?.answeredByHand ?? 0))}</b> answered${p?.answeredByHand ? html` <span class="muted">(${p.answeredByHand} by hand)</span>` : ""}</span>
        ${c.openingButton ? html`<span><b>${fmtCount(p?.tapped ?? 0)}</b> tapped</span>` : ""}
        <span><b>${fmtCount(n?.linksSent ?? 0)}</b> got the link</span>
        ${clicksOn || n?.clicks ? html`<span><b>${fmtCount(n?.clicks ?? 0)}</b> clicked</span>` : ""}
        ${c.emailMode !== "none" || n?.emails ? html`<span><b>${fmtCount(n?.emails ?? 0)}</b> gave their email</span>` : ""}
      </p></div></div>`;
  };

  return page(
    "OwnChats",
    html`${banner}
      <div class="row"><h1 style="flex:1">Campaigns</h1><a class="button" href="/dashboard/campaigns/new">New campaign</a></div>
      ${items.length
        ? html`<div class="card notice" id="needs-you"><h3>Needs you</h3><ul class="small" style="margin:0;padding-left:18px">${items.map((i) => html`<li>${i}</li>`)}</ul></div>`
        : s.ig_username && on.length && !banner.value
          ? html`<p class="ok small" id="needs-you">Nothing needs you right now.</p>`
          : ""}
      ${s.ig_username ? html`<p class="muted small"><span title="Last webhook: ${fmtTime(Number(s.last_webhook_at), tz) || "none yet"}. Last check for missed comments: ${fmtTime(Number(s.last_poll_at), tz) || "none yet"}.">Connected to Instagram as @${s.ig_username}.</span>${s.time_zone ? "" : html` Times are in UTC: <a href="/dashboard/settings#time-zone">choose your time zone</a>.`}</p>${metaLoadLine(ctx)}${refusalLine(health)}` : ""}
      ${noPermission ? html`<p class="warn small">Instagram shares each post's views once your Meta login configuration includes <code>instagram_manage_insights</code>. <a href="/setup#step-3">Add it in setup</a>, then reconnect.</p>` : ""}
      ${untaken.length ? html`<div id="no-campaign">${untaken.map((u) => untakenEntry(u, tz))}</div>` : ""}
      ${campaigns.length === 0 ? html`<div class="card"><p>No campaigns yet. Create one: a keyword, the post it watches, and the link to send.</p></div>` : ""}
      ${campaigns.length ? html`<div class="row list-head"><p class="muted small" style="flex:1;margin:0">${on.length} of ${plural(campaigns.length, "campaign")} on.</p>${chips}</div>` : ""}
      ${campaigns.length && !shown.length ? html`<p class="muted">No campaign is ${show === "quiet" ? "quiet: every campaign that is on had a matching comment in the last 7 days" : show}.</p>` : ""}
      ${shown.map(card)}
      <script>${raw(KEEP_SCROLL)}</script>`,
    { nav: true },
  );
}

function mediaPicker(media: Media[], current: Campaign | null, tz: string, input?: CampaignInput): Html {
  const v = input ?? current;
  const selected = !v ? "all" : v.nextPostAfter !== null ? NEXT_POST : v.mediaId ?? "all";
  const options = [...media];
  if (selected !== "all" && selected !== NEXT_POST && !options.some((m) => m.id === selected)) {
    options.unshift({ id: selected, caption: input?.mediaLabel ?? current?.mediaLabel ?? "", permalink: "", timestamp: 0, mediaType: "" });
  }
  const waitingSince = current?.nextPostAfter ?? null;
  return html`<label>Which post?</label>
    <label class="inline"><input type="radio" name="media_id" value="all" ${selected === "all" ? "checked" : ""}> All posts, including ones you haven't posted yet</label>
    <label class="inline"><input type="radio" name="media_id" value="${NEXT_POST}" ${selected === NEXT_POST ? "checked" : ""} data-label="">
      <span>The next post you publish ${waitingSince !== null ? html`<span class="muted small">waiting since ${fmtTime(waitingSince, tz)}</span>` : ""}</span></label>
    ${options.map(
      (m) => html`<label class="inline"><input type="radio" name="media_id" value="${m.id}" ${selected === m.id ? "checked" : ""} data-label="${postLabel(m)}">
        ${m.thumbnailUrl ? html`<img src="${m.thumbnailUrl}" alt="" width="40" height="40" style="object-fit:cover;border-radius:4px">` : ""}
        <span>${postLabel(m)} <span class="muted small">${m.timestamp ? fmtTime(m.timestamp, tz) : ""}</span></span></label>`,
    )}
    <input type="hidden" name="media_label" value="${input?.mediaLabel ?? current?.mediaLabel ?? ""}">
    <p class="hint">With all posts, use a keyword you don't use for anything else. With the next post, set the campaign up before you post: within a minute of posting, OwnChats attaches it to the first post you publish after saving whose caption asks for the keyword ("Comment AGENTS"), and answers the comments that came in before that. Already posted? Pick the post from the list instead.</p>
    <script>document.addEventListener('change',e=>{if(e.target.name==='media_id'){document.querySelector('[name=media_label]').value=e.target.dataset.label||''}})</script>`;
}

async function campaignForm(ctx: Ctx, current: Campaign | null, input?: CampaignInput, errors: string[] = [], flow: StartFlow = "link"): Promise<Response> {
  let media: Media[] = [];
  let mediaProblem = "";
  try {
    // Read fresh, so a post published a minute ago is listed and isn't mistaken for "the next post".
    media = await recentMedia(ctx, true);
  } catch (e) {
    mediaProblem = e instanceof Error ? e.message : String(e);
  }
  const v: CampaignInput = input ?? current ?? newCampaignDefaults(ctx.settings, flow);
  const s = ctx.settings;
  const shortcuts = shortcutKeywords(s);
  const action = current ? `/dashboard/campaigns/${current.id}` : "/dashboard/campaigns/new";
  const checked = (b: boolean) => (b ? "checked" : "");
  const mode = (m: EmailMode, label: string, hint: string) =>
    html`<label class="inline"><input type="radio" name="email_mode" value="${m}" ${checked(v.emailMode === m)}> <span><b>${label}</b> <span class="muted small">${hint}</span></span></label>`;
  const links = [...v.links, { label: "", url: "" }, { label: "", url: "" }, { label: "", url: "" }].slice(0, 3);
  return page(
    current ? `Edit ${current.name}` : "New campaign",
    html`<h1>${current ? `Edit "${current.name}"` : "New campaign"}</h1>
      ${errors.length ? html`<div class="card errors"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ""}
      <p class="muted">Every message below is yours to edit. Write <code>{name}</code> for the person's Instagram name (their username when Meta doesn't share the name) or <code>{username}</code> for their username.</p>
      ${current || input
        ? ""
        : html`<div class="card"><h3>Start from</h3>
            ${(Object.keys(START_FLOWS) as StartFlow[]).map((f) => {
              const { label, hint } = START_FLOWS[f];
              return html`<p>${f === flow ? html`<b>${label}</b>` : html`<a href="/dashboard/campaigns/new?flow=${f}">${label}</a>`} <span class="muted small">${hint}</span></p>`;
            })}
          </div>`}
      <form method="post" action="${action}">
        <div class="card">
          <label for="name">Name</label><input id="name" name="name" type="text" value="${v.name}" placeholder="Agents library" required>
          <label for="video_id">Video id (optional)</label><input id="video_id" name="video_id" type="text" value="${v.videoId}" maxlength="40" placeholder="SF-14">
          <p class="hint">The id of the video this campaign is for, in your own numbering. Served as <code>video_id</code> in <code>GET /api/campaigns</code>, so your other tools can link the video to its campaign without reading the name.</p>
          <label for="keywords">Keyword</label><input id="keywords" name="keywords" type="text" value="${v.keywords.join(", ")}" placeholder="AGENTS, AGENT">
          <p class="hint">Separate extra spellings with commas. Matching ignores case and needs the whole word: AGENTS matches "agents!" but not "agentsmith". A space also matches a hyphen, so SET UP matches "set-up" but not "setup".${shortcuts.length
            ? html` On one post, or the next post, it also answers your <a href="/dashboard/settings#shortcuts">shortcut keywords</a> (${shortcuts.join(", ")}); no need to add them here.`
            : ""}</p>
          <label class="inline"><input type="checkbox" name="any_comment" ${checked(v.anyComment)}> Any comment: answer every comment on the chosen post, keyword or not</label>
          ${mediaProblem ? html`<p class="warn small">Could not load your posts: ${mediaProblem}</p>` : ""}
          ${mediaPicker(media, current, timeZoneOf(ctx.settings), input)}
        </div>
        <div class="card">
          <h3>Public reply under the comment</h3>
          <label for="public_replies">Reply variants, one per line</label>
          <textarea id="public_replies" name="public_replies" rows="4">${v.publicReplies.join("\n")}</textarea>
          <p class="hint">One is picked at random each time, never the same twice in a row: identical replies on a busy post can get your comments limited. Leave empty for no public reply.</p>
        </div>
        <div class="card">
          <h3>First DM</h3>
          <label for="opening_text">Message</label><textarea id="opening_text" name="opening_text">${v.openingText}</textarea>
          <label for="opening_button">Button label</label><input id="opening_button" name="opening_button" type="text" value="${v.openingButton}" maxlength="20">
          <p class="hint">Instagram lets you send one DM per comment until the person answers. The tap counts as an answer, so the next message can follow. Leave the label empty to send the next step (the link, or the email question) as the first DM.</p>
        </div>
        <div class="card">
          <h3>Follow check</h3>
          <label class="inline"><input type="checkbox" name="follow_check" ${checked(v.followCheck)}> Ask people to follow you before they get the link</label>
          <p class="warn small">Not recommended. Meta's <a href="https://transparency.meta.com/policies/community-standards/spam/" rel="noopener noreferrer" target="_blank">spam policy</a> doesn't allow requiring people to follow you to get access to specific content, so this can put your account at risk.</p>
          <p class="hint">After the tap, OwnChats asks Instagram whether the person follows you. If they do, the link (or the email question) comes next. If not, they get the message below with a button to tap once they follow. A tap that still shows no follow gets the second message, and the tap after that gets the link either way. If Instagram doesn't answer, the link goes out. Needs the button above: Instagram only says whether someone follows you after they tap or write.</p>
          <label for="follow_prompt">When they don't follow</label><textarea id="follow_prompt" name="follow_prompt">${v.followPrompt}</textarea>
          <label for="follow_reask">When they tap but still don't follow (sent once)</label><textarea id="follow_reask" name="follow_reask">${v.followReask}</textarea>
          <label for="follow_button">Button label</label><input id="follow_button" name="follow_button" type="text" value="${v.followButton}" maxlength="20">
        </div>
        <div class="card">
          <h3>Link</h3>
          <label for="link_text">Message with the link</label><textarea id="link_text" name="link_text">${v.linkText}</textarea>
          ${links.map(
            (l, i) => html`<div class="row" style="align-items:flex-end">
              <div style="flex:2;min-width:220px"><label for="link_url_${i}">${i === 0 ? "Link" : `Link ${i + 1} (optional)`}</label>
                <input id="link_url_${i}" name="link_url_${i}" type="url" value="${l.url}" placeholder="https://" ${i === 0 ? "required" : ""}></div>
              <div style="flex:1;min-width:140px"><label for="link_label_${i}">Button label</label>
                <input id="link_label_${i}" name="link_label_${i}" type="text" value="${l.label}" maxlength="20" placeholder="${i === 0 ? DEFAULTS.linkLabel : ""}"></div></div>`,
          )}
          <p class="hint">Up to three links. With button labels they show as buttons under the message; leave every label empty to put the links in the message instead.</p>
          <label for="link_title">What the first link leads to (optional)</label><input id="link_title" name="link_title" type="text" value="${v.linkTitle}" maxlength="200" placeholder="Turn YouTube videos into Claude skills">
          <p class="hint">Its title, as written on it. Shown on its own line under the link message when there is one link, and sent with each new email to your <a href="/dashboard/settings#webhook">lead webhook</a> as <code>campaign.link_title</code>, with the person's link as <code>campaign.link</code>, so an email can deliver it by name.</p>
        </div>
        <div class="card">
          <h3>Email</h3>
          ${mode("none", "Link only", "no email ask")}
          ${mode("optional", "Link plus optional email", "the link comes right away, and once they open it, a message invites them to reply with their email")}
          ${mode("first", "Email first", "ask for the email, re-ask once, then send the link either way")}
          <h3 style="margin-top:16px">Link plus optional email</h3>
          <label for="optional_prompt">Email ask</label><textarea id="optional_prompt" name="optional_prompt">${v.optionalPrompt}</textarea>
          <p class="hint">Say what people will receive. Sent as its own message when they first open the link, within 24 hours of their tap. Without the first DM's button, or with click counting off, it goes under the link instead. Replies that aren't an email are left alone: no re-ask.</p>
          <label for="optional_thanks">Reply once the email is saved</label><textarea id="optional_thanks" name="optional_thanks">${v.optionalThanks}</textarea>
          <p class="hint">Leave empty to say nothing.</p>
          <label for="optional_thanks_button">Button under that reply</label><input id="optional_thanks_button" name="optional_thanks_button" type="text" value="${v.optionalThanksButton}" maxlength="20" placeholder="${DEFAULTS.optionalThanksButton}">
          <p class="hint">Opens your <a href="/privacy">privacy page</a>. Leave empty for no button.</p>
          <h3 style="margin-top:16px">Email first</h3>
          <label for="email_prompt">Question</label><textarea id="email_prompt" name="email_prompt">${v.emailPrompt}</textarea>
          <p class="hint">Say what people will receive.</p>
          <label for="email_reask">Reply when the answer isn't an email (sent once)</label><textarea id="email_reask" name="email_reask">${v.emailReask}</textarea>
          <label for="email_thanks">Message with the link once the email is saved</label><textarea id="email_thanks" name="email_thanks">${v.emailThanks}</textarea>
          <p class="hint">Leave empty to use the link message above. After a second answer that isn't an email, the link is sent anyway with the link message.</p>
          <p class="hint">Anti-spam laws ask the line people answer to say what they'll get, who you are, where to find your mailing address,
            and that they can unsubscribe. The defaults say what they'll get and that they can unsubscribe. They don't name you or link your address:
            the DM comes from your own account, and the thank-you's button opens your <a href="/privacy">privacy page</a>, which shows your name and address
            ${s.sender_name && s.sender_address ? "from Settings" : html`once you add them under <a href="/dashboard/settings#sender">Settings</a>`}.
            Check the rules where you and your audience live, and add to the wording if they ask for more.</p>
          <h3 style="margin-top:16px">Consent</h3>
          <label for="consent_text">Wording saved with each email</label><textarea id="consent_text" name="consent_text" placeholder="Leave empty to save the question they answered">${v.consentText}</textarea>
          <p class="hint">Stored with every lead, with the date, as the record of what they agreed to.</p>
          <label for="email_tag">Email tag (optional)</label><input id="email_tag" name="email_tag" type="text" value="${v.emailTag}" maxlength="100" placeholder="setupGuide">
          <p class="hint">Sent with each new email to your <a href="/dashboard/settings#webhook">lead webhook</a> as <code>campaign.email_tag</code>, so your email tool can start the right sequence. Leave empty for none.</p>
        </div>
        <div class="card">
          <label class="inline"><input type="checkbox" name="dm_keyword" ${checked(v.dmKeyword)}> Also answer the keyword when someone sends it by DM</label>
          <label class="inline"><input type="checkbox" name="active" ${checked(v.active)}> Campaign is on</label>
          <p><button>${current ? "Save" : "Create campaign"}</button> <a href="${current ? `/dashboard/campaigns/${current.id}` : "/dashboard"}">Cancel</a></p>
        </div>
      </form>
      ${current
        ? html`<form method="post" action="/dashboard/campaigns/${current.id}/delete" onsubmit="return confirm('Delete this campaign? Its emails stay in Leads.')">
            <button class="danger">Delete campaign</button></form>`
        : ""}`,
    { nav: true },
  );
}

export function newCampaignPage(ctx: Ctx, flow: string | null): Promise<Response> {
  return campaignForm(ctx, null, undefined, [], flow === "email" ? "email" : "link");
}

export async function editCampaignPage(ctx: Ctx, id: number): Promise<Response> {
  const c = await getCampaign(ctx.db, id);
  if (!c) return new Response("No such campaign", { status: 404 });
  return campaignForm(ctx, c);
}

export async function saveCampaignForm(ctx: Ctx, request: Request, id: number | null): Promise<Response> {
  const current = id === null ? null : await getCampaign(ctx.db, id);
  if (id !== null && !current) return new Response("No such campaign", { status: 404 });
  const { input, errors } = campaignFromForm(await request.formData(), ctx.now());
  if (errors.length) return campaignForm(ctx, current, input, errors);
  const saved = await saveCampaign(ctx.db, input, id, ctx.now());
  return redirect(`/dashboard/campaigns/${saved}`);
}

export async function deleteCampaign(ctx: Ctx, id: number): Promise<Response> {
  await ctx.db.batch([
    // Links already sent keep working; they just count nowhere now.
    ctx.db.prepare("UPDATE tracked_links SET conversation_id = NULL WHERE campaign_id = ?").bind(id),
    ctx.db.prepare("DELETE FROM campaigns WHERE id = ?").bind(id),
    ctx.db.prepare("DELETE FROM conversations WHERE campaign_id = ?").bind(id),
  ]);
  return redirect("/dashboard");
}

/** What each kind of log entry is, in the dashboard's words. */
export const KIND_LABEL: Record<string, string> = {
  comment: "Comment",
  private_reply: "First DM",
  public_reply: "Public reply",
  like: "Like",
  tap: "Button tap",
  message: "DM",
  email: "Email",
  link: "Link",
  click: "Link click",
  lead_webhook: "Lead webhook",
  api: "API",
  follow: "Follow check",
  token: "Token",
  alert: "Alert",
  by_hand: "By hand",
};

export function activityTable(rows: ActivityRow[], names: Map<number, string>, tz: string): Html {
  if (!rows.length) return html`<p class="muted">Nothing yet.</p>`;
  return html`<table><thead><tr><th>When</th><th>What</th><th>Result</th><th>Who</th><th>Why</th></tr></thead><tbody>
    ${rows.map(
      (r) => html`<tr><td class="small">${fmtTime(r.at, tz)}</td>
        <td>${KIND_LABEL[r.kind] ?? r.kind}${r.campaign_id ? html`<br><span class="muted small">${names.get(r.campaign_id) ?? `campaign ${r.campaign_id}`}</span>` : ""}</td>
        <td><span class="pill ${r.outcome}">${r.outcome}</span></td>
        <td>${r.username ? `@${r.username}` : ""}</td>
        <td class="small">${r.reason ?? ""}${r.detail ? html`<br><span class="muted">${r.detail}</span>` : ""}</td></tr>`,
    )}</tbody></table>`;
}

export async function activityPage(ctx: Ctx, url: URL): Promise<Response> {
  const filter = url.searchParams.get("show") ?? "matched";
  const before = Number(url.searchParams.get("before")) || undefined;
  const rows = await listActivity(ctx, {
    limit: 100,
    before,
    matchedOnly: filter === "matched",
    outcome: filter === "failed" ? "failed" : undefined,
  });
  const names = new Map((await listCampaigns(ctx.db)).map((c) => [c.id, c.name]));
  const tab = (key: string, label: string) =>
    key === filter ? html`<b>${label}</b>` : html`<a href="/dashboard/activity?show=${key}">${label}</a>`;
  const last = rows[rows.length - 1];
  return page(
    "Activity",
    html`${healthBanner(ctx)}<h1>Activity</h1>
      <p class="row">${tab("matched", "Campaign activity")} ${tab("failed", "Failures")} ${tab("all", "Everything, including comments with no keyword")}</p>
      ${activityTable(rows, names, timeZoneOf(ctx.settings))}
      ${rows.length === 100 && last ? html`<p><a href="/dashboard/activity?show=${filter}&before=${last.id}">Older</a></p>` : ""}`,
    { nav: true },
  );
}

export async function leadsPage(ctx: Ctx, message = ""): Promise<Response> {
  const leads = await listLeads(ctx, { limit: 500 });
  const tz = timeZoneOf(ctx.settings);
  return page(
    "Leads",
    html`<div class="row"><h1 style="flex:1">Leads</h1><a class="button secondary" href="/dashboard/leads.csv">Download CSV</a></div>
      ${message ? html`<div class="card">${message}</div>` : ""}
      <p class="muted">For Google Sheets, create a live link under <a href="/dashboard/settings">Settings</a>.</p>
      ${leads.length === 0
        ? html`<p class="muted">No emails yet.</p>`
        : html`<table><thead><tr><th>Email</th><th>Instagram</th><th>Campaign</th><th>When</th><th></th></tr></thead><tbody>
          ${leads.map(
            (l) => html`<tr><td>${l.email}</td><td>${l.username ? `@${l.username}` : ""}</td><td>${l.campaign_name ?? "deleted campaign"}</td>
              <td class="small">${fmtTime(l.consented_at, tz)}</td>
              <td><form method="post" action="/dashboard/people/delete" onsubmit="return confirm('Delete everything stored about this person?')">
                <input type="hidden" name="ig_user_id" value="${l.ig_user_id}"><button class="secondary small">Delete</button></form></td></tr>`,
          )}</tbody></table>`}
      ${leads.length === 500 ? html`<p class="muted">Showing the newest 500. The CSV has all of them.</p>` : ""}
      <h2>Delete someone's data</h2>
      <form method="post" action="/dashboard/people/delete" class="card">
        <label for="username">Instagram username</label><input id="username" name="username" type="text" placeholder="@username">
        <p class="hint">Use it when someone asks for their data to be deleted. It first shows what OwnChats stores about them, and deletes nothing until you confirm.</p>
        <p><button class="secondary">Find their data</button></p>
      </form>`,
    { nav: true },
  );
}

export async function leadsCsvDownload(ctx: Ctx): Promise<Response> {
  return new Response(leadsCsv(await listLeads(ctx)), {
    headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="ownchats-leads.csv"' },
  });
}

export async function deletePersonForm(ctx: Ctx, request: Request): Promise<Response> {
  const form = await request.formData();
  const ids = form.getAll("ig_user_id").map((v) => String(v).trim()).filter(Boolean);
  const username = String(form.get("username") ?? "").trim().replace(/^@/, "").toLowerCase();
  if (ids.length) {
    for (const personId of ids) await deletePerson(ctx, personId);
    return leadsPage(ctx, username ? `Deleted everything stored about @${username}.` : "Deleted everything stored about that person.");
  }
  // A typed username only finds the person. Deleting takes a second click on what it found, so a typo can't delete someone else.
  if (!username) return leadsPage(ctx, "Enter the Instagram username of the person whose data you want to delete.");
  const found = await findPersonByUsername(ctx, username);
  if (!found.length) return leadsPage(ctx, `Nobody with the username @${username} was found. Nothing was deleted.`);
  return confirmDeletePage(ctx, username, found);
}

async function confirmDeletePage(ctx: Ctx, username: string, ids: string[]): Promise<Response> {
  const s = await storedAboutPeople(ctx, ids);
  return page(
    "Delete someone's data",
    html`<h1>Delete @${username}'s data?</h1>
      <div class="card">
        <p>OwnChats stores this about @${username}:</p>
        <ul>
          <li>${plural(s.leads, "email")}${s.emails.length ? `: ${s.emails.join(", ")}` : ""}</li>
          <li>${plural(s.conversations, "conversation")}</li>
          <li>${plural(s.comments, "comment")}</li>
          <li>${plural(s.logEntries, "log entry", "log entries")}</li>
        </ul>
        <p class="hint">Each comment keeps only its id, so OwnChats never answers it again. The rest is gone for good.${s.leads && webhookConfig(ctx)
          ? " Your lead webhook is sent each email as deleted, so your email tool can delete its copy."
          : ""}</p>
        <form method="post" action="/dashboard/people/delete" class="row">
          <input type="hidden" name="username" value="${username}">
          ${ids.map((id) => html`<input type="hidden" name="ig_user_id" value="${id}">`)}
          <button class="danger">Delete their data</button>
          <a class="button secondary" href="/dashboard/leads">Cancel</a>
        </form>
      </div>`,
    { nav: true },
  );
}

/** Every zone Intl knows, for the Settings list. */
function timeZones(): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return zones.includes("UTC") ? zones : ["UTC", ...zones];
}

/** What each Settings form just did, by the ?saved= value its redirect carries. Any other value shows nothing. */
const SAVED_NOTE = {
  export: "New link made",
  "export-off": "Turned off",
  webhook: "Saved",
  "webhook-off": "Turned off",
  alerts: "Saved",
  "alerts-off": "Turned off",
  "api-token-off": "Revoked",
  "api-write-token-off": "Revoked",
  clicks: "Saved",
  likes: "Saved",
  "time-zone": "Saved",
  contact: "Saved",
  defaults: "Saved",
  shortcuts: "Saved",
} as const;
type SavedForm = keyof typeof SAVED_NOTE;

/**
 * The word beside a form's button once it has saved. It goes as soon as the form is edited, since
 * what's on screen is then no longer what's saved, and the URL is cleaned so a reload doesn't bring it back.
 */
function savedNote(saved: string | null | undefined, ...forms: SavedForm[]): Html {
  const form = forms.find((f) => f === saved);
  if (!form) return html``;
  return html`<span id="saved-note" class="ok small" role="status">${SAVED_NOTE[form]}</span>
    <script>(()=>{history.replaceState(null,"",location.pathname+location.hash);const n=document.getElementById("saved-note");n.closest("form").addEventListener("input",()=>n.remove(),{once:true})})()</script>`;
}

function timeZoneCard(saved: string | undefined, note: Html): Html {
  const current = saved && isTimeZone(saved) ? saved : "UTC";
  return html`<div class="card" id="time-zone">
    <h3>Time zone</h3>
    <form method="post" action="/dashboard/settings/time-zone">
      <select name="time_zone" aria-label="Time zone">${timeZones().map((z) => html`<option${z === current ? " selected" : ""}>${z}</option>`)}</select>
      <p class="hint">Times on these pages show in this zone. ${saved ? "" : "None is saved yet, so they show in UTC; the list starts on your browser's zone. "}The API, the CSV and the database keep UTC.</p>
      <p class="row"><button>Save</button>${note}</p>
    </form>
    ${saved ? "" : html`<script>(()=>{const z=Intl.DateTimeFormat().resolvedOptions().timeZone,s=document.querySelector('[name=time_zone]');if([...s.options].some(o=>o.value===z))s.value=z})()</script>`}
  </div>`;
}

/** Where the lead webhook's format is documented. */
const WEBHOOK_DOCS = "https://github.com/psabbagh/ownchats/blob/main/docs/lead-webhook.md";

const DELIVERY_PILL: Record<DeliveryRow["status"], string> = { delivered: "sent", pending: "queued", failed: "failed" };

/** What happened to the test lead just sent, in words. */
function testNotice(d: DeliveryRow | null, tz: string): Html {
  if (!d) return html``;
  if (d.status === "delivered") return html`<div class="card"><p class="ok">Test lead delivered (${d.last_result}).</p></div>`;
  if (d.status === "failed") {
    return html`<div class="card errors"><p>The test lead was refused (${d.last_result}) and won't be retried. Check the URL, and that the receiver checks the signature with the same secret.</p></div>`;
  }
  if (!d.attempts) return html`<div class="card notice"><p>The test lead is queued and goes out within a minute. Reload to see what happened.</p></div>`;
  return html`<div class="card notice"><p>The test lead didn't get through yet (${d.last_result}). OwnChats tries again at ${fmtTime(d.next_attempt_at, tz)}, as it would for a real lead.</p></div>`;
}

function webhookCard(ctx: Ctx, campaigns: Campaign[], deliveries: DeliveryRow[], notes: { error?: string; test?: DeliveryRow | null; saved?: string | null }): Html {
  const s = ctx.settings;
  const tz = timeZoneOf(s);
  const config = webhookConfig(ctx);
  const workerSecret = !!ctx.env.LEAD_WEBHOOK_SECRET;
  const emailCampaigns = campaigns.filter((c) => c.emailMode !== "none");
  const choices = emailCampaigns.length ? emailCampaigns : campaigns;
  return html`<div class="card" id="webhook">
    <h3>Lead webhook</h3>
    <p>Sends each new email to a web address you choose, signed with a secret, so your email tool (directly, through Zapier or Make, or a small script of your own) can send what the person asked for.
      When you delete someone's data, it sends that too, so their copy goes as well. The format and how to check the signature: <a href="${WEBHOOK_DOCS}" rel="noopener noreferrer" target="_blank">docs/lead-webhook.md</a>.</p>
    ${notes.error ? html`<div class="card errors"><p>${notes.error}</p></div>` : ""}
    <form method="post" action="/dashboard/settings/webhook">
      <label for="webhook_url">URL</label><input id="webhook_url" name="url" type="url" value="${s.lead_webhook_url ?? ""}" placeholder="https://">
      <label for="webhook_secret">Signing secret</label>
      ${workerSecret
        ? html`<p class="muted small">Using the <code>LEAD_WEBHOOK_SECRET</code> Worker secret.</p>`
        : html`<input id="webhook_secret" name="secret" type="password" autocomplete="new-password" placeholder="${s.lead_webhook_secret ? "Saved. Type a new one to replace it." : `At least ${MIN_SECRET_LENGTH} characters`}">`}
      <p class="hint">The receiver uses the same secret to check each request came from you. Make a long random one with your password manager and keep it there.
        ${workerSecret ? "" : html`It's stored encrypted. You can set it as a Worker secret named <code>LEAD_WEBHOOK_SECRET</code> instead.`}
        A failed delivery is retried for about a day, and every attempt is in the <a href="/dashboard/activity">activity log</a>.</p>
      <p class="row"><button name="do" value="save">Save</button>${s.lead_webhook_url ? html`<button class="danger" name="do" value="off">Turn off</button>` : ""}${savedNote(notes.saved, "webhook", "webhook-off")}</p>
    </form>
    ${config
      ? html`<h3 style="margin-top:16px">Send a test lead</h3>
          ${testNotice(notes.test ?? null, tz)}
          <form method="post" action="/dashboard/settings/test-lead">
            <label for="test_email">Email</label><input id="test_email" name="email" type="email" required placeholder="Your own address, to see the email arrive">
            <label for="test_name">Name (optional)</label><input id="test_name" name="name" type="text" placeholder="Leave empty to send no name, as when Instagram shares none">
            ${choices.length
              ? html`<label for="test_campaign">As if from</label><select id="test_campaign" name="campaign_id">${choices.map(
                  (c) => html`<option value="${c.id}">${c.name}${c.emailTag ? ` (tag: ${c.emailTag})` : ""}</option>`,
                )}</select>`
              : ""}
            <p class="hint">Sent exactly as a real new lead, with <code>"test": true</code>, the campaign's email tag and consent wording, and lead id 0. It isn't saved in Leads. Delivered and retried like a real one, and logged the same way.</p>
            <p><button>Send a test lead</button></p>
          </form>`
      : ""}
    ${deliveries.length
      ? html`<h3 style="margin-top:16px">Recent deliveries</h3>
          <div style="overflow-x:auto"><table><thead><tr><th>When</th><th>Event</th><th>Result</th><th class="num">Attempts</th><th>Last reply</th></tr></thead><tbody>
            ${deliveries.map(
              (d) => html`<tr><td class="small">${fmtTime(d.created_at, tz)}</td><td>${d.test ? "Test " : ""}${d.event}</td>
                <td><span class="pill ${DELIVERY_PILL[d.status]}">${d.status}</span>${d.status === "pending" && d.next_attempt_at ? html`<br><span class="muted small">next try ${fmtTime(d.next_attempt_at, tz)}</span>` : ""}</td>
                <td class="num">${d.attempts}</td><td class="small">${d.last_result ?? ""}</td></tr>`,
            )}</tbody></table></div>`
      : ""}
  </div>`;
}

/** What happened to the test alert just sent, in words. */
function testAlertNotice(d: DeliveryRow | null, tz: string): Html {
  if (!d) return html``;
  if (d.status === "delivered") return html`<div class="card"><p class="ok">Test alert delivered (${d.last_result}). Check that it arrived where you expect it.</p></div>`;
  if (d.status === "failed") return html`<div class="card errors"><p>The test alert was refused (${d.last_result}). Check the URL.</p></div>`;
  if (!d.attempts) return html`<div class="card notice"><p>The test alert is queued and goes out within a minute. Reload to see what happened.</p></div>`;
  return html`<div class="card notice"><p>The test alert didn't get through yet (${d.last_result}). OwnChats tries again at ${fmtTime(d.next_attempt_at, tz)}.</p></div>`;
}

function alertsCard(ctx: Ctx, notes: { error?: string; test?: DeliveryRow | null; saved?: string | null }): Html {
  const s = ctx.settings;
  const tz = timeZoneOf(s);
  const open = openAlerts(ctx);
  const [beatAt, beatProblem] = (s.heartbeat_problem ?? "").split("|");
  return html`<div class="card" id="alerts">
    <h3>Alerts</h3>
    <p>Tells you when something needs you: comments or button taps stopped arriving from Meta, a webhook field unsubscribed, Meta's webhooks refused, the Instagram token or connection broken, people waiting over half an hour on a DM Instagram refused, refused DMs only you can send now, a post that went up with no campaign, and a burst of failed DMs.
      One message when a problem starts and one when it's fixed, a reminder at most every 12 hours while it lasts, and at most 10 messages a day. Alerts never name anyone.</p>
    ${notes.error ? html`<div class="card errors"><p>${notes.error}</p></div>` : ""}
    <form method="post" action="/dashboard/settings/alerts">
      <label for="alert_url">Alert URL</label><input id="alert_url" name="alert_url" type="url" value="${s.alert_url ?? ""}" placeholder="https://ntfy.sh/your-own-random-topic">
      <p class="hint">For a push on your phone with no account: install the ntfy app, subscribe to a topic with a long random name nobody would guess, and paste <code>https://ntfy.sh/</code> followed by that name.
        A Slack or Discord webhook URL works too, and is recognised. OwnChats POSTs each alert there, and retries for about 20 minutes.</p>
      <label for="alert_format">Format</label>
      <select id="alert_format" name="alert_format">
        <option value="text"${s.alert_format === "json" ? "" : " selected"}>Plain text, with a title (ntfy and most push services)</option>
        <option value="json"${s.alert_format === "json" ? " selected" : ""}>JSON (your own tools)</option>
      </select>
      <label for="heartbeat_url">Heartbeat URL (optional)</label><input id="heartbeat_url" name="heartbeat_url" type="url" value="${s.heartbeat_url ?? ""}" placeholder="https://hc-ping.com/...">
      <p class="hint">OwnChats visits this address every ${HEARTBEAT_EVERY / MINUTE} minutes. A service such as healthchecks.io alerts you when the visits stop, which covers the one problem OwnChats can't report itself: not running at all. Set the check's period to ${HEARTBEAT_EVERY / MINUTE} minutes.
        ${s.heartbeat_url ? (beatProblem ? html`<span class="warn">The last visit failed (${fmtTime(Number(beatAt), tz)}): ${beatProblem}.</span>` : s.heartbeat_at ? html`Last visit: ${fmtTime(Number(s.heartbeat_at), tz)}.` : "") : ""}</p>
      <p class="row"><button name="do" value="save">Save</button>${s.alert_url || s.heartbeat_url ? html`<button class="danger" name="do" value="off">Turn off</button>` : ""}${savedNote(notes.saved, "alerts", "alerts-off")}</p>
    </form>
    ${s.alert_url
      ? html`${testAlertNotice(notes.test ?? null, tz)}
          <form method="post" action="/dashboard/settings/test-alert"><button class="secondary">Send a test alert</button></form>
          <p class="small">${open.length
            ? html`Open now: ${open.map((a, i) => html`${i ? "; " : ""}${ALERT_NAME[a.key]} (since ${fmtTime(a.since, tz)})`)}.`
            : html`<span class="ok">No alert is open.</span>`}</p>`
      : ""}
  </div>`;
}

/** Checks the alerts form. Returns the values to save, or the problem in words. */
function alertsFromForm(form: FormData): { alert_url: string; heartbeat_url: string; alert_format: string } | { error: string } {
  const out = { alert_url: "", heartbeat_url: "", alert_format: String(form.get("alert_format") ?? "") === "json" ? "json" : "text" };
  for (const [key, what] of [["alert_url", "alert"], ["heartbeat_url", "heartbeat"]] as const) {
    const url = String(form.get(key) ?? "").trim();
    if (!url) continue;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `Enter the full ${what} address, starting with https://` };
    }
    if (parsed.protocol !== "https:") return { error: `The ${what} address must start with https://.` };
    if (url.length > 500) return { error: `That ${what} address is too long.` };
    out[key] = url;
  }
  return out;
}

/** The Settings card that turns on liking the comments OwnChats answers. */
function likesCard(s: Settings, savedMark: Html): Html {
  const on = s.like_comments === "on";
  const problem = on && s.like_problem ? s.like_problem.slice(s.like_problem.indexOf("|") + 1) : "";
  return html`<div class="card" id="likes">
    <h3>Like answered comments</h3>
    <p>${on
      ? "On. Every comment a campaign answers also gets a like from your account, after its DM went out."
      : "Off. Comments a campaign answers get the DM and the public reply, and no like."}</p>
    ${problem
      ? html`<p class="warn small">Meta refused the last like for a missing permission: add <code>instagram_manage_engagement</code> to your Meta login configuration (<a href="/setup#step-3">step 3 of setup</a>), then click Reconnect. Meta said: ${problem}</p>`
      : ""}
    <p class="hint">Needs <code>instagram_manage_engagement</code> in your Meta login configuration; if you add it, click Reconnect on <a href="/setup">setup</a>.
      Meta doesn't allow liking comments by private accounts, so those get the DM and the reply only. A like Meta refuses never holds up anything else, and shows in the activity log.</p>
    <form method="post" action="/dashboard/settings/likes" class="row"><button class="secondary" name="do" value="${on ? "off" : "on"}">${on ? "Stop liking comments" : "Like answered comments"}</button>${savedMark}</form>
  </div>`;
}

export async function settingsPage(ctx: Ctx, fresh: { apiToken?: string; apiWriteToken?: string; webhookError?: string; testId?: string | null; alertError?: string; alertTestId?: string | null; saved?: string | null } = {}): Promise<Response> {
  const s = ctx.settings;
  const exportUrl = s.export_key ? `${s.base_url}/export/leads.csv?key=${s.export_key}` : "";
  const campaigns = await listCampaigns(ctx.db);
  const deliveries = await recentDeliveries(ctx);
  const test = fresh.testId ? await getDelivery(ctx, fresh.testId) : null;
  const alertTest = fresh.alertTestId ? await getDelivery(ctx, fresh.alertTestId) : null;
  const clicksOn = s.click_tracking !== "off";
  return page(
    "Settings",
    html`<h1>Settings</h1>
      <div class="card" id="shortcuts">
        <h3>Shortcut keywords</h3>
        <p>What your audience comments to mean "send it", such as 🙌. Every keyword campaign on one post answers them too, on top of its own keywords, so they don't need adding to each campaign.</p>
        <form method="post" action="/dashboard/settings/shortcuts">
          <label for="shortcut_keywords">Shortcuts</label>
          <input id="shortcut_keywords" name="shortcut_keywords" type="text" value="${s.shortcut_keywords ?? ""}" placeholder="🙌">
          <p class="hint">Separate them with commas, as in a campaign's keywords. Leave empty for none.
            A comment that has a campaign's own keyword still goes to that campaign. Campaigns on all posts don't answer shortcuts, since a 🙌 under any of your posts would get their link.
            Shortcuts never attach a campaign waiting for your next post unless it lists them as its own keyword (its caption still needs "Comment" and its keyword), and never count as a DM keyword.
            An emoji matches anywhere in a comment, so "love this 🙌" gets the link too. A word, like any keyword, only in a short comment that is that word, spelled exactly.</p>
          <p class="row"><button>Save</button>${savedNote(fresh.saved, "shortcuts")}</p>
        </form>
      </div>
      ${likesCard(s, savedNote(fresh.saved, "likes"))}
      <div class="card" id="sheets">
        <h3>Google Sheets</h3>
        ${exportUrl
          ? html`<p>Paste this into cell A1 of a Google Sheet. It refreshes about once an hour.</p>
              ${copyField(`=IMPORTDATA("${exportUrl}")`)}
              <p class="hint">Anyone with this link can read your leads. Regenerate it to cut off the old one.</p>
              <form method="post" action="/dashboard/settings/export" class="row"><button class="secondary" name="do" value="new">Regenerate link</button><button class="danger" name="do" value="revoke">Turn off</button>${savedNote(fresh.saved, "export")}</form>`
          : html`<p>Create a secret link that Google Sheets can read with IMPORTDATA.</p>
              <form method="post" action="/dashboard/settings/export" class="row"><button name="do" value="new">Create link</button>${savedNote(fresh.saved, "export-off")}</form>`}
      </div>
      ${webhookCard(ctx, campaigns, deliveries, { error: fresh.webhookError, test, saved: fresh.saved })}
      ${alertsCard(ctx, { error: fresh.alertError, test: alertTest, saved: fresh.saved })}
      <div class="card" id="api-token">
        <h3>API token</h3>
        <p>For tools that read your campaigns and leads. See <code>GET ${s.base_url ?? ""}/api</code>.</p>
        ${fresh.apiToken
          ? html`<p class="ok">Copy it now; it is shown only once.</p>${copyField(fresh.apiToken)}`
          : html`<p class="muted">${s.api_token_hash ? "A token exists." : "No token yet."}</p>`}
        <form method="post" action="/dashboard/settings/api-token" class="row"><button name="do" value="new">${s.api_token_hash ? "Replace token" : "Create token"}</button>
          ${s.api_token_hash ? html`<button class="danger" name="do" value="revoke">Revoke</button>` : ""}${savedNote(fresh.saved, "api-token-off")}</form>
      </div>
      <div class="card" id="api-write-token">
        <h3>API write token</h3>
        <p>For a tool or agent that sets up campaigns for your next post, with <code>POST ${s.base_url ?? ""}/api/campaigns</code>. It can create campaigns, check captions and send a test lead to the lead webhook, and nothing else: it can't read your leads, and the API token above can't create anything.</p>
        ${fresh.apiWriteToken
          ? html`<p class="ok">Copy it now; it is shown only once.</p>${copyField(fresh.apiWriteToken)}`
          : html`<p class="muted">${s.api_write_token_hash ? "A write token exists." : "No write token yet."}</p>`}
        <form method="post" action="/dashboard/settings/api-write-token" class="row"><button name="do" value="new">${s.api_write_token_hash ? "Replace write token" : "Create write token"}</button>
          ${s.api_write_token_hash ? html`<button class="danger" name="do" value="revoke">Revoke</button>` : ""}${savedNote(fresh.saved, "api-write-token-off")}</form>
      </div>
      <div class="card" id="clicks">
        <h3>Link clicks</h3>
        <p>${clicksOn
          ? "On. Campaign links go out as links to your OwnChats address, which sends people on to the real link, so each campaign can count who clicked."
          : "Off. Campaign links go out as they are, and clicks aren't counted."}</p>
        <p class="hint">Each person gets their own random link: it names nobody. Only a person's first click counts, and link previews (Instagram's included) don't.
          Links already sent keep working either way.</p>
        <form method="post" action="/dashboard/settings/clicks" class="row"><button class="secondary" name="do" value="${clicksOn ? "off" : "on"}">${clicksOn ? "Stop counting clicks" : "Count clicks"}</button>${savedNote(fresh.saved, "clicks")}</form>
      </div>
      ${timeZoneCard(s.time_zone, savedNote(fresh.saved, "time-zone"))}
      <div class="card" id="sender">
        <h3>You, on the privacy page</h3>
        <form method="post" action="/dashboard/settings/contact">
          <label for="sender_name">Your name or business name</label>
          <input id="sender_name" name="sender_name" type="text" value="${s.sender_name ?? ""}" placeholder="Leave empty to use your Instagram handle">
          <label for="sender_address">Mailing address</label>
          <textarea id="sender_address" name="sender_address" rows="3" placeholder="A PO box or mailbox service works">${s.sender_address ?? ""}</textarea>
          <label for="contact">Contact</label>
          <input id="contact" name="contact" type="text" value="${s.contact ?? ""}" placeholder="an email address, or leave empty to use a DM to your account">
          <p class="hint">Shown on <a href="/privacy">/privacy</a>, which the button under a campaign's thank-you opens, and on <a href="/data-deletion">/data-deletion</a>.
            Anti-spam laws such as Canada's CASL ask for a name and a mailing address wherever you ask for an email.</p>
          <p class="row"><button>Save</button>${savedNote(fresh.saved, "contact")}</p>
        </form>
      </div>
      <div class="card" id="defaults">
        <h3>Defaults for new campaigns</h3>
        <p class="muted">Your own wording for the texts a new campaign starts with, in the dashboard and through the API. Leave one empty to use OwnChats' own, shown in grey.
          Existing campaigns keep their wording until you edit it.</p>
        <form method="post" action="/dashboard/settings/defaults">
          <label for="default_link_text">Message with the link</label>
          <textarea id="default_link_text" name="default_link_text" maxlength="${DEFAULT_LIMITS.linkText}" placeholder="${DEFAULTS.linkText}">${s.default_link_text ?? ""}</textarea>
          <label for="default_link_label">Link button label</label>
          <input id="default_link_label" name="default_link_label" type="text" value="${s.default_link_label ?? ""}" maxlength="${DEFAULT_LIMITS.button}" placeholder="${DEFAULTS.linkLabel}">
          <label for="default_optional_prompt">Email ask (link plus optional email)</label>
          <textarea id="default_optional_prompt" name="default_optional_prompt" maxlength="${DEFAULT_LIMITS.optionalPrompt}" placeholder="${DEFAULTS.optionalPrompt}">${s.default_optional_prompt ?? ""}</textarea>
          <p class="hint">Say what people will receive, and only promise what your emails deliver: "I'll send it to your email" needs a <a href="#webhook">lead webhook</a> and an email that sends the link.</p>
          <label for="default_optional_thanks">Reply once the email is saved</label>
          <textarea id="default_optional_thanks" name="default_optional_thanks" maxlength="${DEFAULT_LIMITS.optionalThanks}" placeholder="${DEFAULTS.optionalThanks}">${s.default_optional_thanks ?? ""}</textarea>
          <label for="default_thanks_button">Button under that reply</label>
          <input id="default_thanks_button" name="default_thanks_button" type="text" value="${s.default_thanks_button ?? ""}" maxlength="${DEFAULT_LIMITS.button}" placeholder="${DEFAULTS.optionalThanksButton}">
          <p class="row"><button>Save</button>${savedNote(fresh.saved, "defaults")}</p>
        </form>
      </div>`,
    { nav: true },
  );
}

/** Checks the webhook form. Returns the values to save, or the problem in words. */
function webhookFromForm(ctx: Ctx, form: FormData): { url: string; secret?: string } | { error: string } {
  const url = String(form.get("url") ?? "").trim();
  const secret = String(form.get("secret") ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "Enter the full web address the leads go to, starting with https://" };
  }
  if (parsed.protocol !== "https:") return { error: "The webhook address must start with https://, so the emails travel encrypted." };
  if (url.length > 500) return { error: "That address is too long." };
  if (secret && secret.length < MIN_SECRET_LENGTH) return { error: `The signing secret must be at least ${MIN_SECRET_LENGTH} characters. A password manager's generator makes a good one.` };
  if (!secret && !ctx.settings.lead_webhook_secret && !ctx.env.LEAD_WEBHOOK_SECRET) return { error: "Choose a signing secret too, so the receiver can tell the leads come from you." };
  return { url, secret: secret || undefined };
}

export async function settingsAction(ctx: Ctx, request: Request, what: string): Promise<Response> {
  const form = await request.formData();
  const pw = ctx.env.ADMIN_PASSWORD;
  const action = String(form.get("do") ?? "");
  const saved = (done: SavedForm, card: string) => redirect(`/dashboard/settings?saved=${done}#${card}`);
  if (what === "export") {
    if (action === "revoke") {
      await deleteSettings(ctx.db, ["export_key"]);
      return saved("export-off", "sheets");
    }
    await saveSettings(ctx.db, pw, { export_key: randomToken(24) });
    return saved("export", "sheets");
  }
  if (what === "api-token") {
    if (action === "revoke") {
      await deleteSettings(ctx.db, ["api_token_hash"]);
      return saved("api-token-off", "api-token");
    }
    const token = `oc_${randomToken(24)}`;
    const hash = await sha256Hex(token);
    await saveSettings(ctx.db, pw, { api_token_hash: hash });
    ctx.settings.api_token_hash = hash;
    return settingsPage(ctx, { apiToken: token });
  }
  if (what === "api-write-token") {
    if (action === "revoke") {
      await deleteSettings(ctx.db, ["api_write_token_hash"]);
      return saved("api-write-token-off", "api-write-token");
    }
    const token = `ocw_${randomToken(24)}`;
    const hash = await sha256Hex(token);
    await saveSettings(ctx.db, pw, { api_write_token_hash: hash });
    ctx.settings.api_write_token_hash = hash;
    return settingsPage(ctx, { apiWriteToken: token });
  }
  if (what === "webhook") {
    if (action === "off") {
      await deleteSettings(ctx.db, ["lead_webhook_url", "lead_webhook_secret"]);
      return saved("webhook-off", "webhook");
    }
    const values = webhookFromForm(ctx, form);
    if ("error" in values) return settingsPage(ctx, { webhookError: values.error });
    await saveSettings(ctx.db, pw, { lead_webhook_url: values.url, lead_webhook_secret: values.secret });
    return saved("webhook", "webhook");
  }
  if (what === "test-lead") {
    const checked = await checkTestLead(ctx, {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      campaignId: Number(form.get("campaign_id")) || 0,
    });
    if ("error" in checked) return settingsPage(ctx, { webhookError: checked.error });
    const { id } = await sendTestLead(ctx, checked);
    return redirect(`/dashboard/settings?test=${encodeURIComponent(id)}#webhook`);
  }
  if (what === "alerts") {
    if (action === "off") {
      await deleteSettings(ctx.db, ["alert_url", "alert_format", "alert_state", "alerts_at", "heartbeat_url", "heartbeat_at", "heartbeat_problem"]);
      return saved("alerts-off", "alerts");
    }
    const values = alertsFromForm(form);
    if ("error" in values) return settingsPage(ctx, { alertError: values.error });
    const emptied = (["alert_url", "heartbeat_url"] as const).filter((k) => !values[k]);
    await deleteSettings(ctx.db, [...emptied, ...(values.heartbeat_url ? [] : (["heartbeat_at", "heartbeat_problem"] as const))]);
    await saveSettings(ctx.db, pw, { alert_format: values.alert_format, ...(values.alert_url ? { alert_url: values.alert_url } : {}), ...(values.heartbeat_url ? { heartbeat_url: values.heartbeat_url } : {}) });
    return saved("alerts", "alerts");
  }
  if (what === "test-alert") {
    const sent = await sendTestAlert(ctx);
    if (!sent) return settingsPage(ctx, { alertError: "Save an alert URL first." });
    return redirect(`/dashboard/settings?alert_test=${encodeURIComponent(sent.id)}#alerts`);
  }
  if (what === "likes") {
    if (action === "on") await saveSettings(ctx.db, pw, { like_comments: "on" });
    else await deleteSettings(ctx.db, ["like_comments", "like_problem"]);
    return saved("likes", "likes");
  }
  if (what === "clicks") {
    if (action === "off") await saveSettings(ctx.db, pw, { click_tracking: "off" });
    else await deleteSettings(ctx.db, ["click_tracking"]);
    return saved("clicks", "clicks");
  }
  if (what === "time-zone") {
    const tz = String(form.get("time_zone") ?? "").trim();
    if (!isTimeZone(tz)) return redirect("/dashboard/settings#time-zone");
    await saveSettings(ctx.db, pw, { time_zone: tz });
    return saved("time-zone", "time-zone");
  }
  if (what === "shortcuts") {
    const shortcuts = parseKeywords(String(form.get("shortcut_keywords") ?? "").slice(0, 300));
    if (shortcuts.length) await saveSettings(ctx.db, pw, { shortcut_keywords: shortcuts.join(", ") });
    else await deleteSettings(ctx.db, ["shortcut_keywords"]);
    return saved("shortcuts", "shortcuts");
  }
  if (what === "contact") {
    const field = (k: string, max: number) => String(form.get(k) ?? "").trim().slice(0, max);
    await saveSettings(ctx.db, pw, { contact: field("contact", 200), sender_name: field("sender_name", 100), sender_address: field("sender_address", 300) });
    return saved("contact", "sender");
  }
  if (what === "defaults") {
    const values = {
      default_link_text: String(form.get("default_link_text") ?? "").trim().slice(0, DEFAULT_LIMITS.linkText),
      default_link_label: String(form.get("default_link_label") ?? "").trim().slice(0, DEFAULT_LIMITS.button),
      default_optional_prompt: String(form.get("default_optional_prompt") ?? "").trim().slice(0, DEFAULT_LIMITS.optionalPrompt),
      default_optional_thanks: String(form.get("default_optional_thanks") ?? "").trim().slice(0, DEFAULT_LIMITS.optionalThanks),
      default_thanks_button: String(form.get("default_thanks_button") ?? "").trim().slice(0, DEFAULT_LIMITS.button),
    };
    const keys = Object.keys(values) as Array<keyof typeof values>;
    // An emptied field goes back to OwnChats' own wording.
    await deleteSettings(ctx.db, keys.filter((k) => !values[k]));
    await saveSettings(ctx.db, pw, Object.fromEntries(keys.filter((k) => values[k]).map((k) => [k, values[k]])));
    return saved("defaults", "defaults");
  }
  return new Response("Not found", { status: 404 });
}
