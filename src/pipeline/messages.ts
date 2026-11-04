import {
  afterOpening,
  firstMessage,
  getCampaign,
  linkMessage,
  listCampaigns,
  matchDm,
  OPEN_PAYLOAD_PREFIX,
  type Campaign,
  type ConversationState,
} from "../campaigns";
import { log, logStatement, type Ctx } from "../context";
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
  if (open) {
    const campaign = await getCampaign(ctx.db, open.campaign_id);
    if (!campaign) return;
    await touch(ctx, open, ev.timestamp);
    if (open.state === "opened") {
      // They wrote instead of tapping: that opens the conversation just the same.
      return advance(ctx, open, campaign, afterOpening(campaign), "reply instead of tap");
    }
    return emailStep(ctx, open, campaign, text);
  }

  const campaign = matchDm(await listCampaigns(ctx.db, true), text);
  if (!campaign) return; // an ordinary DM, none of OwnChats' business
  return dmKeyword(ctx, campaign, ev);
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
  await advance(ctx, conversation, campaign, afterOpening(campaign), "after the tap");
}

async function emailStep(ctx: Ctx, conversation: Conversation, campaign: Campaign, text: string): Promise<void> {
  const email = extractEmail(text);
  const who = { campaignId: campaign.id, igUserId: conversation.ig_user_id, username: conversation.username };
  if (email) {
    await ctx.db.batch([
      ctx.db
        .prepare(
          `INSERT INTO leads (campaign_id, ig_user_id, username, email, consent_text, consented_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (campaign_id, ig_user_id) DO UPDATE SET email = excluded.email, username = excluded.username,
             consent_text = excluded.consent_text, consented_at = excluded.consented_at`,
        )
        .bind(campaign.id, conversation.ig_user_id, conversation.username, email, campaign.emailPrompt, ctx.now()),
      logStatement(ctx, { kind: "email", outcome: "saved", ...who }),
    ]);
    return advance(ctx, conversation, campaign, { message: linkMessage(campaign), state: "done" }, "after the email");
  }
  if (conversation.state === "awaiting_email") {
    return advance(ctx, conversation, campaign, { message: { kind: "text", text: campaign.emailReask }, state: "reasked" }, "re-ask");
  }
  await log(ctx, { kind: "email", outcome: "skipped", reason: "no email after the re-ask", ...who });
  return advance(ctx, conversation, campaign, { message: linkMessage(campaign), state: "done" }, "link without an email");
}

async function dmKeyword(ctx: Ctx, campaign: Campaign, ev: InboundEvent): Promise<void> {
  const existing = await getConversation(ctx.db, campaign.id, ev.senderId);
  if (existing) {
    // They asked again by DM; sending the link once more is what they want.
    if (existing.state === "done") {
      await touch(ctx, existing, ev.timestamp);
      await send(ctx, existing, campaign, linkMessage(campaign), "done", "link sent again on request");
    }
    return;
  }
  let username: string | null = null;
  if (ctx.budget.take()) username = await ctx.meta!.getUsername(ev.senderId).catch(() => null);
  const first = firstMessage(campaign, "dm");
  const claimed = await claimConversation(ctx.db, {
    campaignId: campaign.id,
    igUserId: ev.senderId,
    commenterId: null,
    username,
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
    username,
    trigger: "dm",
    comment_id: null,
    state: first.state,
    first_sent_at: null,
    last_inbound_at: ev.timestamp,
    created_at: ctx.now(),
    updated_at: ctx.now(),
  };
  const ok = await send(ctx, conversation, campaign, first.message, first.state, "DM keyword", { firstSent: true });
  if (!ok) await releaseClaim(ctx.db, conversation.id);
}

function advance(
  ctx: Ctx,
  conversation: Conversation,
  campaign: Campaign,
  next: { message: OutMessage; state: ConversationState },
  reason: string,
): Promise<void> {
  return send(ctx, conversation, campaign, next.message, next.state, reason).then(() => undefined);
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
  try {
    await sendWithFallback((m) => ctx.meta!.sendMessage(conversation.ig_user_id, m), message);
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
    logStatement(ctx, { kind: state === "done" ? "link" : "message", outcome: "sent", reason, ...who }),
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
