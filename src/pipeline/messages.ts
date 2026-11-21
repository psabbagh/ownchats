import {
  afterOpening,
  consentFor,
  emailAsk,
  fill,
  firstMessage,
  FOLLOW_PAYLOAD_PREFIX,
  followAsk,
  getCampaign,
  linkAfterEmail,
  LINK_STATES,
  linkMessage,
  listCampaigns,
  matchDm,
  OPEN_PAYLOAD_PREFIX,
  optionalThanksMessage,
  privacyUrl,
  type Campaign,
  type ConversationState,
  type Person,
} from "../campaigns";
import { trackingBase, trackLinks } from "../clicks";
import { log, logStatement, type Ctx } from "../context";
import { deliverNow, queueLeadCreated } from "../leadwebhook";
import { extractEmail } from "../match";
import { explainError, MetaError, sendWithFallback, TRANSIENT_REASON, type OutMessage } from "../meta/client";
import { shortcutKeywords } from "../settings";
import { DAY, HOUR, MESSAGING_WINDOW, MINUTE } from "../time";
import { claimConversation, getConversation, openConversation, releaseClaim, type Conversation } from "./conversations";

/** A DM or a button tap, as it arrives by webhook. */
export interface InboundEvent {
  mid: string;
  senderId: string;
  /** Unix ms, when the person acted. */
  timestamp: number;
  text?: string;
  postbackPayload?: string;
  isEcho?: boolean;
}

const person = (c: Conversation): Person => ({ name: c.name, username: c.username });

/**
 * Whether the optional email ask can wait for the link's first open: clicks are
 * counted, so the open will be seen. Callers only use it right after the person
 * tapped or wrote, when a second message is allowed.
 */
const askOnOpen = (ctx: Ctx): boolean => trackingBase(ctx) !== null;

/**
 * The DM state machine. It only ever answers something the person just did, so
 * every message it sends is inside Meta's 24-hour window.
 */
export async function handleInbound(ctx: Ctx, ev: InboundEvent): Promise<void> {
  if (ev.isEcho || ev.senderId === ctx.settings.ig_user_id) return;
  const fresh = await ctx.db
    .prepare("INSERT INTO inbound (mid, received_at) VALUES (?, ?) ON CONFLICT (mid) DO NOTHING")
    .bind(ev.mid, ctx.now())
    .run();
  if (fresh.meta.changes !== 1) return; // redelivered webhook
  if (!ctx.meta) return;

  if (ev.postbackPayload?.startsWith(OPEN_PAYLOAD_PREFIX)) return handleTap(ctx, ev, OPEN_PAYLOAD_PREFIX);
  if (ev.postbackPayload?.startsWith(FOLLOW_PAYLOAD_PREFIX)) return handleTap(ctx, ev, FOLLOW_PAYLOAD_PREFIX);

  const text = ev.text ?? "";
  const open = await openConversation(ctx.db, ev.senderId, ctx.now() - 7 * DAY);
  const campaign = open ? await getCampaign(ctx.db, open.campaign_id) : null;
  if (open && campaign && !tooLateToAnswer(open, text, ev.timestamp)) {
    if (open.state !== "optional_email") {
      await touch(ctx, open, ev.timestamp);
      // They wrote instead of tapping: that counts just the same, for either button.
      if (open.state === "opened") return pastOpening(ctx, open, campaign, "reply instead of tap");
      if (FOLLOW_STATES.includes(open.state)) return followStep(ctx, open, campaign, "reply instead of tap");
      await learnProfile(ctx, open);
      return emailStep(ctx, open, campaign, text);
    }
    // Link plus optional email: an email is saved; anything else needs no answer,
    // and may be a keyword for another campaign, handled below.
    const email = extractEmail(text);
    if (email) {
      await touch(ctx, open, ev.timestamp);
      await learnProfile(ctx, open);
      return optionalEmail(ctx, open, campaign, email);
    }
  }

  const keywordCampaign = matchDm(await listCampaigns(ctx.db, true), text, shortcutKeywords(ctx.settings));
  if (!keywordCampaign) return; // an ordinary DM, none of OwnChats' business
  return dmKeyword(ctx, keywordCampaign, ev);
}

const FOLLOW_STATES: ConversationState[] = ["awaiting_follow", "follow_reasked"];
const EMAIL_STATES: ConversationState[] = ["awaiting_email", "reasked"];
/** How long after the email question a message with no email in it still counts as the answer. */
const EMAIL_ANSWER_WINDOW = DAY;

/**
 * Someone who never answered the email question may write days later about
 * something else. An email is still an answer; anything else is an ordinary DM.
 */
function tooLateToAnswer(conversation: Conversation, text: string, at: number): boolean {
  return EMAIL_STATES.includes(conversation.state) && at - conversation.updated_at > EMAIL_ANSWER_WINDOW && !extractEmail(text);
}

/** A tap on the opening button, or on "I'm following". */
async function handleTap(ctx: Ctx, ev: InboundEvent, prefix: string): Promise<void> {
  const campaignId = Number(ev.postbackPayload!.slice(prefix.length));
  const campaign = Number.isInteger(campaignId) ? await getCampaign(ctx.db, campaignId) : null;
  const conversation = campaign ? await getConversation(ctx.db, campaign.id, ev.senderId) : null;
  if (!campaign || !conversation) {
    await log(ctx, { kind: "tap", outcome: "skipped", reason: "no conversation for this button", igUserId: ev.senderId });
    return;
  }
  await touch(ctx, conversation, ev.timestamp);
  const who = { campaignId: campaign.id, igUserId: ev.senderId, username: conversation.username };
  const follow = prefix === FOLLOW_PAYLOAD_PREFIX;
  if (follow ? !FOLLOW_STATES.includes(conversation.state) : conversation.state !== "opened") {
    await log(ctx, { kind: "tap", outcome: "skipped", reason: "button already tapped", ...who });
    return;
  }
  await log(ctx, { kind: "tap", outcome: "received", ...(follow ? { reason: "follow button" } : {}), ...who });
  if (follow) return followStep(ctx, conversation, campaign, "after the follow tap");
  await pastOpening(ctx, conversation, campaign, "after the tap");
}

/** The opening button was tapped (or answered): the follow check if the campaign has one, then the link or the email step. */
async function pastOpening(ctx: Ctx, conversation: Conversation, campaign: Campaign, reason: string): Promise<void> {
  if (campaign.followCheck) return followStep(ctx, conversation, campaign, reason);
  await learnProfile(ctx, conversation);
  return advance(ctx, conversation, campaign, afterOpening(campaign, person(conversation), askOnOpen(ctx)), reason);
}

/**
 * Checks whether the person follows. Following, or when Meta's check fails: on to
 * the link or the email step, since our own error must never block anyone. Not
 * following: "follow me first", then once more, then the link either way.
 */
async function followStep(ctx: Ctx, conversation: Conversation, campaign: Campaign, reason: string): Promise<void> {
  const follows = await checkFollow(ctx, conversation, campaign);
  const asked = conversation.state === "awaiting_follow" ? 1 : conversation.state === "follow_reasked" ? 2 : 0;
  if (follows === false && asked < 2) {
    const next = followAsk(campaign, person(conversation), asked === 1);
    // send() counts the ask in follow_asked once it went out, retried or not.
    await send(ctx, conversation, campaign, next.message, next.state, asked === 1 ? "asked to follow again" : "asked to follow", "message");
    return;
  }
  const why = follows ? reason : follows === null ? "follow check failed" : "link without a follow";
  return advance(ctx, conversation, campaign, afterOpening(campaign, person(conversation), askOnOpen(ctx)), why);
}

/**
 * Asks Meta whether the person follows, and learns their name on the way. Allowed
 * now that they have tapped or written. Null when Meta didn't answer.
 */
async function checkFollow(ctx: Ctx, conversation: Conversation, campaign: Campaign): Promise<boolean | null> {
  const who = { campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username };
  if (!ctx.budget.take()) {
    await log(ctx, { kind: "follow", outcome: "failed", reason: "too many requests in one run", ...who });
    return null;
  }
  let status: { follows: boolean | null; name: string | null; username: string | null };
  try {
    status = await ctx.meta!.getFollowStatus(conversation.ig_user_id);
  } catch (err) {
    const { reason, detail } = explainError(err);
    await log(ctx, { kind: "follow", outcome: "failed", reason, ...who, detail });
    return null;
  }
  conversation.name ??= status.name ?? "";
  conversation.username ??= status.username;
  await ctx.db.batch([
    ctx.db
      .prepare("UPDATE conversations SET follows = ?, name = COALESCE(name, ?), username = COALESCE(username, ?) WHERE id = ?")
      .bind(status.follows === null ? null : status.follows ? 1 : 0, conversation.name, status.username, conversation.id),
    status.follows === null
      ? logStatement(ctx, { kind: "follow", outcome: "failed", reason: "Meta did not say whether they follow", ...who })
      : logStatement(ctx, { kind: "follow", outcome: "received", reason: status.follows ? "follows" : "not following", ...who }),
  ]);
  return status.follows;
}

/** Saves the email with its consent wording, and queues it for the lead webhook. Returns the delivery id, if any. */
async function saveLead(ctx: Ctx, conversation: Conversation, campaign: Campaign, email: string): Promise<string | null> {
  const who = { campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username };
  const consent = fill(consentFor(campaign), person(conversation));
  const now = ctx.now();
  const [saved] = await ctx.db.batch<{ id: number }>([
    ctx.db
      .prepare(
        `INSERT INTO leads (campaign_id, ig_user_id, username, email, consent_text, consented_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (campaign_id, ig_user_id) DO UPDATE SET email = excluded.email, username = excluded.username,
           consent_text = excluded.consent_text, consented_at = excluded.consented_at RETURNING id`,
      )
      .bind(campaign.id, conversation.ig_user_id, conversation.username, email, consent, now),
    logStatement(ctx, { kind: "email", outcome: "saved", ...who }),
  ]);
  const leadId = saved?.results[0]?.id;
  if (!leadId) return null;
  // The name only when Meta shared one: an empty name is "Meta had none", never the username.
  return queueLeadCreated(
    ctx,
    { id: leadId, email, name: conversation.name || null, createdAt: now, campaign, consentText: consent },
    { conversationId: conversation.id, igUserId: conversation.ig_user_id, username: conversation.username },
  );
}

/** Email first: save a valid email and send the link; otherwise re-ask once, then send the link anyway. */
async function emailStep(ctx: Ctx, conversation: Conversation, campaign: Campaign, text: string): Promise<void> {
  const p = person(conversation);
  const email = extractEmail(text);
  if (email) {
    const delivery = await saveLead(ctx, conversation, campaign, email);
    await advance(ctx, conversation, campaign, { message: linkAfterEmail(campaign, p), state: "done" }, "after the email");
    // After the DM, so the person's link never waits on the webhook.
    await deliverNow(ctx, delivery);
    return;
  }
  if (conversation.state === "awaiting_email") {
    return advance(ctx, conversation, campaign, { message: { kind: "text", text: fill(campaign.emailReask, p) }, state: "reasked" }, "re-ask");
  }
  await log(ctx, { kind: "email", outcome: "skipped", reason: "no email after the re-ask", campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username });
  return advance(ctx, conversation, campaign, { message: linkMessage(campaign, p), state: "done" }, "link without an email");
}

/** Link plus optional email: save it, and thank them if the campaign has a thank-you. */
async function optionalEmail(ctx: Ctx, conversation: Conversation, campaign: Campaign, email: string): Promise<void> {
  const delivery = await saveLead(ctx, conversation, campaign, email);
  if (campaign.optionalThanks) {
    await send(ctx, conversation, campaign, optionalThanksMessage(campaign, person(conversation), privacyUrl(ctx.settings)), "done", "thank-you", "message");
  } else {
    await ctx.db.prepare("UPDATE conversations SET state = 'done', updated_at = ? WHERE id = ?").bind(ctx.now(), conversation.id).run();
  }
  await deliverNow(ctx, delivery);
}

/**
 * The person opened their link for the first time: the optional email ask, if
 * their conversation was waiting for that. Once per conversation, and only inside
 * the 24-hour window their tap or message opened; later, nothing is sent.
 */
export async function askAfterOpen(ctx: Ctx, conversationId: number): Promise<void> {
  if (!ctx.meta) return;
  // Taken out of awaiting_open first, so a second link opened at the same moment can't ask twice.
  const conversation = await ctx.db
    .prepare("UPDATE conversations SET state = 'done' WHERE id = ? AND state = 'awaiting_open' RETURNING *")
    .bind(conversationId)
    .first<Conversation>();
  if (!conversation) return;
  const campaign = await getCampaign(ctx.db, conversation.campaign_id);
  if (!campaign || !campaign.active || campaign.emailMode !== "optional" || !campaign.optionalPrompt) return;
  await send(ctx, conversation, campaign, emailAsk(campaign, person(conversation)), "optional_email", "email ask after the first open", "message");
}

async function dmKeyword(ctx: Ctx, campaign: Campaign, ev: InboundEvent): Promise<void> {
  const existing = await getConversation(ctx.db, campaign.id, ev.senderId);
  if (existing) {
    // They asked again by DM; sending the link once more is what they want.
    if (LINK_STATES.includes(existing.state)) {
      await touch(ctx, existing, ev.timestamp);
      await send(ctx, existing, campaign, linkMessage(campaign, person(existing)), existing.state, "link sent again on request", "link");
    }
    return;
  }
  // They wrote first, so Meta already answers whether they follow: the check needs no button here.
  let profile: Person = {};
  let follows: boolean | null = null;
  if (ctx.budget.take()) {
    if (campaign.followCheck) {
      const status = await ctx.meta!.getFollowStatus(ev.senderId).catch(() => null);
      if (status) ({ follows, ...profile } = status);
    } else {
      profile = await ctx.meta!.getProfile(ev.senderId).catch(() => ({}));
    }
  }
  const first = firstMessage(campaign, "dm", profile, follows, askOnOpen(ctx));
  const claimed = await claimConversation(ctx.db, {
    campaignId: campaign.id,
    igUserId: ev.senderId,
    commenterId: null,
    username: profile.username ?? null,
    trigger: "dm",
    commentId: null,
    state: first.state,
    lastInboundAt: ev.timestamp,
    now: ctx.now(),
  });
  if (claimed === null) return;
  const conversation: Conversation = {
    id: claimed,
    campaign_id: campaign.id,
    ig_user_id: ev.senderId,
    commenter_id: null,
    username: profile.username ?? null,
    name: profile.name ?? "",
    trigger: "dm",
    comment_id: null,
    state: first.state,
    first_sent_at: null,
    last_inbound_at: ev.timestamp,
    follow_asked: 0,
    follows: null,
    created_at: ctx.now(),
    updated_at: ctx.now(),
  };
  if (profile.name) await ctx.db.prepare("UPDATE conversations SET name = ? WHERE id = ?").bind(profile.name, claimed).run();
  const asked = first.state === "awaiting_follow";
  const reason = asked ? "DM keyword, asked to follow" : "DM keyword";
  const ok = await send(ctx, conversation, campaign, first.message, first.state, reason, LINK_STATES.includes(first.state) ? "link" : "message", { firstSent: true });
  if (!ok) return releaseClaim(ctx.db, conversation.id);
  if (follows !== null) {
    await ctx.db.prepare("UPDATE conversations SET follows = ?, follow_asked = ? WHERE id = ?").bind(follows ? 1 : 0, asked ? 1 : 0, claimed).run();
  }
}

/**
 * Asks Meta once for the person's name, for {name}. Allowed now that they have
 * tapped or written. An empty string records that Meta had none.
 */
async function learnProfile(ctx: Ctx, conversation: Conversation): Promise<void> {
  if (conversation.name !== null || !ctx.budget.take()) return;
  const profile = await ctx.meta!.getProfile(conversation.ig_user_id).catch(() => ({ name: null, username: null }));
  conversation.name = profile.name ?? "";
  conversation.username ??= profile.username;
  await ctx.db
    .prepare("UPDATE conversations SET name = ?, username = COALESCE(username, ?) WHERE id = ?")
    .bind(conversation.name, profile.username, conversation.id)
    .run();
}

function advance(
  ctx: Ctx,
  conversation: Conversation,
  campaign: Campaign,
  next: { message: OutMessage; state: ConversationState },
  reason: string,
): Promise<void> {
  const kind = LINK_STATES.includes(next.state) ? "link" : "message";
  return send(ctx, conversation, campaign, next.message, next.state, reason, kind).then(() => undefined);
}

/**
 * When a message after a tap or a reply that Meta refused for a passing reason is tried
 * again, after each failed attempt. The Cron sends it, always inside Meta's 24-hour
 * window from the person's last tap or message; past the last one it waits under To
 * check, where the owner can send it while the window lasts.
 */
export const MESSAGE_RETRY_AFTER = [MINUTE, 3 * MINUTE, 10 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR];

/** Logged when the Cron stops retrying a message: the owner can still send it from To check. */
export const MESSAGE_GAVE_UP_REASON = "Meta rate limit or outage, stopped retrying: send it from To check";

const CLEAR_PENDING = "pending_message = NULL, pending_state = NULL, pending_reason = NULL, pending_kind = NULL, pending_attempts = 0, pending_at = NULL";

/**
 * Sends a follow-up and moves the conversation on. Refuses outside the 24-hour
 * window that the person's last tap or message opened. If Meta rejects a button
 * template, the same content goes again as plain text. If Meta refuses for a passing
 * reason (a rate limit, an outage), or the run has no room left, what was due is kept
 * on the conversation and the Cron sends it later (MESSAGE_RETRY_AFTER); `attempt` is
 * how many times it was already tried. A first DM by DM keyword is not kept: its
 * claim is released, and the person can write again.
 */
async function send(
  ctx: Ctx,
  conversation: Conversation,
  campaign: Campaign,
  message: OutMessage,
  state: ConversationState,
  reason: string,
  kind: "link" | "message",
  opts: { firstSent?: boolean; attempt?: number } = {},
): Promise<boolean> {
  const who = { campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username };
  const opened = conversation.last_inbound_at;
  const windowEnds = (opened ?? 0) + MESSAGING_WINDOW;
  if (opened === null || ctx.now() > windowEnds) {
    if (opts.attempt !== undefined) await ctx.db.prepare(`UPDATE conversations SET ${CLEAR_PENDING} WHERE id = ?`).bind(conversation.id).run();
    await log(ctx, { kind: "message", outcome: "skipped", reason: "outside Meta's 24-hour window", ...who });
    return false;
  }
  const keep = (attempts: number, nextAt: number | null) =>
    ctx.db
      .prepare(
        `UPDATE conversations SET pending_message = ?, pending_state = ?, pending_reason = ?, pending_kind = ?, pending_attempts = ?, pending_at = ?
         WHERE id = ?`,
      )
      .bind(JSON.stringify(message), state, reason, kind, attempts, nextAt, conversation.id);
  if (!ctx.budget.take()) {
    // No room in this run: the next one sends it, with no attempt counted.
    if (opts.firstSent) await log(ctx, { kind: "message", outcome: "failed", reason: "too many requests in one run", ...who });
    else if (opts.attempt === undefined) await ctx.db.batch([keep(0, ctx.now()), logStatement(ctx, { kind: "message", outcome: "queued", reason: "waiting for the next run", ...who })]);
    return false;
  }
  // The campaign's links go out as /go/ links, so a click can be counted.
  const out = await trackLinks(ctx, conversation.id, campaign, message);
  try {
    await sendWithFallback((m) => ctx.meta!.sendMessage(conversation.ig_user_id, m), out);
  } catch (err) {
    const { reason: why, detail } = explainError(err);
    if (!(err instanceof MetaError && err.transient) || opts.firstSent) {
      const clear = opts.attempt !== undefined ? [ctx.db.prepare(`UPDATE conversations SET ${CLEAR_PENDING} WHERE id = ?`).bind(conversation.id)] : [];
      await ctx.db.batch([...clear, logStatement(ctx, { kind: "message", outcome: "failed", reason: why, ...who, detail })]);
      return false;
    }
    const attempts = (opts.attempt ?? 0) + 1;
    const delay = MESSAGE_RETRY_AFTER[attempts - 1];
    const nextAt = delay !== undefined && ctx.now() + delay < windowEnds ? ctx.now() + delay : null;
    await ctx.db.batch([
      keep(attempts, nextAt),
      logStatement(ctx, { kind: "message", outcome: "failed", reason: nextAt === null ? MESSAGE_GAVE_UP_REASON : TRANSIENT_REASON, ...who, detail }),
    ]);
    return false;
  }
  const now = ctx.now();
  const followAsked = state === "awaiting_follow" ? 1 : state === "follow_reasked" ? 2 : null;
  await ctx.db.batch([
    opts.firstSent
      ? ctx.db
          .prepare(`UPDATE conversations SET state = ?, first_sent_at = ?, updated_at = ?, ${CLEAR_PENDING} WHERE id = ?`)
          .bind(state, now, now, conversation.id)
      : ctx.db.prepare(`UPDATE conversations SET state = ?, updated_at = ?, ${CLEAR_PENDING} WHERE id = ?`).bind(state, now, conversation.id),
    ...(followAsked !== null ? [ctx.db.prepare("UPDATE conversations SET follow_asked = ? WHERE id = ?").bind(followAsked, conversation.id)] : []),
    logStatement(ctx, { kind, outcome: "sent", reason, ...who }),
  ]);
  conversation.state = state;
  return true;
}

/** A conversation with a message waiting after a refusal, as the Cron and To check read it. */
type PendingRow = Conversation & { pending_message: string; pending_state: ConversationState; pending_reason: string; pending_kind: "link" | "message"; pending_attempts: number };

/** Sends a waiting message once more, through send(), counting the attempt. */
async function sendPending(ctx: Ctx, row: PendingRow): Promise<boolean> {
  const campaign = await getCampaign(ctx.db, row.campaign_id);
  let message: OutMessage | null = null;
  try {
    message = JSON.parse(row.pending_message) as OutMessage;
  } catch {
    // Unreadable: nothing to send.
  }
  if (!campaign || !message) {
    await ctx.db.prepare(`UPDATE conversations SET ${CLEAR_PENDING} WHERE id = ?`).bind(row.id).run();
    return false;
  }
  // A tap on a campaign switched off since still gets its answer, as a live tap would.
  return send(ctx, row, campaign, message, row.pending_state, row.pending_reason, row.pending_kind, { attempt: row.pending_attempts });
}

/** How long a retry the Cron took is kept from another Cron run. */
const RETRY_LOCK = 2 * MINUTE;

/**
 * Called by the Cron: sends the messages Meta refused that are due again, at most
 * `limit`. Each is taken first (its next try moved a little later), so two runs
 * can't send it twice.
 */
export async function retryPendingMessages(ctx: Ctx, limit: number): Promise<void> {
  if (!ctx.meta || limit <= 0) return;
  const now = ctx.now();
  const { results } = await ctx.db
    .prepare(
      `UPDATE conversations SET pending_at = ?1
       WHERE id IN (SELECT id FROM conversations WHERE pending_at IS NOT NULL AND pending_at <= ?2 AND pending_message IS NOT NULL ORDER BY pending_at LIMIT ?3)
       RETURNING *`,
    )
    .bind(now + RETRY_LOCK, now, limit)
    .all<PendingRow>();
  for (const row of results) {
    if (ctx.budget.left < 1 || ctx.budget.queriesLeft < 8) break;
    await sendPending(ctx, row);
  }
}

/**
 * The owner's "Send" under To check: sends a message Meta refused now, whether the
 * Cron is still retrying it or stopped. Only one still waiting and still inside Meta's
 * 24-hour window. Returns whether it went out, or null when nothing was waiting.
 */
export async function sendPendingNow(ctx: Ctx, campaignId: number, conversationId: number): Promise<boolean | null> {
  if (!ctx.meta) return null;
  const row = await ctx.db
    .prepare(
      // Kept from the Cron while this click sends it; a refusal sets the next try again.
      `UPDATE conversations SET pending_at = ? WHERE id = ? AND campaign_id = ? AND pending_message IS NOT NULL RETURNING *`,
    )
    .bind(ctx.now() + RETRY_LOCK, conversationId, campaignId)
    .first<PendingRow>();
  if (!row) return null;
  return sendPending(ctx, row);
}

/** Records the person's latest tap or message: the start of a new 24-hour window. */
async function touch(ctx: Ctx, conversation: Conversation, at: number): Promise<void> {
  conversation.last_inbound_at = Math.max(conversation.last_inbound_at ?? 0, at);
  await ctx.db
    .prepare("UPDATE conversations SET last_inbound_at = ?, updated_at = ? WHERE id = ?")
    .bind(conversation.last_inbound_at, ctx.now(), conversation.id)
    .run();
}
