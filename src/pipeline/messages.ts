import {
  afterOpening,
  consentFor,
  fill,
  firstMessage,
  getCampaign,
  linkAfterEmail,
  linkMessage,
  listCampaigns,
  matchDm,
  OPEN_PAYLOAD_PREFIX,
  type Campaign,
  type ConversationState,
  type Person,
} from "../campaigns";
import { trackLinks } from "../clicks";
import { log, logStatement, type Ctx } from "../context";
import { deliverNow, queueLeadCreated } from "../leadwebhook";
import { extractEmail } from "../match";
import { explainError, sendWithFallback, type OutMessage } from "../meta/client";
import { DAY, MESSAGING_WINDOW } from "../time";
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

  if (ev.postbackPayload?.startsWith(OPEN_PAYLOAD_PREFIX)) return handleTap(ctx, ev);

  const text = ev.text ?? "";
  const open = await openConversation(ctx.db, ev.senderId, ctx.now() - 7 * DAY);
  const campaign = open ? await getCampaign(ctx.db, open.campaign_id) : null;
  if (open && campaign) {
    if (open.state !== "optional_email") {
      await touch(ctx, open, ev.timestamp);
      await learnProfile(ctx, open);
      // They wrote instead of tapping: that opens the conversation just the same.
      if (open.state === "opened") return advance(ctx, open, campaign, afterOpening(campaign, person(open)), "reply instead of tap");
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

  const keywordCampaign = matchDm(await listCampaigns(ctx.db, true), text);
  if (!keywordCampaign) return; // an ordinary DM, none of OwnChats' business
  return dmKeyword(ctx, keywordCampaign, ev);
}

async function handleTap(ctx: Ctx, ev: InboundEvent): Promise<void> {
  const campaignId = Number(ev.postbackPayload!.slice(OPEN_PAYLOAD_PREFIX.length));
  const campaign = Number.isInteger(campaignId) ? await getCampaign(ctx.db, campaignId) : null;
  const conversation = campaign ? await getConversation(ctx.db, campaign.id, ev.senderId) : null;
  if (!campaign || !conversation) {
    await log(ctx, { kind: "tap", outcome: "skipped", reason: "no conversation for this button", igUserId: ev.senderId });
    return;
  }
  await touch(ctx, conversation, ev.timestamp);
  const who = { campaignId: campaign.id, igUserId: ev.senderId, username: conversation.username };
  if (conversation.state !== "opened") {
    await log(ctx, { kind: "tap", outcome: "skipped", reason: "button already tapped", ...who });
    return;
  }
  await log(ctx, { kind: "tap", outcome: "received", ...who });
  await learnProfile(ctx, conversation);
  await advance(ctx, conversation, campaign, afterOpening(campaign, person(conversation)), "after the tap");
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
    return deliverNow(ctx, delivery);
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
    await send(ctx, conversation, campaign, { kind: "text", text: fill(campaign.optionalThanks, person(conversation)) }, "done", "thank-you", "message");
  } else {
    await ctx.db.prepare("UPDATE conversations SET state = 'done', updated_at = ? WHERE id = ?").bind(ctx.now(), conversation.id).run();
  }
  await deliverNow(ctx, delivery);
}

async function dmKeyword(ctx: Ctx, campaign: Campaign, ev: InboundEvent): Promise<void> {
  const existing = await getConversation(ctx.db, campaign.id, ev.senderId);
  if (existing) {
    // They asked again by DM; sending the link once more is what they want.
    if (existing.state === "done" || existing.state === "optional_email") {
      await touch(ctx, existing, ev.timestamp);
      await send(ctx, existing, campaign, linkMessage(campaign, person(existing)), existing.state, "link sent again on request", "link");
    }
    return;
  }
  let profile: Person = {};
  if (ctx.budget.take()) profile = await ctx.meta!.getProfile(ev.senderId).catch(() => ({}));
  const first = firstMessage(campaign, "dm", profile);
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
    created_at: ctx.now(),
    updated_at: ctx.now(),
  };
  if (profile.name) await ctx.db.prepare("UPDATE conversations SET name = ? WHERE id = ?").bind(profile.name, claimed).run();
  const ok = await send(ctx, conversation, campaign, first.message, first.state, "DM keyword", first.state === "done" || first.state === "optional_email" ? "link" : "message", { firstSent: true });
  if (!ok) await releaseClaim(ctx.db, conversation.id);
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
  const kind = next.state === "done" || next.state === "optional_email" ? "link" : "message";
  return send(ctx, conversation, campaign, next.message, next.state, reason, kind).then(() => undefined);
}

/**
 * Sends a follow-up and moves the conversation on. Refuses outside the 24-hour
 * window that the person's last tap or message opened. If Meta rejects a button
 * template, the same content goes again as plain text.
 */
async function send(
  ctx: Ctx,
  conversation: Conversation,
  campaign: Campaign,
  message: OutMessage,
  state: ConversationState,
  reason: string,
  kind: "link" | "message",
  opts: { firstSent?: boolean } = {},
): Promise<boolean> {
  const who = { campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username };
  const opened = conversation.last_inbound_at;
  if (opened === null || ctx.now() - opened > MESSAGING_WINDOW) {
    await log(ctx, { kind: "message", outcome: "skipped", reason: "outside Meta's 24-hour window", ...who });
    return false;
  }
  if (!ctx.budget.take()) {
    await log(ctx, { kind: "message", outcome: "failed", reason: "too many requests in one run", ...who });
    return false;
  }
  // The campaign's links go out as /go/ links, so a click can be counted.
  const out = await trackLinks(ctx, conversation.id, campaign, message);
  try {
    await sendWithFallback((m) => ctx.meta!.sendMessage(conversation.ig_user_id, m), out);
  } catch (err) {
    const { reason: why, detail } = explainError(err);
    await log(ctx, { kind: "message", outcome: "failed", reason: why, ...who, detail });
    return false;
  }
  const now = ctx.now();
  await ctx.db.batch([
    opts.firstSent
      ? ctx.db.prepare("UPDATE conversations SET state = ?, first_sent_at = ?, updated_at = ? WHERE id = ?").bind(state, now, now, conversation.id)
      : ctx.db.prepare("UPDATE conversations SET state = ?, updated_at = ? WHERE id = ?").bind(state, now, conversation.id),
    logStatement(ctx, { kind, outcome: "sent", reason, ...who }),
  ]);
  conversation.state = state;
  return true;
}

/** Records the person's latest tap or message: the start of a new 24-hour window. */
async function touch(ctx: Ctx, conversation: Conversation, at: number): Promise<void> {
  conversation.last_inbound_at = Math.max(conversation.last_inbound_at ?? 0, at);
  await ctx.db
    .prepare("UPDATE conversations SET last_inbound_at = ?, updated_at = ? WHERE id = ?")
    .bind(conversation.last_inbound_at, ctx.now(), conversation.id)
    .run();
}
