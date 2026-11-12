import { matchesKeyword, parseKeywords, withoutKeywords } from "./match";
import { plainText, type Button, type OutMessage } from "./meta/client";

/**
 * none: link only. optional: the link, plus an optional "reply with your email".
 * first: ask for the email, re-ask once, then send the link either way.
 */
export type EmailMode = "none" | "optional" | "first";
export const EMAIL_MODES: EmailMode[] = ["none", "optional", "first"];

export interface Link {
  label: string;
  url: string;
}

export interface Campaign {
  id: number;
  name: string;
  /** The video this campaign is for, in the owner's own numbering (for example SF-14). Empty: none. */
  videoId: string;
  keywords: string[];
  anyComment: boolean;
  /** The one post this campaign watches; null for all posts, or while it waits for the next post. */
  mediaId: string | null;
  mediaLabel: string | null;
  /**
   * Set while the campaign waits for the next post: it then attaches to the first
   * post published after this time (Unix ms). Null once attached, and for every
   * other campaign.
   */
  nextPostAfter: number | null;
  publicReplies: string[];
  /** Index of the public reply used last, so the next one differs. */
  replyCursor: number;
  openingText: string;
  openingButton: string;
  emailMode: EmailMode;
  emailPrompt: string;
  emailReask: string;
  emailThanks: string;
  optionalPrompt: string;
  optionalThanks: string;
  /** Label of the button under the thank-you that opens the privacy page. Empty: no button. */
  optionalThanksButton: string;
  consentText: string;
  /** Sent to the lead webhook as campaign.email_tag, so the owner's email tool can pick the sequence. Empty: none. */
  emailTag: string;
  linkText: string;
  links: Link[];
  /** What the first link leads to, in words, for the lead webhook's email. Empty: none. */
  linkTitle: string;
  /**
   * Before the link (and the email step), ask Meta whether the person follows the
   * account, and ask them to follow first if not. Needs the opening button: Meta
   * only answers once the person has tapped or written.
   */
  followCheck: boolean;
  /** Sent with the follow button when they don't follow. */
  followPrompt: string;
  /** Sent once more when they tap the follow button but still don't follow. */
  followReask: string;
  followButton: string;
  dmKeyword: boolean;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CampaignRow {
  id: number;
  name: string;
  video_id: string;
  keywords: string;
  any_comment: number;
  media_id: string | null;
  media_label: string | null;
  next_post_after: number | null;
  public_replies: string;
  reply_cursor: number;
  opening_text: string;
  opening_button: string;
  email_mode: string;
  email_prompt: string;
  email_reask: string;
  email_thanks: string;
  optional_prompt: string;
  optional_thanks: string;
  optional_thanks_button: string;
  consent_text: string;
  email_tag: string;
  link_text: string;
  links: string;
  link_title: string;
  follow_check: number;
  follow_prompt: string;
  follow_reask: string;
  follow_button: string;
  dm_keyword: number;
  active: number;
  created_at: number;
  updated_at: number;
}

function fromRow(r: CampaignRow): Campaign {
  return {
    id: r.id,
    name: r.name,
    videoId: r.video_id ?? "",
    keywords: JSON.parse(r.keywords) as string[],
    anyComment: !!r.any_comment,
    mediaId: r.media_id,
    mediaLabel: r.media_label,
    nextPostAfter: r.next_post_after,
    publicReplies: JSON.parse(r.public_replies) as string[],
    replyCursor: r.reply_cursor,
    openingText: r.opening_text,
    openingButton: r.opening_button,
    emailMode: (EMAIL_MODES as string[]).includes(r.email_mode) ? (r.email_mode as EmailMode) : "none",
    emailPrompt: r.email_prompt,
    emailReask: r.email_reask,
    emailThanks: r.email_thanks,
    optionalPrompt: r.optional_prompt,
    optionalThanks: r.optional_thanks,
    optionalThanksButton: r.optional_thanks_button ?? "",
    consentText: r.consent_text,
    emailTag: r.email_tag,
    linkText: r.link_text,
    links: JSON.parse(r.links) as Link[],
    linkTitle: r.link_title,
    followCheck: !!r.follow_check,
    followPrompt: r.follow_prompt,
    followReask: r.follow_reask,
    followButton: r.follow_button,
    dmKeyword: !!r.dm_keyword,
    active: !!r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The form's value for "the next post you publish". */
export const NEXT_POST = "next";

/** A campaign on every post: no post chosen, and not waiting for the next one. */
export function onAllPosts(c: Pick<Campaign, "mediaId" | "nextPostAfter">): boolean {
  return c.mediaId === null && c.nextPostAfter === null;
}

/** A post's caption, shortened, as the form lists it and as a campaign keeps it. */
export function postLabel(m: { id: string; caption?: string | null }): string {
  const c = (m.caption || "").replace(/\s+/g, " ").trim();
  return c ? (c.length > 70 ? `${c.slice(0, 70)}...` : c) : `Post ${m.id}`;
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

/** Wording a new campaign starts with, so it works without editing. */
export const DEFAULTS = {
  publicReplies: [
    "Sent! Check your DMs, it may be under message requests.",
    "Just sent it to your DMs. Look in message requests if you don't see it.",
    "Done, check your DMs (or your message requests).",
  ],
  openingText: "Hey {name}! Thanks for your comment. Tap the button and I'll send it over.",
  openingButton: "Send me the link",
  emailReask: "Hmm, that doesn't look like an email address. Could you type it again? (Or reply anything and I'll just send the link.)",
  emailThanks: "Thanks! Here it is:",
  // The email questions say what people will get and that they can unsubscribe. They
  // don't name the sender: the DM comes from the sender's own account.
  emailPrompt: "What's your email? I'll send you the link here, and my next ones as they come out. Unsubscribe anytime.",
  optionalPrompt: "Want more like this? Reply with your email and I'll send you my next ones as they come out. Unsubscribe anytime.",
  optionalThanks: "Thanks, you're on the list!",
  optionalThanksButton: "Privacy",
  linkText: "Here you go:",
  linkLabel: "Open",
  followPrompt: "Almost there, {name}! Follow me first, then tap the button and I'll send it over.",
  followReask: "I can't see your follow yet. It can take a moment to show up. Follow me, then tap the button again.",
  followButton: "I'm following",
};

/**
 * The wording a new campaign starts with where the owner chose their own in
 * Settings ("Defaults for new campaigns"): the message with the link, the first
 * link's button label, the optional email ask, and its thank-you and button. Anything left empty there is
 * OwnChats' own.
 */
export function ownDefaults(s: {
  default_optional_prompt?: string;
  default_optional_thanks?: string;
  default_thanks_button?: string;
  default_link_label?: string;
  default_link_text?: string;
}): { optionalPrompt: string; optionalThanks: string; optionalThanksButton: string; linkLabel: string; linkText: string } {
  return {
    linkText: s.default_link_text || DEFAULTS.linkText,
    optionalPrompt: s.default_optional_prompt || DEFAULTS.optionalPrompt,
    optionalThanks: s.default_optional_thanks || DEFAULTS.optionalThanks,
    optionalThanksButton: s.default_thanks_button || DEFAULTS.optionalThanksButton,
    linkLabel: s.default_link_label || DEFAULTS.linkLabel,
  };
}

/**
 * OwnChats' own privacy page, which shows the sender's name and mailing address
 * from Settings. Null until the Worker's address is known.
 */
export function privacyUrl(s: { base_url?: string }): string | null {
  return s.base_url ? `${s.base_url}/privacy` : null;
}

// Meta's limits: 640 characters of text in a button template, 1000 in a text
// message, up to 3 buttons, and 20 characters per button label.
const MAX_TEMPLATE_TEXT = 640;
const MAX_TEXT = 1000;
const MAX_BUTTON = 20;
const MAX_LINKS = 3;
/** Limits for the owner's own defaults in Settings, the same as a campaign's. */
export const DEFAULT_LIMITS = { linkText: MAX_TEMPLATE_TEXT, optionalPrompt: MAX_TEXT, optionalThanks: MAX_TEMPLATE_TEXT, button: MAX_BUTTON };
const MAX_EMAIL_TAG = 100;
const MAX_LINK_TITLE = 200;
const MAX_VIDEO_ID = 40;
/** A video id: letters, digits, dots, dashes and underscores, starting with a letter or digit ("SF-14"). */
const VIDEO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/**
 * Room kept for each link in a text message: with click counting on, the link goes
 * out as the Worker's own /go/ address, which may be longer than the link itself.
 */
const TRACKED_URL_ROOM = 100;

export type CampaignInput = Omit<Campaign, "id" | "replyCursor" | "createdAt" | "updatedAt">;

/**
 * Reads the dashboard form. Returns the input and a list of problems, in plain words.
 * Choosing the next post sets `nextPostAfter` to `now`; saving keeps an earlier time
 * if the campaign was already waiting.
 */
export function campaignFromForm(form: FormData, now: number): { input: CampaignInput; errors: string[] } {
  const text = (k: string) => String(form.get(k) ?? "").trim();
  const lines = (k: string) =>
    text(k)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  const post = text("media_id");
  const mediaId = post && post !== "all" && post !== NEXT_POST ? post : null;
  const mode = text("email_mode");
  const links: Link[] = [];
  for (let i = 0; i < MAX_LINKS; i++) {
    const url = text(`link_url_${i}`);
    if (url) links.push({ url, label: text(`link_label_${i}`) });
  }
  const input: CampaignInput = {
    name: text("name"),
    videoId: text("video_id"),
    keywords: parseKeywords(text("keywords")),
    anyComment: form.get("any_comment") === "on",
    mediaId,
    mediaLabel: mediaId ? text("media_label") || null : null,
    nextPostAfter: post === NEXT_POST ? now : null,
    publicReplies: lines("public_replies"),
    openingText: text("opening_text"),
    openingButton: text("opening_button"),
    emailMode: (EMAIL_MODES as string[]).includes(mode) ? (mode as EmailMode) : "none",
    emailPrompt: text("email_prompt"),
    emailReask: text("email_reask"),
    emailThanks: text("email_thanks"),
    optionalPrompt: text("optional_prompt"),
    optionalThanks: text("optional_thanks"),
    optionalThanksButton: text("optional_thanks_button"),
    consentText: text("consent_text"),
    emailTag: text("email_tag"),
    linkText: text("link_text"),
    links,
    linkTitle: text("link_title"),
    followCheck: form.get("follow_check") === "on",
    followPrompt: text("follow_prompt"),
    followReask: text("follow_reask"),
    followButton: text("follow_button"),
    dmKeyword: form.get("dm_keyword") === "on",
    active: form.get("active") === "on",
  };
  return { input, errors: validateCampaign(input) };
}

export function validateCampaign(c: CampaignInput): string[] {
  const errors: string[] = [];
  const longest = (...texts: string[]) => Math.max(...texts.map((t) => fill(t, {}).length));
  if (!c.name) errors.push("Give the campaign a name.");
  if (!c.anyComment && c.keywords.length === 0) errors.push("Add at least one keyword, or turn on \"any comment\".");
  if (c.anyComment && onAllPosts(c)) errors.push("\"Any comment\" needs one chosen post, not all posts.");

  if (c.links.length === 0) errors.push("Add the link to send.");
  for (const l of c.links) {
    try {
      const u = new URL(l.url);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    } catch {
      errors.push(`"${l.url}" is not a full web address. Links start with https://`);
    }
    if (l.label.length > MAX_BUTTON) errors.push(`Button labels must be ${MAX_BUTTON} characters or fewer ("${l.label}").`);
  }
  const buttons = usesButtons(c.links);
  if (c.links.some((l) => l.label) && !buttons) errors.push("Give every link a button label, or none of them (then the links go in the text).");
  if (buttons && !c.linkText) errors.push("Write the message that goes with the link buttons.");
  const linkLimit = buttons ? MAX_TEMPLATE_TEXT : MAX_TEXT - c.links.reduce((n, l) => n + Math.max(l.url.length, TRACKED_URL_ROOM) + 1, 0);
  const withAsk = c.emailMode === "optional" ? `${c.linkText}\n\n${c.optionalPrompt}` : c.linkText;
  if (longest(withAsk, c.emailMode === "first" ? c.emailThanks : "") > linkLimit) {
    errors.push(`The message with the link must be ${linkLimit} characters or fewer${c.emailMode === "optional" ? ", including the email line" : ""}.`);
  }

  if (c.openingButton) {
    if (!c.openingText) errors.push("Write the opening message that goes with the button.");
    if (longest(c.openingText) > MAX_TEMPLATE_TEXT) errors.push(`The opening message must be ${MAX_TEMPLATE_TEXT} characters or fewer.`);
    if (c.openingButton.length > MAX_BUTTON) errors.push(`The opening button label must be ${MAX_BUTTON} characters or fewer.`);
  }
  if (c.emailMode === "first") {
    if (!c.emailPrompt) errors.push("Write the email question, and say what people will receive.");
    if (!c.emailReask) errors.push("Write the reply for when the answer is not an email.");
    if (longest(c.emailPrompt, c.emailReask) > MAX_TEXT) errors.push(`Email messages must be ${MAX_TEXT} characters or fewer.`);
  }
  if (c.emailMode === "optional") {
    if (!c.optionalPrompt) errors.push("Write the optional email line, and say what people will receive.");
    const thanksLimit = c.optionalThanksButton ? MAX_TEMPLATE_TEXT : MAX_TEXT;
    if (longest(c.optionalPrompt) > MAX_TEXT) errors.push(`The email ask must be ${MAX_TEXT} characters or fewer.`);
    if (longest(c.optionalThanks) > thanksLimit) errors.push(`The thank-you must be ${thanksLimit} characters or fewer.`);
    if (c.optionalThanksButton.length > MAX_BUTTON) errors.push(`The thank-you's button label must be ${MAX_BUTTON} characters or fewer.`);
  }
  if (c.followCheck) {
    if (!c.openingButton) {
      errors.push("The follow check needs the first DM's button: Meta only says whether someone follows you after they tap or write.");
    }
    if (!c.followPrompt || !c.followReask) errors.push("Write both follow messages: the ask, and the one for a tap without a follow.");
    if (longest(c.followPrompt, c.followReask) > MAX_TEMPLATE_TEXT) errors.push(`Follow messages must be ${MAX_TEMPLATE_TEXT} characters or fewer.`);
    if (!c.followButton) errors.push("Give the follow button a label.");
    if (c.followButton.length > MAX_BUTTON) errors.push(`The follow button label must be ${MAX_BUTTON} characters or fewer.`);
  }
  if (c.publicReplies.some((r) => r.length > 300)) errors.push("Keep each public reply under 300 characters.");
  if (c.emailTag.length > MAX_EMAIL_TAG) errors.push(`Keep the email tag under ${MAX_EMAIL_TAG} characters.`);
  if (c.videoId.length > MAX_VIDEO_ID) errors.push(`Keep the video id under ${MAX_VIDEO_ID} characters.`);
  else if (c.videoId && !VIDEO_ID.test(c.videoId)) errors.push(`The video id can use letters, digits, dots, dashes and underscores, like SF-14 ("${c.videoId}").`);
  if (c.linkTitle.length > MAX_LINK_TITLE) errors.push(`Keep the link's title under ${MAX_LINK_TITLE} characters.`);
  return errors;
}

export async function saveCampaign(db: D1Database, c: CampaignInput, id: number | null, now: number): Promise<number> {
  const values = [
    c.name,
    c.videoId,
    JSON.stringify(c.keywords),
    c.anyComment ? 1 : 0,
    c.mediaId,
    c.mediaLabel,
    JSON.stringify(c.publicReplies),
    c.openingText,
    c.openingButton,
    c.emailMode,
    c.emailPrompt,
    c.emailReask,
    c.emailThanks,
    c.optionalPrompt,
    c.optionalThanks,
    c.optionalThanksButton,
    c.consentText,
    c.emailTag,
    c.linkText,
    JSON.stringify(c.links),
    c.linkTitle,
    c.followCheck ? 1 : 0,
    c.followPrompt,
    c.followReask,
    c.followButton,
    c.dmKeyword ? 1 : 0,
    c.active ? 1 : 0,
  ];
  const columns = `name, video_id, keywords, any_comment, media_id, media_label, public_replies, opening_text, opening_button, email_mode,
    email_prompt, email_reask, email_thanks, optional_prompt, optional_thanks, optional_thanks_button, consent_text, email_tag, link_text, links, link_title,
    follow_check, follow_prompt, follow_reask, follow_button, dm_keyword, active`;
  if (id === null) {
    const row = await db
      // reply_cursor -1: no public reply used yet, so any variant can come first.
      .prepare(
        `INSERT INTO campaigns (${columns}, next_post_after, reply_cursor, created_at, updated_at)
         VALUES (${values.map(() => "?").join(", ")}, ?, -1, ?, ?) RETURNING id`,
      )
      .bind(...values, c.nextPostAfter, now, now)
      .first<{ id: number }>();
    return row!.id;
  }
  const sets = columns
    .split(",")
    .map((c) => `${c.trim()} = ?`)
    .join(", ");
  await db
    // A campaign already waiting keeps the time it started waiting, so a post published since still counts.
    .prepare(`UPDATE campaigns SET ${sets}, next_post_after = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(next_post_after, ?) END, updated_at = ? WHERE id = ?`)
    .bind(...values, c.nextPostAfter, c.nextPostAfter, now, id)
    .run();
  return id;
}

/** The on/off switch. Only this column, so it can't undo an edit saved in another tab. */
export async function setCampaignActive(db: D1Database, id: number, active: boolean, now: number): Promise<void> {
  await db.prepare("UPDATE campaigns SET active = ?, updated_at = ? WHERE id = ?").bind(active ? 1 : 0, now, id).run();
}

/**
 * Whether the shortcut keywords from Settings apply to this campaign: a keyword
 * campaign on one post, or waiting for one. A shortcut is shared by every campaign,
 * so it can't tell which link someone wants on its own: on a post it means that
 * post's campaign, and an all-posts campaign would answer it on every post.
 */
export function answersShortcuts(c: Pick<Campaign, "anyComment" | "mediaId" | "nextPostAfter">): boolean {
  return !c.anyComment && !onAllPosts(c);
}

/**
 * A campaign's own keywords, less the shortcuts, even when it lists one itself: what
 * comments are first matched against, what attaches it to its next post, and what
 * counts as its DM keyword. A shortcut picks out no campaign, so it does none of that.
 */
export function ownKeywords(c: Pick<Campaign, "keywords">, shortcuts: string[]): string[] {
  return withoutKeywords(c.keywords, shortcuts);
}

/**
 * The campaign a comment belongs to. A one-post campaign wins over an all-posts
 * one, and a keyword campaign wins over an any-comment one; then the oldest wins.
 * A campaign waiting for the next post matches nothing until it is attached.
 * Only when no campaign takes the comment this way are the shortcut keywords
 * (`shortcuts`, from Settings) tried, and then only for a keyword campaign on this
 * very post: so "AGENTS 🙌" still goes to the AGENTS campaign.
 */
export function matchComment(campaigns: Campaign[], mediaId: string, text: string, shortcuts: string[] = []): Campaign | null {
  const on = campaigns.filter((c) => c.active && (c.mediaId === mediaId || onAllPosts(c)));
  const candidates = on.filter((c) => c.anyComment || matchesKeyword(text, ownKeywords(c, shortcuts)));
  if (!candidates.length && shortcuts.length && matchesKeyword(text, shortcuts)) {
    candidates.push(...on.filter((c) => c.mediaId === mediaId && answersShortcuts(c)));
  }
  const rank = (c: Campaign) => (c.mediaId ? 0 : 2) + (c.anyComment ? 1 : 0);
  candidates.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  return candidates[0] ?? null;
}

/** The campaign a DM keyword belongs to (any-comment campaigns have no DM keyword, and shortcuts are never one). */
export function matchDm(campaigns: Campaign[], text: string, shortcuts: string[] = []): Campaign | null {
  return campaigns.find((c) => c.active && c.dmKeyword && !c.anyComment && matchesKeyword(text, ownKeywords(c, shortcuts))) ?? null;
}

/** Who a message is for, as far as OwnChats knows. */
export interface Person {
  name?: string | null;
  username?: string | null;
}

/**
 * Fills {name} and {username}. {name} is the person's Instagram name when Meta
 * shares it, otherwise their username; with neither, "there" ("Hey there!").
 */
export function fill(text: string, p: Person): string {
  const username = p.username?.trim() || "";
  const name = p.name?.trim() || username || "there";
  return text.replace(/\{\s*name\s*\}/gi, name).replace(/\{\s*username\s*\}/gi, username || "there");
}

/**
 * opened: first DM with the button sent. awaiting_follow, follow_reasked: asked to
 * follow, once or twice. awaiting_email, reasked: email first. awaiting_open: link
 * sent, the optional email ask follows its first open. optional_email: link sent
 * and email asked for, an email reply still welcome. done: link sent.
 */
export type ConversationState =
  | "opened"
  | "awaiting_follow"
  | "follow_reasked"
  | "awaiting_email"
  | "reasked"
  | "awaiting_open"
  | "optional_email"
  | "done";

/** The states in which the person has the link. */
export const LINK_STATES: ConversationState[] = ["awaiting_open", "optional_email", "done"];

function usesButtons(links: Link[]): boolean {
  return links.length > 0 && links.length <= MAX_LINKS && links.every((l) => l.label);
}

/** The link message: buttons when every link has a label, otherwise the links in the text. */
export function linkMessage(c: Campaign, p: Person, text = c.linkText): OutMessage {
  const body = fill(text, p);
  if (usesButtons(c.links)) {
    const buttons: Button[] = c.links.map((l) => ({ type: "web_url", title: fill(l.label, p), url: l.url }));
    return { kind: "buttons", text: body, buttons };
  }
  return { kind: "text", text: [body, ...c.links.map((l) => l.url)].filter(Boolean).join("\n") };
}

/**
 * The link. In "link plus optional email" mode the email ask comes with it: as a
 * message of its own once the person opens the link (`askOnOpen`), or, when no
 * second message can follow, as a line under the link.
 */
function linkStep(c: Campaign, p: Person, askOnOpen: boolean): { message: OutMessage; state: ConversationState } {
  if (c.emailMode === "optional") {
    if (askOnOpen) return { message: linkMessage(c, p), state: "awaiting_open" };
    const text = [c.linkText, c.optionalPrompt].filter(Boolean).join("\n\n");
    return { message: linkMessage(c, p, text), state: "optional_email" };
  }
  return { message: linkMessage(c, p), state: "done" };
}

export const OPEN_PAYLOAD_PREFIX = "OWNCHATS_OPEN:";
export const FOLLOW_PAYLOAD_PREFIX = "OWNCHATS_FOLLOW:";

/** The optional email ask as a message of its own, sent once the person has opened the link. */
export function emailAsk(c: Campaign, p: Person): OutMessage {
  return { kind: "text", text: fill(c.optionalPrompt, p) };
}

/** The reply to an optional email, with a button to the privacy page when the campaign has one. */
export function optionalThanksMessage(c: Campaign, p: Person, privacy: string | null): OutMessage {
  const text = fill(c.optionalThanks, p);
  if (!c.optionalThanksButton || !privacy) return { kind: "text", text };
  return { kind: "buttons", text, buttons: [{ type: "web_url", title: c.optionalThanksButton, url: privacy }] };
}

/**
 * The first DM, and the state it leaves the conversation in. `follows` is what Meta
 * said when the person started by DM; a comment's first DM comes before any check.
 * `askOnOpen`: see afterOpening. Never for a comment's first DM, a private reply,
 * which no second message can follow until the person answers.
 */
export function firstMessage(
  c: Campaign,
  trigger: "comment" | "dm",
  p: Person,
  follows: boolean | null = null,
  askOnOpen = false,
): { message: OutMessage; state: ConversationState } {
  if (trigger === "comment" && c.openingButton) {
    return {
      message: {
        kind: "buttons",
        text: fill(c.openingText, p),
        buttons: [{ type: "postback", title: fill(c.openingButton, p), payload: `${OPEN_PAYLOAD_PREFIX}${c.id}` }],
      },
      state: "opened",
    };
  }
  if (c.followCheck && follows === false) return followAsk(c, p, false);
  return afterOpening(c, p, trigger === "dm" && askOnOpen);
}

/** "Follow me first", with the button that checks again; `again` for the second ask. */
export function followAsk(c: Campaign, p: Person, again: boolean): { message: OutMessage; state: ConversationState } {
  return {
    message: {
      kind: "buttons",
      text: fill(again ? c.followReask : c.followPrompt, p),
      buttons: [{ type: "postback", title: fill(c.followButton, p), payload: `${FOLLOW_PAYLOAD_PREFIX}${c.id}` }],
    },
    state: again ? "follow_reasked" : "awaiting_follow",
  };
}

/**
 * What follows the tap (or the first DM when there is no button). `askOnOpen`: the
 * person has just tapped or written and the link's first open will be seen, so the
 * optional email ask can wait for it.
 */
export function afterOpening(c: Campaign, p: Person, askOnOpen = false): { message: OutMessage; state: ConversationState } {
  if (c.emailMode === "first") return { message: { kind: "text", text: fill(c.emailPrompt, p) }, state: "awaiting_email" };
  return linkStep(c, p, askOnOpen);
}

/** Email first: the link once the email is saved, with the thank-you as its text. */
export function linkAfterEmail(c: Campaign, p: Person): OutMessage {
  return linkMessage(c, p, c.emailThanks || c.linkText);
}

/** The wording saved with a lead: the campaign's consent text, or the question the person answered. */
export function consentFor(c: Campaign): string {
  return c.consentText || (c.emailMode === "optional" ? c.optionalPrompt : c.emailPrompt);
}

/**
 * The first DM without any button, for when Meta refuses a button template in a
 * private reply: the email question, or the link as text.
 */
export function plainFirstMessage(c: Campaign, p: Person): { message: OutMessage; state: ConversationState } {
  const next = afterOpening(c, p);
  return { message: plainText(next.message), state: next.state };
}

/** A public reply variant picked at random, never the same one twice in a row. */
export function pickPublicReply(c: Campaign, random: () => number): { index: number; text: string } | null {
  const n = c.publicReplies.length;
  if (!n) return null;
  let index = Math.floor(random() * n) % n;
  if (n > 1 && index === c.replyCursor) index = (index + 1 + Math.floor(random() * (n - 1))) % n;
  return { index, text: c.publicReplies[index]! };
}
