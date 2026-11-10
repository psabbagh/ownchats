import { onAllPosts, type Campaign } from "./campaigns";

/** Where a campaign listens: its one post, the next post once it goes up, or every post. */
export type Attachment = "post" | "next_post" | "all_posts";

export function attachmentOf(c: Pick<Campaign, "mediaId" | "nextPostAfter">): Attachment {
  if (c.nextPostAfter !== null) return "next_post";
  return onAllPosts(c) ? "all_posts" : "post";
}

export interface Warning {
  code: string;
  message: string;
}

/**
 * What would stop a campaign from doing all it was set up for, found from its own
 * settings and whether the lead webhook is set. Each of these fails silently in
 * use: the comment is answered, and the email or the guide just never comes.
 * Spelling problems between a caption and the keyword are checked per caption
 * (see captionCheck), since the caption isn't known here.
 */
export function campaignWarnings(c: Campaign, leadWebhookOn: boolean): Warning[] {
  const out: Warning[] = [];
  const asks = c.emailMode !== "none";
  if (!c.active) out.push({ code: "off", message: "The campaign is off: it answers nobody." });
  if (!c.links.length) out.push({ code: "no_link", message: "The campaign has no link to send." });
  if (c.emailTag && !asks) {
    out.push({ code: "email_tag_without_email_ask", message: "It has an email tag but never asks for an email, so no lead is ever sent. Choose \"Link plus optional email\" or \"Email first\"." });
  }
  if (asks && !c.emailTag) out.push({ code: "email_ask_without_tag", message: "It asks for an email but has no email tag, so the email tool can't tell which email to send." });
  if (asks && !c.linkTitle) out.push({ code: "email_ask_without_link_title", message: "It asks for an email but the first link has no title, so the email can't name what it delivers." });
  if (asks && !leadWebhookOn) out.push({ code: "email_ask_without_lead_webhook", message: "It asks for an email but the lead webhook isn't set in Settings, so emails stay in OwnChats." });
  return out;
}
