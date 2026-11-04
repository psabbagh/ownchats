import { matchesKeyword, parseKeywords } from "./match";
import { plainText, type Button, type OutMessage } from "./meta/client";

export interface Campaign {
  id: number;
  name: string;
  keywords: string[];
  anyComment: boolean;
  mediaId: string | null;
  mediaLabel: string | null;
  publicReplies: string[];
  openingText: string;
  openingButton: string;
  askEmail: boolean;
  emailPrompt: string;
  emailReask: string;
  linkText: string;
  linkUrl: string;
  linkButton: string;
  dmKeyword: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CampaignRow {
  id: number;
  name: string;
  keywords: string;
  any_comment: number;
  media_id: string | null;
  media_label: string | null;
  public_replies: string;
  opening_text: string;
  opening_button: string;
  ask_email: number;
  email_prompt: string;
  email_reask: string;
  link_text: string;
  link_url: string;
  link_button: string;
  dm_keyword: number;
  active: number;
  created_at: number;
  updated_at: number;
}

function fromRow(r: CampaignRow): Campaign {
  return {
    id: r.id,
    name: r.name,
    keywords: JSON.parse(r.keywords) as string[],
    anyComment: !!r.any_comment,
    mediaId: r.media_id,
    mediaLabel: r.media_label,
    publicReplies: JSON.parse(r.public_replies) as string[],
    openingText: r.opening_text,
    openingButton: r.opening_button,
    askEmail: !!r.ask_email,
    emailPrompt: r.email_prompt,
    emailReask: r.email_reask,
    linkText: r.link_text,
    linkUrl: r.link_url,
    linkButton: r.link_button,
    dmKeyword: !!r.dm_keyword,
    active: !!r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function listCampaigns(db: D1Database, activeOnly = false): Promise<Campaign[]> {
  const sql = activeOnly ? "SELECT * FROM campaigns WHERE active = 1 ORDER BY id" : "SELECT * FROM campaigns ORDER BY id";
  const { results } = await db.prepare(sql).all<CampaignRow>();
  return results.map(fromRow);
}

export async function getCampaign(db: D1Database, id: number): Promise<Campaign | null> {
  const row = await db.prepare("SELECT * FROM campaigns WHERE id = ?").bind(id).first<CampaignRow>();
  return row ? fromRow(row) : null;
}

/** Wording a new campaign starts with. Plain, and says where the DM may land. */
export const DEFAULTS = {
  publicReplies: [
    "Sent! Check your DMs, it may be under message requests.",
    "Just sent it to your DMs. Look in message requests if you don't see it.",
    "Done, check your DMs (or your message requests).",
  ],
  openingText: "Hey! Thanks for your comment. Tap the button and I'll send it over.",
  openingButton: "Send me the link",
  emailPrompt: "What's your email? I'll send you the link here, and you'll also get my newsletter. You can unsubscribe anytime.",
  emailReask: "Hmm, that doesn't look like an email address. Could you type it again? (Or reply anything and I'll just send the link.)",
  linkText: "Here you go:",
  linkButton: "Open",
};

// Meta's limits for button templates: 640 characters of text, 20 per button title.
const MAX_TEMPLATE_TEXT = 640;
const MAX_TEXT = 1000;
const MAX_BUTTON = 20;

export interface CampaignInput {
  name: string;
  keywords: string[];
  anyComment: boolean;
  mediaId: string | null;
  mediaLabel: string | null;
  publicReplies: string[];
  openingText: string;
  openingButton: string;
  askEmail: boolean;
  emailPrompt: string;
  emailReask: string;
  linkText: string;
  linkUrl: string;
  linkButton: string;
  dmKeyword: boolean;
  active: boolean;
}

/** Reads the dashboard form. Returns the input and a list of problems, in plain words. */
export function campaignFromForm(form: FormData): { input: CampaignInput; errors: string[] } {
  const text = (k: string) => String(form.get(k) ?? "").trim();
  const replies = text("public_replies")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const mediaId = text("media_id");
  const input: CampaignInput = {
    name: text("name"),
    keywords: parseKeywords(text("keywords")),
    anyComment: form.get("any_comment") === "on",
    mediaId: mediaId && mediaId !== "all" ? mediaId : null,
    mediaLabel: mediaId && mediaId !== "all" ? text("media_label") || null : null,
    publicReplies: replies,
    openingText: text("opening_text"),
    openingButton: text("opening_button"),
    askEmail: form.get("ask_email") === "on",
    emailPrompt: text("email_prompt"),
    emailReask: text("email_reask"),
    linkText: text("link_text"),
    linkUrl: text("link_url"),
    linkButton: text("link_button"),
    dmKeyword: form.get("dm_keyword") === "on",
    active: form.get("active") === "on",
  };
  return { input, errors: validateCampaign(input) };
}

export function validateCampaign(c: CampaignInput): string[] {
  const errors: string[] = [];
  if (!c.name) errors.push("Give the campaign a name.");
  if (!c.anyComment && c.keywords.length === 0) errors.push("Add at least one keyword, or turn on \"any comment\".");
  if (c.anyComment && !c.mediaId) errors.push("\"Any comment\" needs one chosen post, not all posts.");
  try {
    const u = new URL(c.linkUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    errors.push("The link must be a full web address starting with https://");
  }
  if (c.openingButton) {
    if (!c.openingText) errors.push("Write the opening message that goes with the button.");
    if (c.openingText.length > MAX_TEMPLATE_TEXT) errors.push(`The opening message must be ${MAX_TEMPLATE_TEXT} characters or fewer.`);
    if (c.openingButton.length > MAX_BUTTON) errors.push(`The opening button label must be ${MAX_BUTTON} characters or fewer.`);
  }
  if (c.askEmail) {
    if (!c.emailPrompt) errors.push("Write the email question, and say what people will receive.");
    if (!c.emailReask) errors.push("Write the re-ask message.");
    if (c.emailPrompt.length > MAX_TEXT || c.emailReask.length > MAX_TEXT) errors.push(`Email messages must be ${MAX_TEXT} characters or fewer.`);
  }
  if (c.linkButton) {
    if (c.linkButton.length > MAX_BUTTON) errors.push(`The link button label must be ${MAX_BUTTON} characters or fewer.`);
    if (!c.linkText) errors.push("Write the message that goes with the link button.");
    if (c.linkText.length > MAX_TEMPLATE_TEXT) errors.push(`The link message must be ${MAX_TEMPLATE_TEXT} characters or fewer.`);
  } else if (`${c.linkText}\n${c.linkUrl}`.length > MAX_TEXT) {
    errors.push(`The link message must be ${MAX_TEXT} characters or fewer.`);
  }
  if (c.publicReplies.some((r) => r.length > 300)) errors.push("Keep each public reply under 300 characters.");
  return errors;
}

export async function saveCampaign(db: D1Database, c: CampaignInput, id: number | null, now: number): Promise<number> {
  const values = [
    c.name,
    JSON.stringify(c.keywords),
    c.anyComment ? 1 : 0,
    c.mediaId,
    c.mediaLabel,
    JSON.stringify(c.publicReplies),
    c.openingText,
    c.openingButton,
    c.askEmail ? 1 : 0,
    c.emailPrompt,
    c.emailReask,
    c.linkText,
    c.linkUrl,
    c.linkButton,
    c.dmKeyword ? 1 : 0,
    c.active ? 1 : 0,
  ];
  if (id === null) {
    const row = await db
      .prepare(
        `INSERT INTO campaigns (name, keywords, any_comment, media_id, media_label, public_replies, opening_text, opening_button,
          ask_email, email_prompt, email_reask, link_text, link_url, link_button, dm_keyword, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(...values, now, now)
      .first<{ id: number }>();
    return row!.id;
  }
  await db
    .prepare(
      `UPDATE campaigns SET name = ?, keywords = ?, any_comment = ?, media_id = ?, media_label = ?, public_replies = ?,
        opening_text = ?, opening_button = ?, ask_email = ?, email_prompt = ?, email_reask = ?, link_text = ?, link_url = ?,
        link_button = ?, dm_keyword = ?, active = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(...values, now, id)
    .run();
  return id;
}

/**
 * The campaign a comment belongs to. A one-post campaign wins over an all-posts
 * one, and a keyword campaign wins over an any-comment one; then the oldest wins.
 */
export function matchComment(campaigns: Campaign[], mediaId: string, text: string): Campaign | null {
  const candidates = campaigns.filter(
    (c) => c.active && (c.mediaId === null || c.mediaId === mediaId) && (c.anyComment || matchesKeyword(text, c.keywords)),
  );
  const rank = (c: Campaign) => (c.mediaId ? 0 : 2) + (c.anyComment ? 1 : 0);
  candidates.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  return candidates[0] ?? null;
}

/** The campaign a DM keyword belongs to (any-comment campaigns have no DM keyword). */
export function matchDm(campaigns: Campaign[], text: string): Campaign | null {
  return campaigns.find((c) => c.active && c.dmKeyword && !c.anyComment && matchesKeyword(text, c.keywords)) ?? null;
}

export type ConversationState = "opened" | "awaiting_email" | "reasked" | "done";

export function linkMessage(c: Campaign): OutMessage {
  if (c.linkButton) {
    const buttons: Button[] = [{ type: "web_url", title: c.linkButton, url: c.linkUrl }];
    return { kind: "buttons", text: c.linkText, buttons };
  }
  return { kind: "text", text: c.linkText ? `${c.linkText}\n${c.linkUrl}` : c.linkUrl };
}

export const OPEN_PAYLOAD_PREFIX = "OWNCHATS_OPEN:";

/** The first DM, and the state it leaves the conversation in. */
export function firstMessage(c: Campaign, trigger: "comment" | "dm"): { message: OutMessage; state: ConversationState } {
  if (trigger === "comment" && c.openingButton) {
    return {
      message: {
        kind: "buttons",
        text: c.openingText,
        buttons: [{ type: "postback", title: c.openingButton, payload: `${OPEN_PAYLOAD_PREFIX}${c.id}` }],
      },
      state: "opened",
    };
  }
  return afterOpening(c);
}

/** What follows the tap (or the first DM when there is no button). */
export function afterOpening(c: Campaign): { message: OutMessage; state: ConversationState } {
  if (c.askEmail) return { message: { kind: "text", text: c.emailPrompt }, state: "awaiting_email" };
  return { message: linkMessage(c), state: "done" };
}

/**
 * The first DM without any button, for when Meta refuses a button template in a
 * private reply: the email question, or the link as text.
 */
export function plainFirstMessage(c: Campaign): { message: OutMessage; state: ConversationState } {
  if (c.askEmail) return { message: { kind: "text", text: c.emailPrompt }, state: "awaiting_email" };
  return { message: plainText(linkMessage(c)), state: "done" };
}
